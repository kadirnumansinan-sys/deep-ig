import { NextResponse } from 'next/server';
import type { Channel } from '@/lib/content';
import { getDiscoveryPayload } from '@/app/api/discover/route';
import { gapScanWithGroq, GroqUnavailableError } from '@/lib/groq';
import { writeJobStatus } from '@/lib/database';

export const dynamic = 'force-dynamic';

const channels: Channel[] = ['news', 'media', 'international', 'history'];

function isVercelCronAuthorized(request: Request): boolean {
  const isCronRequest = request.headers.get('x-vercel-cron') === '1';
  if (!isCronRequest) return false;
  const provided = new URL(request.url).searchParams.get('token')?.trim() || '';
  const expected =
    process.env.DEEPBRIEF_CRON_TOKEN?.trim() ||
    process.env.VERCEL_POLL_TOKEN?.trim() ||
    '';
  if (!expected) return true;
  if (!provided) return false;
  const encodedProvided = new TextEncoder().encode(provided);
  const encodedExpected = new TextEncoder().encode(expected);
  if (encodedProvided.length !== encodedExpected.length) return false;
  let difference = 0;
  for (let index = 0; index < encodedProvided.length; index += 1) {
    difference |= encodedProvided[index] ^ encodedExpected[index];
  }
  return difference === 0;
}

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

async function runPoll(request: Request) {
  const expected = process.env.INTERNAL_POLL_TOKEN?.trim() || '';
  const supplied = request.headers.get('x-deepbrief-internal')?.trim() || '';
  const cronAuthorized = isVercelCronAuthorized(request);
  const hasToken = expected && supplied && (await safeTokenEqual(supplied, expected));
  if (!cronAuthorized && !hasToken) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const startedAt = Date.now();
  await writeJobStatus({ jobName: 'source-poll', status: 'running', startedAt });

  const sourceRuns: Array<{ channel: Channel; candidates: number; error?: string }> = [];
  for (const channel of channels) {
    try {
      const payload = await getDiscoveryPayload(channel, true);
      sourceRuns.push({ channel, candidates: payload.candidates.length });
    } catch (error) {
      sourceRuns.push({
        channel,
        candidates: 0,
        error: error instanceof Error ? error.message.slice(0, 160) : 'Tarama başarısız',
      });
    }
  }

  const gapRuns: Array<{ channel: Channel; candidates: number; cachedOrUsed: boolean; error?: string }> = [];
  for (const channel of channels.filter((item) => item !== 'history')) {
    try {
      const gaps = await gapScanWithGroq(channel);
      gapRuns.push({ channel, candidates: gaps.length, cachedOrUsed: true });
    } catch (error) {
      gapRuns.push({
        channel,
        candidates: 0,
        cachedOrUsed: false,
        error: error instanceof GroqUnavailableError
          ? error.message
          : 'Groq boşluk taraması geçici olarak tamamlanamadı.',
      });
    }
  }

  const ok = sourceRuns.some((run) => !run.error);
  const degraded = sourceRuns.some((run) => Boolean(run.error));
  await writeJobStatus({
    jobName: 'source-poll',
    status: ok && !degraded ? 'ok' : 'degraded',
    startedAt,
    completedAt: Date.now(),
    detail: `${sourceRuns.filter((run) => !run.error).length}/${sourceRuns.length} kanal · ${sourceRuns.reduce((sum, run) => sum + run.candidates, 0)} aday`,
  });

  return NextResponse.json({
    ok,
    ranAt: new Date().toISOString(),
    sources: sourceRuns,
    gaps: gapRuns,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  return runPoll(request);
}

export async function POST(request: Request) {
  return runPoll(request);
}
