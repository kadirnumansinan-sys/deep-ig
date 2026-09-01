import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import type { Channel, ContentCandidate } from '@/lib/content';
import { gapScanWithGroq, gapStoryId, GroqUnavailableError } from '@/lib/groq';
import { enrichIntelligence, istanbulDate } from '@/lib/news-intelligence';
import { isSafeHttpsUrl, signUrl } from '@/lib/url-signing';

export const dynamic = 'force-dynamic';

function channelFrom(value: string | null): Channel {
  if (value === 'news' || value === 'media' || value === 'international') return value;
  return 'news';
}

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const channel = channelFrom(new URL(request.url).searchParams.get('channel'));
  try {
    const stories = await gapScanWithGroq(channel);
    const raw: ContentCandidate[] = stories.map((story) => ({
      id: gapStoryId(story),
      kind: 'news',
      title: story.title,
      summary: story.summary,
      imageUrl: story.imageUrl,
      imageToken: story.imageUrl && isSafeHttpsUrl(story.imageUrl) ? signUrl(story.imageUrl, 'image') : undefined,
      sourceName: story.sourceName,
      sourceUrl: story.sourceUrl,
      sourceToken: isSafeHttpsUrl(story.sourceUrl) ? signUrl(story.sourceUrl, 'source') : undefined,
      publishedAt: story.publishedAt,
      canonicalPublishedAt: '',
      freshnessStatus: 'unverified',
      sourceType: 'ai-search',
      score: 50,
      signal: `Groq boşluk taraması · ${istanbulDate(story.publishedAt) || 'tarih kontrolü gerekli'}`,
      location: story.location ? {
        city: '', country: '', label: story.location, confidence: 0.6, method: 'groq',
      } : null,
      readinessIssues: ['Groq ile bulundu; kaynak sayfasının tarihi ve içeriği doğrulanmalı.'],
    }));
    const candidates = enrichIntelligence(raw, channel).map((candidate) => ({
      ...candidate,
      freshnessStatus: 'unverified' as const,
      score: Math.min(candidate.score, 72),
      readinessIssues: Array.from(new Set([
        ...(candidate.readinessIssues || []),
        'Groq ile bulundu; kaynak sayfasının tarihi ve içeriği doğrulanmalı.',
      ])),
    }));
    return NextResponse.json({ candidates, generatedAt: new Date().toISOString() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof GroqUnavailableError ? error.status : 502;
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Groq boşluk taraması tamamlanamadı.',
      candidates: [],
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
