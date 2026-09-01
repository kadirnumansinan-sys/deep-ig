import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import type { Channel, ContentCandidate } from '@/lib/content';
import {
  analyzeCandidatesWithGroq,
  GroqUnavailableError,
  mergeGroqAnalysis,
} from '@/lib/groq';

export const dynamic = 'force-dynamic';

const channels = new Set<Channel>(['history', 'news', 'international', 'media']);

export async function POST(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  try {
    const body = await request.json() as { channel?: Channel; candidates?: ContentCandidate[] };
    const channel = body.channel;
    const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 12) : [];
    if (!channel || !channels.has(channel)) {
      return NextResponse.json({ error: 'Geçersiz kanal.' }, { status: 400 });
    }
    if (!candidates.length) {
      return NextResponse.json({ candidates: [], analyzed: 0 }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const analyses = await analyzeCandidatesWithGroq(channel, candidates);
    return NextResponse.json({
      candidates: mergeGroqAnalysis(candidates, analyses),
      analyzed: analyses.size,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof GroqUnavailableError ? error.status : 502;
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Groq analizi tamamlanamadı.',
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
