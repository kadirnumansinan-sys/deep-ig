import type { ContentCandidate } from '@/lib/content';
import { asArray } from '../feed';

export type WikimediaPage = {
  title?: string;
  extract?: string;
  thumbnail?: { source?: string };
  originalimage?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
};
export type WikimediaEvent = { text?: string; year?: number; pages?: WikimediaPage[] };

export async function getHistory(month: string, day: string): Promise<ContentCandidate[]> {
  const response = await fetch(
    `https://api.wikimedia.org/feed/v1/wikipedia/tr/onthisday/events/${month}/${day}`,
    {
      headers: { 'User-Agent': 'DeepbriefContentStudio/2.0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { events?: WikimediaEvent[] };
  return asArray(data.events).map((event, index): ContentCandidate | null => {
    const page = event.pages?.find((item) => item.originalimage?.source || item.thumbnail?.source) ?? event.pages?.[0];
    const body = event.text?.trim() || page?.extract?.trim() || '';
    if (!body) return null;
    const year = event.year ? String(event.year) : '';
    const pageTitle = page?.title?.replace(/_/g, ' ') || '';
    return {
      id: `history-${year}-${index}`,
      kind: 'history',
      title: pageTitle ? `${year} · ${pageTitle}` : `${year} · Tarihte bugün`,
      summary: body,
      imageUrl: page?.originalimage?.source || page?.thumbnail?.source || '',
      sourceName: 'Vikipedi · Tarihte bugün',
      sourceUrl: page?.content_urls?.desktop?.page || 'https://tr.wikipedia.org/',
      publishedAt: new Date().toISOString(),
      canonicalPublishedAt: new Date().toISOString(),
      freshnessStatus: 'today',
      sourceType: 'encyclopedia',
      score: Math.max(50, Math.min(98, 92 - index + (page?.originalimage?.source ? 7 : 0))),
      signal: year ? `${year} yılında` : 'Tarihte bugün',
    };
  }).filter((item): item is ContentCandidate => Boolean(item)).slice(0, 40);
}
