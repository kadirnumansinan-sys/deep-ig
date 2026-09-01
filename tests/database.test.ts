import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DEEPBRIEF_DB_PATH = ':memory:';

test('sağlayıcı kotası kalıcı ve atomik güvenlik sınırını aşmaz', async () => {
  const { getProviderUsage, reserveProviderRequest } = await import('../lib/database');
  const date = '2099-01-01';
  const first = await reserveProviderRequest('groq', 'analysis', date, 2);
  const second = await reserveProviderRequest('groq', 'analysis', date, 2);
  const third = await reserveProviderRequest('groq', 'analysis', date, 2);
  const usage = await getProviderUsage('groq', 'analysis', date);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(usage.requests, 2);
  assert.equal(first.durable, true);
});

test('sağlayıcı yanıt önbelleği süresi dolmadan geri okunur', async () => {
  const { readProviderCache, writeProviderCache } = await import('../lib/database');
  await writeProviderCache('test-cache', 'groq', 'analysis', 'test-model', { value: 7 }, 60_000);
  assert.deepEqual(await readProviderCache('test-cache'), { value: 7 });
});
