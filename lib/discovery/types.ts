import type { ContentCandidate } from '@/lib/content';
import type { PublicationLanguage } from '@/lib/language';

export type SourceResult = {
  id: string;
  label: string;
  candidates: ContentCandidate[];
  status: 'active' | 'unavailable';
  latencyMs: number;
  detail: string;
};

export type RssImage = { '@_url'?: unknown; url?: unknown };
export type RssItem = {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
  description?: unknown;
  source?: unknown;
  enclosure?: RssImage;
  'media:content'?: RssImage | RssImage[];
  'media:thumbnail'?: RssImage | RssImage[];
};

export type AtomLink = { '@_href'?: unknown; '@_rel'?: unknown };
export type AtomEntry = {
  title?: unknown;
  id?: unknown;
  link?: AtomLink | AtomLink[];
  published?: unknown;
  updated?: unknown;
  summary?: unknown;
  content?: unknown;
  'media:content'?: RssImage | RssImage[];
  'media:thumbnail'?: RssImage | RssImage[];
};

/** Kayıt defterindeki kaynak sınıfı: yayıncı, resmî kurum ya da haber toplayıcı. */
export type SourceTypeName = 'publisher' | 'official' | 'aggregator';

export type PublisherFeed = {
  url: string;
  sourceName: string;
  language: PublicationLanguage;
  breaking?: boolean;
  sourceType?: SourceTypeName;
  /** 0-100 arası kaynak güvenilirliği; `config/news-sources.json` içinde tanımlı. */
  trust?: number;
};
export type PublisherGroup = { id: string; label: string; feeds: PublisherFeed[] };

export type ChannelTuning = {
  feedItems: number;
  trendsLabel: string;
  trendsTtlMs: number;
  gdeltTtlMs: number;
  newsApiTtlMs: number;
  responseTtlMs: number;
  maxCandidates: number;
};
