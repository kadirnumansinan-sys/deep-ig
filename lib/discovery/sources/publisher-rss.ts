import type { ContentCandidate } from '@/lib/content';
import { stripSourceAttribution } from '@/lib/copy-guard';
import { isLanguageMatch } from '@/lib/language';
import { cleanHtml, feedItems, fetchXml, isTodayish, rssImage, stableId, text } from '../feed';
import type { PublisherFeed } from '../types';

/** Toplayıcı akışlarda yayın tarihi kaynak sayfasından doğrulanmadığı için ayrı sinyal verilir. */
function feedSignal(feed: PublisherFeed): string {
  if (feed.breaking) return 'Son dakika akışı · bugün doğrulandı';
  if (feed.sourceType === 'official') return 'Resmî kaynak akışı · bugün doğrulandı';
  if (feed.sourceType === 'aggregator') return 'Toplayıcı akış · kaynak tarihi kontrol edilecek';
  return 'Kaynak RSS · bugün doğrulandı';
}

async function parsePublisherFeed(feed: PublisherFeed, itemLimit: number): Promise<ContentCandidate[]> {
  const data = await fetchXml(feed.url);
  const sourceType = feed.sourceType ?? 'publisher';
  return feedItems(data)
    .filter((item) => isTodayish(text(item.pubDate)))
    .slice(0, itemLimit)
    .flatMap((item, index) => {
      const sourceUrl = text(item.link) || text(item.guid);
      const title = stripSourceAttribution(text(item.title), feed.sourceName);
      const summary = stripSourceAttribution(cleanHtml(text(item.description)), feed.sourceName) || title;
      const publishedAt = text(item.pubDate);
      if (
        !sourceUrl || !title || !publishedAt
        || !isLanguageMatch(`${title} ${summary}`, feed.language, feed.sourceName)
      ) return [];
      // Kaynak güveni (0-100) puana taşınır; aynı olayda hangi kaynağın metnine güvenileceğini de bu belirler.
      const trustBoost = Math.round(((feed.trust ?? 60) - 60) / 6);
      return [{
        id: stableId(`publisher-${feed.language}`, sourceUrl),
        kind: 'news' as const,
        title,
        summary,
        imageUrl: rssImage(item),
        sourceName: feed.sourceName,
        sourceUrl,
        publishedAt,
        canonicalPublishedAt: publishedAt,
        freshnessStatus: 'today' as const,
        sourceType,
        score: Math.max(52, 88 - Math.floor(index / 4) + trustBoost),
        breaking: feed.breaking === true,
        signal: feedSignal(feed),
      }];
    });
}

export async function getPublisherRss(feeds: PublisherFeed[], itemLimit: number): Promise<ContentCandidate[]> {
  const results = await Promise.allSettled(feeds.map((feed) => parsePublisherFeed(feed, itemLimit)));
  if (!results.some((result) => result.status === 'fulfilled')) throw new Error('Tüm doğrudan RSS akışları başarısız');
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}
