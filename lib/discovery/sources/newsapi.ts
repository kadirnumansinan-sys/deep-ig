import type { Channel, ContentCandidate } from '@/lib/content';
import { stripSourceAttribution } from '@/lib/copy-guard';
import { isLanguageMatch, type PublicationLanguage } from '@/lib/language';
import { istanbulDate, istanbulNowDate } from '@/lib/news-intelligence';
import { isSafeHttpsUrl } from '@/lib/url-signing';
import { asArray, stableId } from '../feed';

export type NewsApiArticle = {
  source?: { name?: string };
  title?: string;
  description?: string;
  url?: string;
  urlToImage?: string;
  publishedAt?: string;
};

export async function getNewsApi(channel: Exclude<Channel, 'history'>): Promise<ContentCandidate[]> {
  const apiKey = process.env.NEWSAPI_KEY?.trim();
  if (!apiKey) return [];
  const today = istanbulNowDate();
  const params = new URLSearchParams({ pageSize: '100' });
  let endpoint = 'https://newsapi.org/v2/top-headlines';
  if (channel !== 'international') {
    params.set('country', 'tr');
  } else {
    endpoint = 'https://newsapi.org/v2/everything';
    params.set('q', '(world OR global OR international)');
    params.set('language', 'en');
    params.set('from', today);
    params.set('to', today);
    params.set('sortBy', 'popularity');
  }
  const response = await fetch(`${endpoint}?${params}`, {
    headers: { 'X-Api-Key': apiKey, 'User-Agent': 'DeepbriefContentStudio/2.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { articles?: NewsApiArticle[] };
  const language: PublicationLanguage = channel === 'international' ? 'en' : 'tr';
  return asArray(data.articles)
    .filter((article) => article.publishedAt && istanbulDate(article.publishedAt) === today)
    .flatMap((article, index) => {
      const sourceName = article.source?.name?.trim() || 'NewsAPI';
      const title = stripSourceAttribution(article.title?.trim() || '', sourceName);
      const summary = stripSourceAttribution(article.description?.trim() || title, sourceName) || title;
      const sourceUrl = article.url?.trim() || '';
      if (!title || !isSafeHttpsUrl(sourceUrl) || !isLanguageMatch(`${title} ${summary}`, language, sourceName)) return [];
      return [{
        id: stableId(`newsapi-${language}`, sourceUrl),
        kind: 'news' as const,
        title,
        summary,
        imageUrl: isSafeHttpsUrl(article.urlToImage || '') ? article.urlToImage || '' : '',
        sourceName,
        sourceUrl,
        publishedAt: article.publishedAt || '',
        canonicalPublishedAt: article.publishedAt || '',
        freshnessStatus: 'today' as const,
        sourceType: 'publisher' as const,
        score: Math.max(58, 84 - Math.floor(index / 3)),
        signal: 'NewsAPI · bugün',
      }];
    });
}
