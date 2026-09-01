import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import type { Channel } from '@/lib/content';
import { limitedText } from '@/lib/copywriter';
import { GroqUnavailableError, locateWithGroq } from '@/lib/groq';

export const dynamic = 'force-dynamic';

const channels = new Set<Channel>(['history', 'news', 'international', 'media']);

export async function POST(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  try {
    const input = await request.json() as Record<string, unknown>;
    const channel = limitedText(input.channel, 32) as Channel;
    const title = limitedText(input.title, 300);
    const body = limitedText(input.body, 2_000);
    const sourceName = limitedText(input.sourceName, 160);
    if (!channels.has(channel)) {
      return NextResponse.json({ error: 'Geçersiz kanal.' }, { status: 400 });
    }
    if (!title) {
      return NextResponse.json({ error: 'Konum bulmak için başlık gerekli.' }, { status: 400 });
    }
    const result = await locateWithGroq({ channel, title, body, sourceName });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Geçersiz istek.' }, { status: 400 });
    }
    const status = error instanceof GroqUnavailableError ? error.status : 502;
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Konum bulunamadı.',
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
