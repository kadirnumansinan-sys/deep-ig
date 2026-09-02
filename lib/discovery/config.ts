import type { Channel } from '@/lib/content';
import type { ChannelTuning } from './types';

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const GOOGLE_NEWS_ITEMS_PER_FEED = positiveInteger(process.env.DISCOVERY_GOOGLE_NEWS_ITEMS, 100);
export const PUBLISHER_FEED_ITEMS_PER_SOURCE = positiveInteger(process.env.DISCOVERY_PUBLISHER_FEED_ITEMS, 120);
export const GDELT_MAX_RECORDS = positiveInteger(process.env.DISCOVERY_GDELT_MAX_RECORDS, 180);
export const DISCOVERY_RECENT_HOURS = positiveInteger(process.env.DISCOVERY_RECENT_HOURS, 0);

// Her haber sayfasının ritmi farklı: son dakika akışı dakikalar içinde değişiyor,
// yaşam/kültür akışı saatlerde, tarihte bugün ise günde bir kez. Tarama sıklığı,
// kaynak başına öğe sayısı ve liste boyu sayfaya göre ayrı ayarlanıyor.
export function channelTuning(channel: Channel): ChannelTuning {
  if (channel === 'history') {
    return {
      feedItems: PUBLISHER_FEED_ITEMS_PER_SOURCE,
      trendsLabel: 'Google Trends · Türkiye',
      trendsTtlMs: 6 * 60 * 60_000,
      gdeltTtlMs: 6 * 60 * 60_000,
      newsApiTtlMs: 6 * 60 * 60_000,
      responseTtlMs: 60 * 60_000,
      maxCandidates: 60,
    };
  }
  if (channel === 'international') {
    return {
      feedItems: PUBLISHER_FEED_ITEMS_PER_SOURCE,
      trendsLabel: 'Google Trends · Global',
      trendsTtlMs: 30 * 60_000,
      gdeltTtlMs: 15 * 60_000,
      newsApiTtlMs: 60 * 60_000,
      responseTtlMs: 5 * 60_000,
      maxCandidates: 100,
    };
  }
  if (channel === 'media') {
    return {
      feedItems: Math.max(40, Math.round(PUBLISHER_FEED_ITEMS_PER_SOURCE * 0.75)),
      trendsLabel: 'Google Trends · Türkiye',
      trendsTtlMs: 60 * 60_000,
      gdeltTtlMs: 30 * 60_000,
      newsApiTtlMs: 120 * 60_000,
      responseTtlMs: 10 * 60_000,
      maxCandidates: 80,
    };
  }
  return {
    feedItems: PUBLISHER_FEED_ITEMS_PER_SOURCE,
    trendsLabel: 'Google Trends · Türkiye',
    trendsTtlMs: 20 * 60_000,
    gdeltTtlMs: 10 * 60_000,
    newsApiTtlMs: 60 * 60_000,
    responseTtlMs: 3 * 60_000,
    maxCandidates: 100,
  };
}
