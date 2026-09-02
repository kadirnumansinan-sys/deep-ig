import type { Channel, ContentCandidate } from '@/lib/content';
import { stripSourceAttribution } from '@/lib/copy-guard';
import { isLanguageMatch, type PublicationLanguage } from '@/lib/language';
import { GOOGLE_NEWS_ITEMS_PER_FEED } from '../config';
import { asArray, cleanHtml, fetchXml, isTodayish, rssImage, stableId, text } from '../feed';
import type { RssItem } from '../types';

export async function parseGoogleNewsFeed(
  url: string,
  language: PublicationLanguage,
  feedIndex: number,
): Promise<ContentCandidate[]> {
  const data = await fetchXml(url);
  const rss = data.rss as { channel?: { item?: RssItem | RssItem[] } } | undefined;
  return asArray(rss?.channel?.item)
    .filter((item) => isTodayish(text(item.pubDate)))
    .slice(0, GOOGLE_NEWS_ITEMS_PER_FEED)
    .flatMap((item, index) => {
      const rawTitle = text(item.title);
      const sourceName = text(item.source) || rawTitle.split(' - ').at(-1) || 'Google News';
      const withoutSuffix = rawTitle.endsWith(` - ${sourceName}`)
        ? rawTitle.slice(0, -(` - ${sourceName}`.length))
        : rawTitle;
      const title = stripSourceAttribution(withoutSuffix, sourceName);
      const summary = stripSourceAttribution(cleanHtml(text(item.description)) || title, sourceName) || title;
      const sourceUrl = text(item.link);
      if (!title || !sourceUrl || !isLanguageMatch(`${title} ${summary}`, language, sourceName)) return [];
      return [{
        id: stableId(`gnews-${language}`, `${title}:${sourceUrl}`),
        kind: 'news' as const,
        title,
        summary,
        imageUrl: rssImage(item),
        sourceName,
        sourceUrl,
        publishedAt: text(item.pubDate),
        canonicalPublishedAt: '',
        freshnessStatus: 'unverified' as const,
        sourceType: /\.gov\.tr(?:\/|$)/iu.test(sourceUrl) ? 'official' as const : 'aggregator' as const,
        score: Math.max(52, 84 - feedIndex * 2 - Math.floor(index / 4)),
        signal: 'Google News · kaynak tarihi kontrol edilecek',
      }];
    });
}

export function googleNewsUrls(channel: Exclude<Channel, 'history'>): string[] {
  if (channel === 'international') {
    const locale = 'hl=en-US&gl=US&ceid=US:en';
    return ['', 'WORLD', 'BUSINESS', 'TECHNOLOGY', 'HEALTH', 'SCIENCE', 'ENTERTAINMENT'].map((topic) => topic
      ? `https://news.google.com/rss/headlines/section/topic/${topic}?${locale}`
      : `https://news.google.com/rss?${locale}`);
  }
  const locale = 'hl=tr&gl=TR&ceid=TR:tr';
  const base = channel === 'news'
    ? ['', 'NATION', 'BUSINESS', 'TECHNOLOGY', 'HEALTH']
    : ['', 'NATION', 'HEALTH', 'SCIENCE'];
  const searches = channel === 'news'
    ? [
        'Türkiye önemli gelişme when:1d',
        '(bakanlık OR TBMM OR belediye OR valilik) when:1d',
        'site:gov.tr when:1d',
      ]
    : [
        '(yerel OR belediye OR ulaşım OR eğitim OR kültür OR çevre) Türkiye when:1d',
        '(İstanbul OR Ankara OR İzmir OR Bursa OR Antalya OR Adana) yerel when:1d',
        '(Karadeniz OR Ege OR Akdeniz OR İç Anadolu OR Doğu Anadolu OR Güneydoğu) yerel when:1d',
      ];
  return [
    ...base.map((topic) => topic
      ? `https://news.google.com/rss/headlines/section/topic/${topic}?${locale}`
      : `https://news.google.com/rss?${locale}`),
    ...searches.map((query) => `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}`),
  ];
}

export async function getGoogleNews(channel: Exclude<Channel, 'history'>): Promise<ContentCandidate[]> {
  const language: PublicationLanguage = channel === 'international' ? 'en' : 'tr';
  const results = await Promise.allSettled(
    googleNewsUrls(channel).map((url, index) => parseGoogleNewsFeed(url, language, index)),
  );
  if (!results.some((result) => result.status === 'fulfilled')) throw new Error('Tüm Google News akışları başarısız');
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}
