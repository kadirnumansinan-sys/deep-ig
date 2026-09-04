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

// Wikimedia On This Day API dört tür sunuyor; her biri ayrı JSON anahtarı altında döner
// (ör. /births -> { births: [...] }) ama öğe şekli (text/year/pages) aynı.
// Bkz. https://api.wikimedia.org/wiki/Feed_API/Reference/On_this_day
const historyTypes: Array<{ type: string; label: string; signalSuffix: string; maxItems: number }> = [
  { type: 'events', label: 'Vikipedi · Tarihte bugün', signalSuffix: 'yılında', maxItems: 40 },
  { type: 'births', label: 'Vikipedi · Bugün doğanlar', signalSuffix: 'yılında doğdu', maxItems: 15 },
  { type: 'deaths', label: 'Vikipedi · Bugün kaybettiklerimiz', signalSuffix: 'yılında hayatını kaybetti', maxItems: 15 },
  { type: 'holidays', label: 'Vikipedi · Bugünün önemi', signalSuffix: 'için önemli bir gün', maxItems: 10 },
];

async function fetchHistoryType(
  month: string,
  day: string,
  type: string,
): Promise<WikimediaEvent[]> {
  const response = await fetch(
    `https://api.wikimedia.org/feed/v1/wikipedia/tr/onthisday/${type}/${month}/${day}`,
    {
      headers: { 'User-Agent': 'DeepbriefContentStudio/2.0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as Record<string, WikimediaEvent[] | undefined>;
  return asArray(data[type] ?? data.events);
}

export async function getHistory(month: string, day: string): Promise<ContentCandidate[]> {
  const results = await Promise.allSettled(
    historyTypes.map((entry) => fetchHistoryType(month, day, entry.type)),
  );
  const errors: string[] = [];
  const candidates = results.flatMap((result, typeIndex) => {
    const { type, label, signalSuffix, maxItems } = historyTypes[typeIndex];
    if (result.status === 'rejected') {
      errors.push(`${type}: ${(result.reason as Error)?.message || 'hata'}`);
      return [];
    }
    return result.value.slice(0, maxItems).map((event, index): ContentCandidate | null => {
      const page = event.pages?.find((item) => item.originalimage?.source || item.thumbnail?.source) ?? event.pages?.[0];
      const body = event.text?.trim() || page?.extract?.trim() || '';
      if (!body) return null;
      const year = event.year ? String(event.year) : '';
      const pageTitle = page?.title?.replace(/_/g, ' ') || '';
      return {
        id: `history-${type}-${year}-${index}`,
        kind: 'history',
        title: pageTitle ? `${year} · ${pageTitle}` : `${year} · Tarihte bugün`,
        summary: body,
        imageUrl: page?.originalimage?.source || page?.thumbnail?.source || '',
        sourceName: label,
        sourceUrl: page?.content_urls?.desktop?.page || 'https://tr.wikipedia.org/',
        publishedAt: new Date().toISOString(),
        canonicalPublishedAt: new Date().toISOString(),
        freshnessStatus: 'today',
        sourceType: 'encyclopedia',
        score: Math.max(50, Math.min(98, 92 - index + (page?.originalimage?.source ? 7 : 0))),
        signal: year ? `${year} ${signalSuffix}` : 'Tarihte bugün',
      };
    }).filter((item): item is ContentCandidate => Boolean(item));
  });
  if (!candidates.length && errors.length) throw new Error(errors.join('; '));
  return candidates.slice(0, 80);
}
