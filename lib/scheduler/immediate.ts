import { resolveAccount } from '@/lib/instagram/accounts';
import {
  createReelContainer,
  getContainerStatus,
  getPermalink,
  publishContainer,
} from '@/lib/instagram/client';
import { claimScheduledPost, markPost, type ScheduledPost } from '@/lib/scheduler/store';

// "Şimdi paylaş" akışı. Cron'un iki fazlı akışının aynısını tek istek içinde yürütür; süre
// yetmezse satırı `processing` bırakır ve yayını cron tamamlar. Aynı satır iki kez yayınlanamaz:
// claim atomiktir ve konteyner kimliği bir kez yazılır.

export type ImmediateStatus = 'published' | 'processing' | 'failed';

export type ImmediateResult = {
  status: ImmediateStatus;
  permalink: string | null;
  error: string | null;
};

const POLL_INTERVAL_MS = 4_000;
// Serverless çağrısı 60 saniyede kesiliyor; konteyner oluşturma ve yayınlama için pay bırakılır.
const DEFAULT_BUDGET_MS = 36_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 400);
}

export async function publishImmediately(
  post: ScheduledPost,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<ImmediateResult> {
  const deadline = Date.now() + budgetMs;
  const claimed = await claimScheduledPost(post.id);
  // Satırı bu arada cron aldıysa yayını o sürdürür; ikinci bir konteyner oluşturmayız.
  if (!claimed) return { status: 'processing', permalink: null, error: null };

  let containerId: string | null = null;
  try {
    const account = await resolveAccount(post.channel);
    containerId = await createReelContainer({
      account,
      videoUrl: post.videoUrl,
      coverUrl: post.coverUrl,
      caption: post.caption,
    });
    await markPost(post.id, {
      status: 'processing',
      containerId,
      containerAt: new Date(),
      lastError: null,
    });

    while (Date.now() < deadline) {
      const { statusCode, detail } = await getContainerStatus({ account, containerId });
      if (statusCode === 'FINISHED') {
        const mediaId = await publishContainer({ account, containerId });
        const permalink = await getPermalink({ account, mediaId });
        await markPost(post.id, { status: 'published', mediaId, permalink, lastError: null });
        return { status: 'published', permalink, error: null };
      }
      if (statusCode === 'PUBLISHED') {
        await markPost(post.id, { status: 'published', lastError: null });
        return { status: 'published', permalink: null, error: null };
      }
      if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
        const message = `Instagram videoyu işleyemedi (${statusCode})${detail ? `: ${detail}` : ''}.`;
        await markPost(post.id, { status: 'failed', lastError: message });
        return { status: 'failed', permalink: null, error: message };
      }
      if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
      await sleep(POLL_INTERVAL_MS);
    }

    // Instagram hâlâ işliyor: satır `processing` kalır, cron bir sonraki turda yayınlar.
    return { status: 'processing', permalink: null, error: null };
  } catch (error) {
    const message = describe(error);
    // Konteyner oluştuysa cron durumu sormaya devam etsin; oluşmadıysa satır tekrar kuyruğa girer.
    await markPost(post.id, {
      status: containerId ? 'processing' : 'scheduled',
      lastError: message,
    });
    return { status: 'processing', permalink: null, error: message };
  }
}
