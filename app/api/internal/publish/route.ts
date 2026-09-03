import { NextResponse } from 'next/server';
import type { Channel } from '@/lib/content';
import {
  isAccountConfigured,
  persistAccount,
  resolveAccount,
} from '@/lib/instagram/accounts';
import {
  createReelContainer,
  getContainerStatus,
  getPermalink,
  INSTAGRAM_HOST,
  publishContainer,
  refreshAccessToken,
  type ContainerStatusCode,
} from '@/lib/instagram/client';
import { decide, MAX_ATTEMPTS, shouldRefreshToken } from '@/lib/scheduler/machine';
import {
  claimDuePosts,
  claimProcessingPosts,
  ensureSchema,
  isSchedulerConfigured,
  markPost,
  SchedulerConfigError,
  type ScheduledPost,
} from '@/lib/scheduler/store';

export const dynamic = 'force-dynamic';

const channels: Channel[] = ['news', 'media', 'international', 'history'];
const ASSUMED_TOKEN_LIFETIME_MS = 55 * 24 * 60 * 60 * 1000;

async function safeTokenEqual(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

// Hobby planında Vercel cron günde bir kez çalışır; 5 dakikalık tetikleme harici bir servisten
// gelir. Bu yüzden token hem `?token=` hem de `x-deepbrief-internal` başlığından kabul edilir.
async function isPublishAuthorized(request: Request): Promise<boolean> {
  const expected =
    process.env.DEEPBRIEF_CRON_TOKEN?.trim() ||
    process.env.INTERNAL_POLL_TOKEN?.trim() ||
    '';
  const supplied =
    new URL(request.url).searchParams.get('token')?.trim() ||
    request.headers.get('x-deepbrief-internal')?.trim() ||
    '';
  if (!expected) return request.headers.get('x-vercel-cron') === '1';
  return await safeTokenEqual(supplied, expected);
}

function shortError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 400);
  return 'Bilinmeyen hata';
}

// Instagram Login token'ı 60 gün geçerli. Env'den gelen token'ın son kullanma tarihi bilinmediği
// için ilk turda bir yenileme denenir; başarılıysa gerçek süre, değilse temkinli bir tahmin yazılır.
async function maintainTokens(now: Date): Promise<string[]> {
  const notes: string[] = [];
  for (const channel of channels) {
    if (!isAccountConfigured(channel)) continue;
    try {
      const account = await resolveAccount(channel);
      if (account.host !== INSTAGRAM_HOST) continue;
      if (account.tokenExpiresAt && !shouldRefreshToken(account.tokenExpiresAt, now)) continue;
      let refreshed: { accessToken: string; expiresAt: Date } | null = null;
      try {
        refreshed = await refreshAccessToken(account);
      } catch (error) {
        notes.push(`${channel}: token yenilenemedi (${shortError(error)})`);
      }
      // Yenileme başarısız olsa bile tahmini bir son kullanma tarihi yazılır; aksi halde her
      // tetiklemede (5 dakikada bir) boşuna Graph çağrısı yapılırdı.
      await persistAccount({
        ...account,
        accessToken: refreshed?.accessToken || account.accessToken,
        tokenExpiresAt:
          refreshed?.expiresAt ?? new Date(now.getTime() + ASSUMED_TOKEN_LIFETIME_MS),
      });
      if (refreshed) notes.push(`${channel}: token yenilendi`);
    } catch (error) {
      notes.push(`${channel}: hesap çözümlenemedi (${shortError(error)})`);
    }
  }
  return notes;
}

async function recordFailure(post: ScheduledPost, message: string): Promise<'failed' | 'retry'> {
  if (post.attempts >= MAX_ATTEMPTS) {
    await markPost(post.id, { status: 'failed', lastError: message });
    return 'failed';
  }
  // Tekrar denenebilir: satır tekrar sıraya alınır, bir sonraki tetiklemede yeniden claim edilir.
  await markPost(post.id, {
    status: post.containerId ? 'processing' : 'scheduled',
    lastError: message,
  });
  return 'retry';
}

type Summary = {
  created: number;
  published: number;
  waiting: number;
  failed: number;
  notes: string[];
};

async function runPublish(request: Request) {
  if (!(await isPublishAuthorized(request))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!isSchedulerConfigured()) {
    return NextResponse.json(
      { error: 'Yayın kuyruğu için Postgres bağlantısı yok. DATABASE_URL tanımlayın.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const now = new Date();
  const summary: Summary = { created: 0, published: 0, waiting: 0, failed: 0, notes: [] };

  try {
    await ensureSchema();
    summary.notes.push(...(await maintainTokens(now)));

    // 1. faz: zamanı gelmiş kayıtlar için Reels konteyneri oluştur.
    for (const post of await claimDuePosts(now, 4)) {
      try {
        const account = await resolveAccount(post.channel);
        const containerId = await createReelContainer({
          account,
          videoUrl: post.videoUrl,
          coverUrl: post.coverUrl,
          caption: post.caption,
          audioName: post.audioName,
          trialReel: post.trialReel,
        });
        await markPost(post.id, {
          status: 'processing',
          containerId,
          containerAt: now,
          lastError: null,
        });
        summary.created += 1;
      } catch (error) {
        const outcome = await recordFailure(post, shortError(error));
        if (outcome === 'failed') summary.failed += 1;
        else summary.waiting += 1;
      }
    }

    // 2. faz: işlenmekte olan konteynerlerin durumunu sor, hazır olanları yayınla.
    for (const post of await claimProcessingPosts(now, 8)) {
      try {
        const account = await resolveAccount(post.channel);
        let statusCode: ContainerStatusCode | null = null;
        if (post.containerId) {
          statusCode = (await getContainerStatus({ account, containerId: post.containerId })).statusCode;
        }
        const decision = decide(post, statusCode, now);

        if (decision.next === 'publish' && post.containerId) {
          const mediaId = await publishContainer({ account, containerId: post.containerId });
          const permalink = await getPermalink({ account, mediaId });
          await markPost(post.id, {
            status: 'published',
            mediaId,
            permalink,
            lastError: null,
          });
          summary.published += 1;
        } else if (decision.next === 'done') {
          await markPost(post.id, { status: 'published', lastError: null });
          summary.published += 1;
        } else if (decision.next === 'fail') {
          await markPost(post.id, { status: 'failed', lastError: decision.reason });
          summary.failed += 1;
        } else if (decision.next === 'create') {
          await markPost(post.id, { status: 'scheduled' });
          summary.waiting += 1;
        } else {
          await markPost(post.id, { status: 'processing' });
          summary.waiting += 1;
        }
      } catch (error) {
        const outcome = await recordFailure(post, shortError(error));
        if (outcome === 'failed') summary.failed += 1;
        else summary.waiting += 1;
      }
    }
  } catch (error) {
    const status = error instanceof SchedulerConfigError ? 503 : 500;
    return NextResponse.json(
      { error: shortError(error), ...summary },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { ok: true, ranAt: now.toISOString(), ...summary },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function GET(request: Request) {
  return runPublish(request);
}

export async function POST(request: Request) {
  return runPublish(request);
}
