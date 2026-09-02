import { XMLParser } from 'fast-xml-parser';
import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import type { Channel, ContentCandidate, DiscoveryResponse } from '@/lib/content';
import { stripSourceAttribution } from '@/lib/copy-guard';
import {
  databaseConfigured,
  databaseLastError,
  loadRecentCandidates,
  persistDiscoverySnapshot,
} from '@/lib/database';
import { groqStatus } from '@/lib/groq';
import { isLanguageMatch, type PublicationLanguage } from '@/lib/language';
import {
  deduplicateCandidates,
  enrichIntelligence,
  freshnessFor,
  istanbulDate,
  istanbulNowDate,
  isRecentHours,
  isTodayIstanbul,
} from '@/lib/news-intelligence';
import { isSafeHttpsUrl, signUrl } from '@/lib/url-signing';

export const dynamic = 'force-dynamic';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

type SourceResult = {
  id: string;
  label: string;
  candidates: ContentCandidate[];
  status: 'active' | 'unavailable';
  latencyMs: number;
  detail: string;
};

const discoveryCache = new Map<Channel, { expiresAt: number; payload: DiscoveryResponse }>();
const sourceCache = new Map<string, { expiresAt: number; candidates: ContentCandidate[] }>();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const GOOGLE_NEWS_ITEMS_PER_FEED = positiveInteger(process.env.DISCOVERY_GOOGLE_NEWS_ITEMS, 100);
const PUBLISHER_FEED_ITEMS_PER_SOURCE = positiveInteger(process.env.DISCOVERY_PUBLISHER_FEED_ITEMS, 120);
const GDELT_MAX_RECORDS = positiveInteger(process.env.DISCOVERY_GDELT_MAX_RECORDS, 180);
const DISCOVERY_RECENT_HOURS = positiveInteger(process.env.DISCOVERY_RECENT_HOURS, 0);

function isTodayish(value: string): boolean {
  if (!value) return false;
  if (isTodayIstanbul(value)) return true;
  if (DISCOVERY_RECENT_HOURS <= 0) return false;
  return isRecentHours(value, DISCOVERY_RECENT_HOURS, new Date());
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object' && '#text' in value) {
    return text((value as { '#text': unknown })['#text']);
  }
  return '';
}

function cleanHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function trafficToScore(value: string, index: number): number {
  const amount = Number(value.replace(/[^\d]/g, '')) || 0;
  const trafficScore = Math.min(35, Math.round(Math.log10(Math.max(amount, 10)) * 12));
  return Math.max(55, Math.min(99, 91 - index * 2 + trafficScore));
}

async function fetchXml(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'DeepbriefContentStudio/2.0',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parser.parse(await response.text()) as Record<string, unknown>;
}

async function runSource(
  id: string,
  label: string,
  loader: () => Promise<ContentCandidate[]>,
): Promise<SourceResult> {
  const startedAt = Date.now();
  try {
    const candidates = await loader();
    return {
      id,
      label,
      candidates,
      status: 'active',
      latencyMs: Date.now() - startedAt,
      detail: candidates.length ? `${candidates.length} aday` : 'Bugüne ait aday yok',
    };
  } catch (error) {
    return {
      id,
      label,
      candidates: [],
      status: 'unavailable',
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message.slice(0, 120) : 'Kaynak okunamadı',
    };
  }
}

async function cachedSource(
  key: string,
  ttlMs: number,
  loader: () => Promise<ContentCandidate[]>,
): Promise<ContentCandidate[]> {
  const cached = sourceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.candidates;
  const candidates = await loader();
  sourceCache.set(key, { candidates, expiresAt: Date.now() + ttlMs });
  if (sourceCache.size > 40) {
    for (const [cacheKey, entry] of sourceCache) {
      if (entry.expiresAt <= Date.now()) sourceCache.delete(cacheKey);
    }
  }
  return candidates;
}

type TrendItem = {
  title?: unknown;
  pubDate?: unknown;
  'ht:approx_traffic'?: unknown;
  'ht:picture'?: unknown;
  'ht:picture_source'?: unknown;
  'ht:news_item'?: unknown;
};

type TrendNewsItem = {
  'ht:news_item_title'?: unknown;
  'ht:news_item_snippet'?: unknown;
  'ht:news_item_url'?: unknown;
  'ht:news_item_picture'?: unknown;
  'ht:news_item_source'?: unknown;
};

function trendLeadScore(article: TrendNewsItem): number {
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

async function getTrends(language: PublicationLanguage): Promise<ContentCandidate[]> {
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

type RssImage = { '@_url'?: unknown; url?: unknown };
type RssItem = {
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

function rssImage(item: RssItem): string {
  const media = [
    ...asArray(item['media:content']),
    ...asArray(item['media:thumbnail']),
    ...(item.enclosure ? [item.enclosure] : []),
  ];
  const direct = media.map((entry) => text(entry?.['@_url']) || text(entry?.url)).find(Boolean) || '';
  if (isSafeHttpsUrl(direct)) return direct;
  const fromDescription = text(item.description).match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || '';
  return isSafeHttpsUrl(fromDescription) ? fromDescription : '';
}

type AtomLink = { '@_href'?: unknown; '@_rel'?: unknown };
type AtomEntry = {
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

function atomToRssItem(entry: AtomEntry): RssItem {
  const links = asArray(entry.link);
  const alternate = links.find((link) => {
    const rel = text(link?.['@_rel']);
    return !rel || rel === 'alternate';
  }) || links[0];
  return {
    title: entry.title,
    link: alternate ? text(alternate['@_href']) : '',
    guid: entry.id,
    pubDate: text(entry.published) || text(entry.updated),
    description: entry.summary ?? entry.content,
    'media:content': entry['media:content'],
    'media:thumbnail': entry['media:thumbnail'],
  };
}

// RSS 2.0 ve Atom akışlarını tek biçime indirger (NTV Atom yayınlar).
function feedItems(data: Record<string, unknown>): RssItem[] {
  const rss = data.rss as { channel?: { item?: RssItem | RssItem[] } } | undefined;
  if (rss?.channel?.item) return asArray(rss.channel.item);
  const atom = data.feed as { entry?: AtomEntry | AtomEntry[] } | undefined;
  return asArray(atom?.entry).map(atomToRssItem);
}

async function parseGoogleNewsFeed(
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

function googleNewsUrls(channel: Exclude<Channel, 'history'>): string[] {
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

async function getGoogleNews(channel: Exclude<Channel, 'history'>): Promise<ContentCandidate[]> {
  const language: PublicationLanguage = channel === 'international' ? 'en' : 'tr';
  const results = await Promise.allSettled(
    googleNewsUrls(channel).map((url, index) => parseGoogleNewsFeed(url, language, index)),
  );
  if (!results.some((result) => result.status === 'fulfilled')) throw new Error('Tüm Google News akışları başarısız');
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

type PublisherFeed = { url: string; sourceName: string; language: PublicationLanguage; breaking?: boolean };
type PublisherGroup = { id: string; label: string; feeds: PublisherFeed[] };

type ChannelTuning = {
  feedItems: number;
  trendsLabel: string;
  trendsTtlMs: number;
  gdeltTtlMs: number;
  newsApiTtlMs: number;
  responseTtlMs: number;
  maxCandidates: number;
};

// Her haber sayfasının ritmi farklı: son dakika akışı dakikalar içinde değişiyor,
// yaşam/kültür akışı saatlerde, tarihte bugün ise günde bir kez. Tarama sıklığı,
// kaynak başına öğe sayısı ve liste boyu sayfaya göre ayrı ayarlanıyor.
function channelTuning(channel: Channel): ChannelTuning {
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

function publisherGroups(channel: Exclude<Channel, 'history'>): PublisherGroup[] {
  if (channel === 'international') {
    return [
      {
        id: 'bbc-rss',
        label: 'BBC News · doğrudan RSS',
        feeds: [
          'world', 'business', 'technology', 'science_and_environment',
        ].map((name) => ({
          url: `https://feeds.bbci.co.uk/news/${name}/rss.xml`,
          sourceName: 'BBC News',
          language: 'en' as const,
        })),
      },
      {
        id: 'guardian-rss',
        label: 'The Guardian · doğrudan RSS',
        feeds: ['world', 'business', 'environment', 'technology'].map((name) => ({
          url: `https://www.theguardian.com/${name}/rss`,
          sourceName: 'The Guardian',
          language: 'en' as const,
        })),
      },
      {
        id: 'aljazeera-rss',
        label: 'Al Jazeera · doğrudan RSS',
        feeds: [{
          url: 'https://www.aljazeera.com/xml/rss/all.xml',
          sourceName: 'Al Jazeera',
          language: 'en',
        }],
      },
      {
        id: 'npr-rss',
        label: 'NPR World · doğrudan RSS',
        feeds: [{
          url: 'https://feeds.npr.org/1004/rss.xml',
          sourceName: 'NPR',
          language: 'en',
        }],
      },
      {
        id: 'reuters-rss',
        label: 'Reuters · doğrudan RSS',
        feeds: [{
          url: 'https://www.reuters.com/world/feed/',
          sourceName: 'Reuters',
          language: 'en',
        }],
      },
      {
        id: 'sky-rss',
        label: 'Sky News · doğrudan RSS',
        feeds: [{
          url: 'https://feeds.skynews.com/feeds/rss/world.xml',
          sourceName: 'Sky News',
          language: 'en',
        }],
      },
      {
        id: 'france24-rss',
        label: 'France 24 · doğrudan RSS',
        feeds: [{
          url: 'https://www.france24.com/en/rss',
          sourceName: 'France 24',
          language: 'en',
        }],
      },
      {
        id: 'cnn-rss',
        label: 'CNN International · doğrudan RSS',
        feeds: [{
          // Eski http uç noktası; https sürümü TLS hatası veriyor (sunucudan çekildiği için güvenli).
          url: 'http://rss.cnn.com/rss/edition_world.rss',
          sourceName: 'CNN',
          language: 'en',
        }],
      },
    ];
  }
  const trtNames = channel === 'news'
    ? ['sondakika', 'gundem', 'turkiye', 'ekonomi', 'bilim_teknoloji']
    : ['turkiye', 'yasam', 'guncel', 'egitim', 'kultur_sanat', 'saglik'];
  const haberturkNames = channel === 'news'
    ? ['manset.xml', 'kategori/gundem.xml', 'ekonomi.xml', 'kategori/siyaset.xml']
    : ['yerel-haberler.xml', 'kategori/yasam.xml', 'kategori/saglik.xml', 'kategori/kultur-sanat.xml', 'kategori/teknoloji.xml'];
  const aaNames = channel === 'news'
    ? ['guncel', 'politika', 'ekonomi']
    : ['yasam', 'kultur-sanat', 'bilim-teknoloji', 'saglik'];
  const turkishExtras: PublisherGroup[] = [
    {
      id: 'cumhuriyet-rss',
      label: 'Cumhuriyet · doğrudan RSS',
      feeds: [{
        url: 'https://www.cumhuriyet.com.tr/rss',
        sourceName: 'Cumhuriyet',
        language: 'tr',
      }],
    },
    {
      id: 'dw-tr-rss',
      label: 'DW Türkçe · doğrudan RSS',
      feeds: [{
        url: 'https://rss.dw.com/xml/rss-tur-all',
        sourceName: 'DW Türkçe',
        language: 'tr',
      }],
    },
    {
      id: 'bbc-tr-rss',
      label: 'BBC Türkçe · doğrudan RSS',
      feeds: [{
        url: 'https://feeds.bbci.co.uk/turkce/rss.xml',
        sourceName: 'BBC Türkçe',
        language: 'tr',
      }],
    },
  ];
  const newsOnlyExtras: PublisherGroup[] = channel === 'news'
    ? [
      {
        id: 'ntv-rss',
        label: 'NTV · doğrudan RSS',
        feeds: [
          {
            url: 'https://www.ntv.com.tr/son-dakika.rss',
            sourceName: 'NTV',
            language: 'tr',
            breaking: true,
          },
          {
            url: 'https://www.ntv.com.tr/turkiye.rss',
            sourceName: 'NTV',
            language: 'tr',
          },
        ],
      },
      {
        id: 'sozcu-rss',
        label: 'Sözcü · doğrudan RSS',
        feeds: [{
          url: 'https://www.sozcu.com.tr/rss/gundem.xml',
          sourceName: 'Sözcü',
          language: 'tr',
        }],
      },
    ]
    : [];
  // Yaşam/kültür sayfasının kendi akışı yoktu; TRT ve AA'nın genel beslemesine
  // ek olarak NTV'nin yaşam, teknoloji ve sağlık RSS'leri (hepsi 200 doğrulandı).
  const mediaOnlyExtras: PublisherGroup[] = channel === 'media'
    ? [{
      id: 'ntv-yasam-rss',
      label: 'NTV · yaşam ve teknoloji RSS',
      feeds: ['yasam', 'teknoloji', 'saglik'].map((name) => ({
        url: `https://www.ntv.com.tr/${name}.rss`,
        sourceName: 'NTV',
        language: 'tr' as const,
      })),
    }]
    : [];
  return [
    {
      id: 'trt-rss',
      label: 'TRT Haber · doğrudan RSS',
      feeds: trtNames.map((name) => ({
        url: `https://www.trthaber.com/${name}_articles.rss`,
        sourceName: 'TRT Haber',
        language: 'tr' as const,
        breaking: name === 'sondakika',
      })),
    },
    {
      id: 'aa-rss',
      label: 'Anadolu Ajansı · doğrudan RSS',
      feeds: aaNames.map((name) => ({
        url: `https://www.aa.com.tr/tr/rss/default?cat=${name}`,
        sourceName: 'Anadolu Ajansı',
        language: 'tr' as const,
      })),
    },
    {
      id: 'haberturk-rss',
      label: 'Habertürk · doğrudan RSS',
      feeds: haberturkNames.map((name) => ({
        url: `https://www.haberturk.com/rss/${name}`,
        sourceName: 'Habertürk',
        language: 'tr' as const,
      })),
    },
    ...newsOnlyExtras,
    ...mediaOnlyExtras,
    ...turkishExtras,
  ];
}

async function parsePublisherFeed(feed: PublisherFeed, itemLimit: number): Promise<ContentCandidate[]> {
  const data = await fetchXml(feed.url);
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
        sourceType: 'publisher' as const,
        score: Math.max(58, 88 - Math.floor(index / 4)),
        breaking: feed.breaking === true,
        signal: feed.breaking ? 'Son dakika akışı · bugün doğrulandı' : 'Kaynak RSS · bugün doğrulandı',
      }];
    });
}

async function getPublisherRss(feeds: PublisherFeed[], itemLimit: number): Promise<ContentCandidate[]> {
  const results = await Promise.allSettled(feeds.map((feed) => parsePublisherFeed(feed, itemLimit)));
  if (!results.some((result) => result.status === 'fulfilled')) throw new Error('Tüm doğrudan RSS akışları başarısız');
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

type GdeltArticle = {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  socialimage?: string;
  domain?: string;
};

async function getGdelt(channel: Exclude<Channel, 'history'>): Promise<ContentCandidate[]> {
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

type NewsApiArticle = {
  source?: { name?: string };
  title?: string;
  description?: string;
  url?: string;
  urlToImage?: string;
  publishedAt?: string;
};

async function getNewsApi(channel: Exclude<Channel, 'history'>): Promise<ContentCandidate[]> {
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

type WikimediaPage = {
  title?: string;
  extract?: string;
  thumbnail?: { source?: string };
  originalimage?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
};
type WikimediaEvent = { text?: string; year?: number; pages?: WikimediaPage[] };

async function getHistory(month: string, day: string): Promise<ContentCandidate[]> {
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

function signedCandidates(candidates: ContentCandidate[]): ContentCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    sourceToken: isSafeHttpsUrl(candidate.sourceUrl) ? signUrl(candidate.sourceUrl, 'source') : undefined,
    imageToken: candidate.imageUrl && isSafeHttpsUrl(candidate.imageUrl)
      ? signUrl(candidate.imageUrl, 'image')
      : undefined,
  }));
}

function coverageFor(candidates: ContentCandidate[]): NonNullable<DiscoveryResponse['coverage']> {
  const clusters = new Set(candidates.map((candidate) => candidate.clusterId || candidate.id));
  const corroborated = new Set(candidates
    .filter((candidate) => candidate.verification?.status === 'corroborated')
    .map((candidate) => candidate.clusterId || candidate.id));
  return {
    totalDiscovered: candidates.length,
    uniqueEvents: clusters.size,
    corroboratedEvents: corroborated.size,
    withImages: candidates.filter((candidate) => Boolean(candidate.imageUrl)).length,
    withLocations: candidates.filter((candidate) => Boolean(candidate.location?.label)).length,
    aiAnalyzed: candidates.filter((candidate) => candidate.aiAnalysis?.status !== undefined).length,
    aiPromoted: candidates.filter((candidate) => (
      Boolean(candidate.aiAnalysis) && candidate.score > (candidate.scoreBreakdown?.total || candidate.score)
    )).length,
  };
}

async function discover(channel: Channel): Promise<DiscoveryResponse> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Istanbul',
    month: '2-digit',
    day: '2-digit',
  });
  const [month, day] = formatter.format(new Date()).split('/');

  if (channel === 'history') {
    const source = await runSource('wikimedia', 'Wikimedia · Tarihte bugün', () => getHistory(month, day));
    const candidates = signedCandidates(
      deduplicateCandidates(enrichIntelligence(source.candidates, channel))
        .sort((left, right) => right.score - left.score)
        .slice(0, 60),
    );
    return {
      candidates,
      generatedAt: new Date().toISOString(),
      sourceStatus: [{
        id: source.id,
        label: source.label,
        status: source.status,
        candidateCount: source.candidates.length,
        checkedAt: new Date().toISOString(),
        latencyMs: source.latencyMs,
        detail: source.detail,
      }],
      coverage: coverageFor(candidates),
      warnings: source.status === 'unavailable' ? ['Tarihte bugün kaynağına ulaşılamadı.'] : [],
    };
  }

  const language: PublicationLanguage = channel === 'international' ? 'en' : 'tr';
  const tuning = channelTuning(channel);
  const directPublisherSources = publisherGroups(channel).map((group) => (
    runSource(group.id, group.label, () => getPublisherRss(group.feeds, tuning.feedItems))
  ));
  const results = await Promise.all([
    ...directPublisherSources,
    runSource('google-news', channel === 'international' ? 'Google News · Global' : 'Google News · Türkiye', () => getGoogleNews(channel)),
    runSource('google-trends', tuning.trendsLabel, () => (
      cachedSource(`trends:${language}`, tuning.trendsTtlMs, () => getTrends(language))
    )),
    runSource('gdelt', 'GDELT küresel haber ağı', () => (
      cachedSource(`gdelt:${channel}`, tuning.gdeltTtlMs, () => getGdelt(channel))
    )),
    runSource('newsapi', channel === 'international' ? 'NewsAPI · Global' : 'NewsAPI · Türkiye', () => (
      cachedSource(`newsapi:${channel}`, tuning.newsApiTtlMs, () => getNewsApi(channel))
    )),
  ]);
  const combined = results.flatMap((result) => result.candidates);
  const candidates = signedCandidates(
    deduplicateCandidates(enrichIntelligence(combined, channel))
      // Eskimiş kayıt artık sıralamada aşağı itilmiyor, listeden tamamen çıkıyor;
      // yalnızca bugüne ait (ya da tarihi henüz doğrulanmamış canlı) akış kalıyor.
      .filter((candidate) => candidate.freshnessStatus !== 'stale')
      .sort((left, right) => {
        const breakingDelta = Number(right.breaking === true) - Number(left.breaking === true);
        const freshnessDelta = Number(right.freshnessStatus === 'today') - Number(left.freshnessStatus === 'today');
        return breakingDelta * 40 || freshnessDelta * 20 || right.score - left.score;
      })
      .slice(0, tuning.maxCandidates),
  );
  const groq = groqStatus();
  const sourceStatus: DiscoveryResponse['sourceStatus'] = results.map((result) => ({
    id: result.id,
    label: result.label,
    status: result.id === 'newsapi' && !process.env.NEWSAPI_KEY?.trim()
      ? 'needs-key'
      : result.status,
    candidateCount: result.candidates.length,
    checkedAt: new Date().toISOString(),
    latencyMs: result.latencyMs,
    detail: result.id === 'newsapi' && !process.env.NEWSAPI_KEY?.trim()
      ? 'API anahtarı eklenmedi'
      : result.detail,
  }));
  sourceStatus.push({
    id: 'groq',
    label: `Groq · ${groq.keyCount} anahtar · kontrollü analiz`,
    status: groq.configured ? 'active' : 'needs-key',
    candidateCount: 0,
    checkedAt: new Date().toISOString(),
    detail: groq.configured
      ? `Analiz ${groq.usage.analysis}/${groq.usage.analysisLimit}, arama ${groq.usage.search}/${groq.usage.searchLimit}`
      : 'Groq anahtarı eklenmedi',
  });
  const warnings = [
    results.filter((result) => result.status === 'active').length < 3
      ? 'Aktif kaynak sayısı düşük; kaynak sağlığı bölümünü kontrol et.'
      : '',
    candidates.some((candidate) => candidate.freshnessStatus === 'unverified')
      ? '“Kaynak tarihi kontrol edilecek” adaylar bugünün akışında bulundu ancak yayın sayfası tarihi henüz doğrulanmadı.'
      : '',
  ].filter(Boolean);
  return {
    candidates,
    generatedAt: new Date().toISOString(),
    sourceStatus,
    coverage: coverageFor(candidates),
    warnings,
  };
}

const MEMORY_SIGNAL_SUFFIX = ' · kalıcı hafızadan';

// Arşiv rozeti eskiden adayla birlikte kaydediliyordu; her tarama turunda yeniden
// eklenince sinyal metni "· kalıcı hafızadan · kalıcı hafızadan …" diye uzuyordu.
function baseSignal(signal: string): string {
  return signal.split(MEMORY_SIGNAL_SUFFIX).join('').trim();
}

function validChannel(value: string | null): Channel {
  return value === 'history' || value === 'international' || value === 'media' ? value : 'news';
}

async function applyDurableMemory(
  channel: Channel,
  live: DiscoveryResponse,
): Promise<DiscoveryResponse> {
  if (!databaseConfigured()) {
    return {
      ...live,
      sourceStatus: [...live.sourceStatus, {
        id: 'database',
        label: 'Kalıcı haber hafızası',
        status: 'needs-key',
        candidateCount: 0,
        checkedAt: new Date().toISOString(),
        detail: 'Kalıcı veri katmanı kullanılamıyor; canlı tarama çalışmaya devam ediyor.',
      }],
      warnings: Array.from(new Set([
        ...(live.warnings || []),
        'Kalıcı haber hafızası henüz bağlı değil; kaynak kesintisinde geçmiş adaylar geri getirilemez.',
      ])),
    };
  }

  const activeSourceCount = live.sourceStatus.filter((source) => source.status === 'active').length;
  const shouldUseArchive = activeSourceCount < 3 || live.candidates.length < 20;
  let candidates = live.candidates;
  let archivedCount = 0;
  if (shouldUseArchive) {
    const now = new Date();
    const archived = signedCandidates(await loadRecentCandidates(channel, 100))
      .map((candidate) => ({
        ...candidate,
        // Kayıtlı rozet birikimini temizle ve tazeliği kaydedilen değere değil
        // şimdiki zamana göre yeniden hesapla; dünkü "today" bugün stale sayılır.
        signal: baseSignal(candidate.signal),
        freshnessStatus: freshnessFor(
          candidate.canonicalPublishedAt || candidate.publishedAt,
          candidate.canonicalModifiedAt,
          now,
        ),
      }))
      .filter((candidate) => (
        candidate.freshnessStatus === 'today' || candidate.freshnessStatus === 'updated-today'
      ));
    const merged = [...live.candidates];
    for (const candidate of archived) {
      const exists = merged.some((current) => (
        current.id === candidate.id || current.sourceUrl === candidate.sourceUrl
      ));
      if (!exists) {
        merged.push(candidate);
        archivedCount += 1;
      }
    }
    candidates = merged
      .sort((left, right) => right.score - left.score)
      .slice(0, channelTuning(channel).maxCandidates);
  }

  const candidatePayload: DiscoveryResponse = {
    ...live,
    candidates,
    coverage: coverageFor(candidates),
  };
  // Rozetsiz hâl kalıcılaştırılır; arşiv etiketi yalnızca yanıtta gösterilir,
  // böylece her tarama döngüsünde metnin sonuna tekrar tekrar eklenmez.
  const persisted = await persistDiscoverySnapshot(channel, candidatePayload);
  const archivedIds = new Set(
    archivedCount > 0
      ? candidates.filter((candidate) => !live.candidates.some((item) => item.id === candidate.id))
        .map((candidate) => candidate.id)
      : [],
  );
  return {
    ...candidatePayload,
    candidates: archivedIds.size > 0
      ? candidates.map((candidate) => (
        archivedIds.has(candidate.id)
          ? { ...candidate, signal: `${candidate.signal}${MEMORY_SIGNAL_SUFFIX}` }
          : candidate
      ))
      : candidates,
    sourceStatus: [...candidatePayload.sourceStatus, {
      id: 'database',
      label: 'Kalıcı haber hafızası',
      status: persisted ? 'active' : 'unavailable',
      candidateCount: candidates.length,
      checkedAt: new Date().toISOString(),
      detail: persisted ? 'Adaylar ve kaynak sağlığı kalıcı kaydedildi.' : databaseLastError() || 'Kayıt başarısız.',
    }],
    warnings: persisted
      ? candidatePayload.warnings
      : Array.from(new Set([
          ...(candidatePayload.warnings || []),
          'Kalıcı haber hafızasına ulaşılamadı; canlı tarama kullanılmaya devam ediyor.',
        ])),
  };
}

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const channel = validChannel(url.searchParams.get('channel'));
  const force = url.searchParams.get('refresh') === '1';
  try {
    const payload = await getDiscoveryPayload(channel, force);
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'private, max-age=30',
        'X-Deepbrief-Cache': force ? 'REFRESHED' : 'READY',
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Kaynaklar okunamadı.',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function getDiscoveryPayload(
  channel: Channel,
  force = false,
): Promise<DiscoveryResponse> {
  const cached = discoveryCache.get(channel);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  const payload = await applyDurableMemory(channel, await discover(channel));
  // Yanıt ömrü de sayfaya göre: son dakika 3 dk, yaşam 10 dk, tarihte bugün 1 saat.
  discoveryCache.set(channel, {
    payload,
    expiresAt: Date.now() + channelTuning(channel).responseTtlMs,
  });
  return payload;
}
