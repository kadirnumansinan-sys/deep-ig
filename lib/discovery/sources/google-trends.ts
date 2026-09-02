import type { ContentCandidate } from '@/lib/content';
import { stripSourceAttribution } from '@/lib/copy-guard';
import { isLanguageMatch, type PublicationLanguage } from '@/lib/language';
import { asArray, fetchXml, isTodayish, stableId, text, trafficToScore } from '../feed';

export type TrendItem = {
  title?: unknown;
  pubDate?: unknown;
  'ht:approx_traffic'?: unknown;
  'ht:picture'?: unknown;
  'ht:picture_source'?: unknown;
  'ht:news_item'?: unknown;
};

export type TrendNewsItem = {
  'ht:news_item_title'?: unknown;
  'ht:news_item_snippet'?: unknown;
  'ht:news_item_url'?: unknown;
  'ht:news_item_picture'?: unknown;
  'ht:news_item_source'?: unknown;
};

export function trendLeadScore(article: TrendNewsItem): number {
  const sourceName = text(article['ht:news_item_source']);
  const title = text(article['ht:news_item_title']);
  const snippet = text(article['ht:news_item_snippet']);
  const sourceUrl = text(article['ht:news_item_url']);
  let score = 0;
  if (snippet.split(/\s+/u).filter(Boolean).length >= 14) score += 12;
  if (stripSourceAttribution(title, sourceName) === title) score += 5;
  if (/\.gov\.tr(?:\/|$)/iu.test(sourceUrl) || /\b(trt|aa)\b/iu.test(sourceName)) score += 7;
  return score;
}

export async function getTrends(language: PublicationLanguage): Promise<ContentCandidate[]> {
  const data = await fetchXml('https://trends.google.com/trending/rss?geo=TR');
  const rss = data.rss as { channel?: { item?: TrendItem | TrendItem[] } } | undefined;
  return asArray(rss?.channel?.item)
    .filter((item) => isTodayish(text(item.pubDate)))
    .flatMap((item, index) => {
      const related = asArray(item['ht:news_item'] as TrendNewsItem | TrendNewsItem[] | undefined);
      const lead = related
        .filter((article) => isLanguageMatch(
          `${text(article['ht:news_item_title'])} ${text(article['ht:news_item_snippet'])}`,
          language,
          text(article['ht:news_item_source']),
        ))
        .sort((left, right) => trendLeadScore(right) - trendLeadScore(left))[0];
      if (!lead) return [];
      const query = text(item.title);
      const sourceName = text(lead['ht:news_item_source']) || text(item['ht:picture_source']) || 'Google Trends';
      const headline = stripSourceAttribution(text(lead['ht:news_item_title']) || query, sourceName) || query;
      const summary = stripSourceAttribution(text(lead['ht:news_item_snippet']) || headline, sourceName) || headline;
      const sourceUrl = text(lead['ht:news_item_url']);
      if (!headline || !sourceUrl) return [];
      const traffic = text(item['ht:approx_traffic']) || 'Yükseliyor';
      return [{
        id: stableId(`trend-${language}`, `${query}:${sourceUrl}`),
        kind: 'trend' as const,
        title: headline,
        summary,
        imageUrl: text(lead['ht:news_item_picture']) || text(item['ht:picture']),
        sourceName,
        sourceUrl,
        publishedAt: text(item.pubDate),
        canonicalPublishedAt: '',
        freshnessStatus: 'unverified' as const,
        sourceType: 'trend' as const,
        score: trafficToScore(traffic, index),
        signal: `${traffic} Google Trends`,
      }];
    });
}
