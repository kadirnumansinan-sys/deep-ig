import { NextResponse } from 'next/server';
import { databaseHealth, readJobStatus } from '@/lib/database';
import { groqStatusWithDurableUsage } from '@/lib/groq';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [database, groq, scheduler] = await Promise.all([
    databaseHealth(),
    groqStatusWithDurableUsage(),
    readJobStatus('source-poll'),
  ]);
  const degraded = database.configured && !database.available;
  return NextResponse.json({
    status: degraded ? 'degraded' : 'ok',
    service: 'deepbrief-content-studio',
    time: new Date().toISOString(),
    database: {
      configured: database.configured,
      available: database.available,
      engine: database.engine,
      error: database.error,
    },
    groq: {
      configured: groq.configured,
      keyCount: groq.keyCount,
      usage: groq.usage,
    },
    scheduler: scheduler ? {
      status: scheduler.status,
      lastStartedAt: scheduler.lastStartedAt,
      lastCompletedAt: scheduler.lastCompletedAt,
      detail: scheduler.detail,
    } : { status: 'starting', lastStartedAt: null, lastCompletedAt: null, detail: '' },
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
