import newsSourcesData from '@/config/news-sources.json';
import type { Channel } from '@/lib/content';
import type { PublicationLanguage } from '@/lib/language';
import type { PublisherFeed, PublisherGroup, SourceTypeName } from '../types';

/**
 * Kaynak kayıt defteri. Akış listesi `config/news-sources.json` içindedir; yeni bir
 * yayıncı eklemek için kod değil yalnızca o dosya değiştirilir.
 */
type RegistryFeed = {
  url?: string;
  path?: string;
  channels: string[];
  breaking?: boolean;
};

type RegistrySource = {
  id: string;
  label: string;
  sourceName: string;
  language: PublicationLanguage;
  trust?: number;
  sourceType?: SourceTypeName;
  domains?: string[];
  urlTemplate?: string;
  feeds: RegistryFeed[];
};

type Registry = {
  defaultTrust?: number;
  sources: RegistrySource[];
};

const registry = newsSourcesData as unknown as Registry;
const DEFAULT_TRUST = typeof registry.defaultTrust === 'number' ? registry.defaultTrust : 60;

function feedUrl(source: RegistrySource, feed: RegistryFeed): string {
  if (feed.url) return feed.url;
  if (source.urlTemplate && feed.path) return source.urlTemplate.replace('{path}', feed.path);
  return '';
}

function normalizeName(value: string): string {
  return value.toLocaleLowerCase('tr').replace(/\s+/gu, ' ').trim();
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return '';
  }
}

const trustByName = new Map<string, number>();
const trustByDomain = new Map<string, number>();

for (const source of registry.sources) {
  const trust = typeof source.trust === 'number' ? source.trust : DEFAULT_TRUST;
  trustByName.set(normalizeName(source.sourceName), trust);
  for (const domain of source.domains ?? []) {
    trustByDomain.set(domain.toLowerCase().replace(/^www\./u, ''), trust);
  }
  for (const feed of source.feeds) {
    const host = hostOf(feedUrl(source, feed));
    if (host && !trustByDomain.has(host)) trustByDomain.set(host, trust);
  }
}

/** Kanalda okunacak yayıncı grupları; her grup kaynak sağlığı listesinde tek satır olur. */
export function publisherGroups(channel: Exclude<Channel, 'history'>): PublisherGroup[] {
  const groups: PublisherGroup[] = [];
  for (const source of registry.sources) {
    const trust = typeof source.trust === 'number' ? source.trust : DEFAULT_TRUST;
    const feeds: PublisherFeed[] = source.feeds
      .filter((feed) => feed.channels.includes(channel))
      .flatMap((feed) => {
        const url = feedUrl(source, feed);
        if (!url) return [];
        return [{
          url,
          sourceName: source.sourceName,
          language: source.language,
          breaking: feed.breaking === true,
          sourceType: source.sourceType ?? 'publisher',
          trust,
        }];
      });
    if (feeds.length > 0) groups.push({ id: source.id, label: source.label, feeds });
  }
  return groups;
}

/**
 * Kaynak güvenilirliği (0-100). Kayıt defterinde tanımlıysa oradan, değilse
 * yayın alan adından bulunur; hiçbiri tutmazsa `undefined` döner.
 */
export function registryTrust(sourceName: string, sourceUrl: string): number | undefined {
  const byName = trustByName.get(normalizeName(sourceName));
  if (typeof byName === 'number') return byName;
  const host = hostOf(sourceUrl);
  if (!host) return undefined;
  const labels = host.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join('.');
    const trust = trustByDomain.get(candidate);
    if (typeof trust === 'number') return trust;
  }
  return undefined;
}

/** Kayıt defterindeki toplam kaynak ve akış sayısı; kaynak sağlığı özetinde kullanılır. */
export function registrySummary(): { sources: number; feeds: number } {
  return {
    sources: registry.sources.length,
    feeds: registry.sources.reduce((total, source) => total + source.feeds.length, 0),
  };
}
