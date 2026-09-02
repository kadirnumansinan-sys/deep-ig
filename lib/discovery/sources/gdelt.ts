import type { Channel, ContentCandidate } from '@/lib/content';
import { stripSourceAttribution } from '@/lib/copy-guard';
import { isLanguageMatch, type PublicationLanguage } from '@/lib/language';
import { isSafeHttpsUrl } from '@/lib/url-signing';
import { GDELT_MAX_RECORDS } from '../config';
import { asArray, isTodayish, stableId } from '../feed';

export type GdeltArticle = {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  socialimage?: string;
  domain?: string;
};

export async function getGdelt(channel: Exclude<Channel, 'history'>): Promise<ContentCandidate[]> {
  const query = channel === 'international'
    ? 'sourcelang:english'
    : 'sourcecountry:turkey sourcelang:turkish';
  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    maxrecords: String(GDELT_MAX_RECORDS),
    timespan: '24h',
    sort: channel === 'international' ? 'hybridrel' : 'datedesc',
    format: 'json',
  });
  const response = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
    headers: { 'User-Agent': 'DeepbriefContentStudio/2.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { articles?: GdeltArticle[] };
  const language: PublicationLanguage = channel === 'international' ? 'en' : 'tr';
  return asArray(data.articles)
    .filter((article) => isTodayish(article.seendate || ''))
    .flatMap((article, index) => {
      const sourceUrl = article.url || article.url_mobile || '';
      const sourceName = article.domain?.trim() || 'GDELT';
      const title = stripSourceAttribution(article.title?.trim() || '', sourceName);
      if (!title || !isSafeHttpsUrl(sourceUrl) || !isLanguageMatch(title, language, sourceName)) return [];
      return [{
        id: stableId(`gdelt-${language}`, sourceUrl),
        kind: 'news' as const,
        title,
        summary: title,
        imageUrl: isSafeHttpsUrl(article.socialimage || '') ? article.socialimage || '' : '',
        sourceName,
        sourceUrl,
        publishedAt: article.seendate || '',
        canonicalPublishedAt: '',
        freshnessStatus: 'unverified' as const,
        sourceType: 'aggregator' as const,
        score: Math.max(50, 78 - Math.floor(index / 5)),
        signal: 'GDELT · kaynak tarihi kontrol edilecek',
      }];
    });
}
