import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import type { Channel } from '@/lib/content';
import { isAccountConfigured } from '@/lib/instagram/accounts';
import { publishImmediately } from '@/lib/scheduler/immediate';
import {
  cancelPost,
  insertPost,
  isSchedulerConfigured,
  listPosts,
  SchedulerConfigError,
  type ScheduledPost,
} from '@/lib/scheduler/store';

export const dynamic = 'force-dynamic';
// "Şimdi paylaş" isteği Instagram konteynerinin hazır olmasını bekler; Hobby planındaki üst sınır.
export const maxDuration = 60;

const channels: Channel[] = ['history', 'news', 'international', 'media'];
const channelSet = new Set<Channel>(channels);

// Yalnızca kendi Blob depomuzdaki medya sıraya alınabilir; keyfi bir URL Instagram'a gönderilmez.
const BLOB_HOST_SUFFIX = '.blob.vercel-storage.com';
const MAX_CAPTION = 2_200;
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function ok(payload: unknown) {
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}

function blobUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} adresi eksik.`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} adresi geçersiz.`);
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith(BLOB_HOST_SUFFIX)) {
    throw new Error(`${label} adresi Vercel Blob deposunda değil.`);
  }
  return url.toString();
}

function serialize(post: ScheduledPost) {
  return {
    id: post.id,
    channel: post.channel,
    caption: post.caption,
    videoUrl: post.videoUrl,
    coverUrl: post.coverUrl,
    scheduledAt: post.scheduledAt.toISOString(),
    status: post.status,
    mediaId: post.mediaId,
    permalink: post.permalink,
    attempts: post.attempts,
    lastError: post.lastError,
    createdAt: post.createdAt.toISOString(),
  };
}

function accountStatus() {
  return Object.fromEntries(
    channels.map((channel) => [channel, isAccountConfigured(channel)]),
  ) as Record<Channel, boolean>;
}

function failure(error: unknown) {
  if (error instanceof SchedulerConfigError) return jsonError(error.message, 503);
  return jsonError(error instanceof Error ? error.message : 'Beklenmeyen hata.', 500);
}

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;

  const configured = isSchedulerConfigured();
  if (!configured) {
    return ok({
      configured: false,
      blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()),
      accounts: accountStatus(),
      posts: [],
    });
  }

  try {
    const posts = await listPosts(50);
    return ok({
      configured: true,
      blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()),
      accounts: accountStatus(),
      posts: posts.map(serialize),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;

  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError('Geçersiz istek.', 400);
  }

  const channel = typeof input.channel === 'string' ? (input.channel as Channel) : null;
  if (!channel || !channelSet.has(channel)) return jsonError('Geçersiz yayın kanalı.', 400);
  if (!isAccountConfigured(channel)) {
    return jsonError(
      `${channel} kanalı için Instagram hesabı tanımlı değil. IG_${channel.toUpperCase()}_USER_ID ve IG_${channel.toUpperCase()}_TOKEN ekleyin.`,
      400,
    );
  }

  let videoUrl: string;
  let coverUrl: string;
  try {
    videoUrl = blobUrl(input.videoUrl, 'Video');
    coverUrl = input.coverUrl ? blobUrl(input.coverUrl, 'Kapak') : '';
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Medya adresi geçersiz.', 400);
  }

  // `publishNow` ile saat sorulmaz: kayıt şimdiki zamana yazılır ve yayın aynı istekte başlatılır.
  const publishNow = input.publishNow === true;
  const scheduledAt = publishNow
    ? new Date()
    : new Date(typeof input.scheduledAt === 'string' ? input.scheduledAt : '');
  if (!publishNow) {
    if (Number.isNaN(scheduledAt.getTime())) return jsonError('Yayın saati geçersiz.', 400);
    const now = Date.now();
    // Bir dakikalık tolerans: kullanıcı "şimdi" seçtiğinde istek yolda saniyeler kaybediyor.
    if (scheduledAt.getTime() < now - 60_000) return jsonError('Yayın saati geçmişte olamaz.', 400);
    if (scheduledAt.getTime() > now + MAX_SCHEDULE_AHEAD_MS) {
      return jsonError('Yayın saati en fazla 90 gün sonrası olabilir.', 400);
    }
  }

  const caption = (typeof input.caption === 'string' ? input.caption : '').trim().slice(0, MAX_CAPTION);
  const audioName = typeof input.audioName === 'string' ? input.audioName.trim().slice(0, 75) : '';
  const trialReel = input.trialReel !== false;

  try {
    const post = await insertPost({
      id: crypto.randomUUID(),
      channel,
      caption,
      videoUrl,
      coverUrl,
      audioName,
      trialReel,
      scheduledAt,
    });
    if (!publishNow) return ok({ post: serialize(post) });
    const publish = await publishImmediately(post);
    return ok({ post: { ...serialize(post), status: publish.status }, publish });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get('id')?.trim() || '';
  if (!id) return jsonError('Kayıt kimliği gerekli.', 400);

  try {
    const post = await cancelPost(id);
    if (!post) return jsonError('Bu kayıt iptal edilemez (bulunamadı veya çoktan işleniyor).', 409);
    return ok({ post: serialize(post) });
  } catch (error) {
    return failure(error);
  }
}
