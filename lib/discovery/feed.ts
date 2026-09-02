import { XMLParser } from 'fast-xml-parser';
import type { ContentCandidate } from '@/lib/content';
import { isRecentHours, isTodayIstanbul } from '@/lib/news-intelligence';
import { isSafeHttpsUrl } from '@/lib/url-signing';
import { DISCOVERY_RECENT_HOURS } from './config';
import type { AtomEntry, RssItem, SourceResult } from './types';

export const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
export const sourceCache = new Map<string, { expiresAt: number; candidates: ContentCandidate[] }>();

export function isTodayish(value: string): boolean {
  if (!value) return false;
  if (isTodayIstanbul(value)) return true;
  if (DISCOVERY_RECENT_HOURS <= 0) return false;
  return isRecentHours(value, DISCOVERY_RECENT_HOURS, new Date());
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object' && '#text' in value) {
    return text((value as { '#text': unknown })['#text']);
  }
  return '';
}

export function cleanHtml(value: string): string {
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

export function stableId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

export function trafficToScore(value: string, index: number): number {
  const amount = Number(value.replace(/[^\d]/g, '')) || 0;
  const trafficScore = Math.min(35, Math.round(Math.log10(Math.max(amount, 10)) * 12));
  return Math.max(55, Math.min(99, 91 - index * 2 + trafficScore));
}

export async function fetchXml(url: string): Promise<Record<string, unknown>> {
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

export async function runSource(
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

export async function cachedSource(
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

export function rssImage(item: RssItem): string {
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

export function atomToRssItem(entry: AtomEntry): RssItem {
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
export function feedItems(data: Record<string, unknown>): RssItem[] {
  const rss = data.rss as { channel?: { item?: RssItem | RssItem[] } } | undefined;
  if (rss?.channel?.item) return asArray(rss.channel.item);
  const atom = data.feed as { entry?: AtomEntry | AtomEntry[] } | undefined;
  return asArray(atom?.entry).map(atomToRssItem);
}
