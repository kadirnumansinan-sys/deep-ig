import assert from 'node:assert/strict';
import test from 'node:test';
import { POST } from '@/app/api/schedule/route';
import { InstagramConfigError, envAccount, resolveAccount } from '@/lib/instagram/accounts';
import { INSTAGRAM_HOST, FACEBOOK_HOST } from '@/lib/instagram/client';
import { decide, MAX_ATTEMPTS, shouldRefreshToken } from '@/lib/scheduler/machine';

// Testler ağa çıkmaz: kuyruk yapılandırması kapalı, kimlik doğrulama devre dışı.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL_UNPOOLED;
process.env.AUTH_REQUIRED = 'false';
process.env.IG_NEWS_USER_ID = '17841400000000000';
process.env.IG_NEWS_TOKEN = 'test-token';
delete process.env.IG_NEWS_HOST;
delete process.env.IG_MEDIA_USER_ID;
delete process.env.IG_MEDIA_TOKEN;

const now = new Date('2026-09-02T10:00:00.000Z');

function row(patch: Partial<Parameters<typeof decide>[0]> = {}) {
  return { attempts: 1, containerId: 'container-1', containerAt: now, ...patch };
}

test('konteyner işlenirken beklenir', () => {
  assert.equal(decide(row(), 'IN_PROGRESS', now).next, 'wait');
});

test('durum okunamadığında da beklenir', () => {
  assert.equal(decide(row(), null, now).next, 'wait');
});

test('konteyner hazır olduğunda yayınlanır', () => {
  assert.equal(decide(row(), 'FINISHED', now).next, 'publish');
});

test('zaten yayınlanmış konteyner tekrar yayınlanmaz', () => {
  assert.equal(decide(row(), 'PUBLISHED', now).next, 'done');
});

test('Instagram hatası ve süre dolması başarısızlık sayılır', () => {
  assert.equal(decide(row(), 'ERROR', now).next, 'fail');
  assert.equal(decide(row(), 'EXPIRED', now).next, 'fail');
});

test('konteyner yoksa önce oluşturulur', () => {
  assert.equal(decide(row({ containerId: null }), null, now).next, 'create');
});

test('deneme sınırı aşılınca başarısız olur', () => {
  const decision = decide(row({ attempts: MAX_ATTEMPTS + 1 }), 'FINISHED', now);
  assert.equal(decision.next, 'fail');
  assert.match(decision.reason, /Deneme sınırı/);
});

test('24 saatten eski konteyner başarısız sayılır', () => {
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000);
  assert.equal(decide(row({ containerAt: stale }), 'FINISHED', now).next, 'fail');
});

test('token yenileme penceresi yalnızca bitiş tarihi bilinirken çalışır', () => {
  assert.equal(shouldRefreshToken(null, now), false);
  assert.equal(shouldRefreshToken(new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000), now), true);
  assert.equal(shouldRefreshToken(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), now), false);
});

test('env eksikken hesap çözümlemesi anlamlı hata verir', async () => {
  await assert.rejects(
    () => resolveAccount('media'),
    (error: unknown) => {
      assert.ok(error instanceof InstagramConfigError);
      assert.equal(error.channel, 'media');
      assert.match(error.message, /IG_MEDIA_USER_ID/);
      return true;
    },
  );
});

test('host varsayılanı graph.instagram.com', async () => {
  const account = await resolveAccount('news');
  assert.equal(account.host, INSTAGRAM_HOST);
  assert.equal(account.igUserId, '17841400000000000');
});

test('Facebook host açıkça seçilebilir, geçersiz host reddedilir', () => {
  process.env.IG_NEWS_HOST = 'https://graph.facebook.com/';
  assert.equal(envAccount('news')?.host, FACEBOOK_HOST);
  process.env.IG_NEWS_HOST = 'graph.example.com';
  assert.throws(() => envAccount('news'), /Desteklenmeyen Instagram host/);
  delete process.env.IG_NEWS_HOST;
});

const blobVideo = 'https://store123.public.blob.vercel-storage.com/deepbrief/test.mp4';
const blobCover = 'https://store123.public.blob.vercel-storage.com/deepbrief/test.jpg';

async function schedule(body: Record<string, unknown>) {
  const response = await POST(
    new Request('https://deepbrief.test/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, payload: (await response.json()) as { error?: string } };
}

test('geçersiz kanal reddedilir', async () => {
  const { status, payload } = await schedule({
    channel: 'sports',
    videoUrl: blobVideo,
    coverUrl: blobCover,
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(status, 400);
  assert.match(payload.error || '', /kanal/i);
});

test('yapılandırılmamış kanal reddedilir', async () => {
  const { status, payload } = await schedule({
    channel: 'media',
    videoUrl: blobVideo,
    coverUrl: blobCover,
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(status, 400);
  assert.match(payload.error || '', /IG_MEDIA_TOKEN/);
});

test('Blob dışındaki medya adresi reddedilir', async () => {
  const { status, payload } = await schedule({
    channel: 'news',
    videoUrl: 'https://example.com/kotu.mp4',
    coverUrl: blobCover,
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(status, 400);
  assert.match(payload.error || '', /Vercel Blob/);
});

test('geçmiş yayın saati reddedilir', async () => {
  const { status, payload } = await schedule({
    channel: 'news',
    videoUrl: blobVideo,
    coverUrl: blobCover,
    scheduledAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  assert.equal(status, 400);
  assert.match(payload.error || '', /geçmişte/);
});

test('90 günden uzak yayın saati reddedilir', async () => {
  const { status } = await schedule({
    channel: 'news',
    videoUrl: blobVideo,
    coverUrl: blobCover,
    scheduledAt: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(status, 400);
});

test('geçerli istek kuyruk yapılandırması yokken 503 döner', async () => {
  const { status, payload } = await schedule({
    channel: 'news',
    caption: 'Test',
    videoUrl: blobVideo,
    coverUrl: blobCover,
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(status, 503);
  assert.match(payload.error || '', /DATABASE_URL/);
});

test('şimdi paylaş saat istemez', async () => {
  const { status, payload } = await schedule({
    channel: 'news',
    caption: 'Test',
    videoUrl: blobVideo,
    coverUrl: blobCover,
    publishNow: true,
  });
  // Saat doğrulaması atlanır; istek yalnızca kuyruk yapılandırması yok diye durur.
  assert.equal(status, 503);
  assert.doesNotMatch(payload.error || '', /Yayın saati/);
});

test('şimdi paylaş geçmiş saati de görmezden gelir', async () => {
  const { status } = await schedule({
    channel: 'news',
    videoUrl: blobVideo,
    coverUrl: blobCover,
    publishNow: true,
    scheduledAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  assert.equal(status, 503);
});

test('şimdi paylaş medya doğrulamasını atlamaz', async () => {
  const { status, payload } = await schedule({
    channel: 'news',
    videoUrl: 'https://example.com/kotu.mp4',
    coverUrl: blobCover,
    publishNow: true,
  });
  assert.equal(status, 400);
  assert.match(payload.error || '', /Vercel Blob/);
});
