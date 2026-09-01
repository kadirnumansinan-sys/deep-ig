import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import { decodeHtml, extractArticleExcerpt } from '@/lib/article-extractor';
import { freshnessFor } from '@/lib/news-intelligence';
import { isSafeHttpsUrl, signUrl, verifyUrlSignature } from '@/lib/url-signing';

export const dynamic = 'force-dynamic';

type HtmlAttributes = Map<string, string>;

type JsonLdEvidence = {
  images: string[];
  datePublished: string;
  dateModified: string;
  title: string;
  description: string;
};

function attributes(tag: string): HtmlAttributes {
  const output = new Map<string, string>();
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)) {
    output.set(match[1].toLowerCase(), decodeHtml(match[3]));
  }
  return output;
}

function metaContents(html: string, keys: string[]): string[] {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const values: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const key = (attrs.get('property') || attrs.get('name') || attrs.get('itemprop') || '').toLowerCase();
    const value = attrs.get('content') || '';
    if (wanted.has(key) && value) values.push(value);
  }
  return Array.from(new Set(values));
}

function linkImages(html: string): string[] {
  const images: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const rel = (attrs.get('rel') || '').toLowerCase();
    const href = attrs.get('href') || '';
    if ((rel === 'image_src' || rel === 'preload' && attrs.get('as') === 'image') && href) images.push(href);
  }
  return images;
}

function srcsetImages(html: string): string[] {
  const images: Array<{ url: string; width: number }> = [];
  for (const tag of html.match(/<(?:img|source)\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const srcset = attrs.get('srcset') || '';
    for (const part of srcset.split(',')) {
      const match = part.trim().match(/^(\S+)\s+(\d+)w$/i);
      if (match) images.push({ url: match[1], width: Number(match[2]) });
    }
    const src = attrs.get('data-src') || attrs.get('data-original') || attrs.get('src') || '';
    if (src) images.push({ url: src, width: Number(attrs.get('width')) || 0 });
  }
  return images.sort((left, right) => right.width - left.width).map((item) => item.url).slice(0, 20);
}

function jsonLdEvidence(html: string): JsonLdEvidence {
  const evidence: JsonLdEvidence = {
    images: [],
    datePublished: '',
    dateModified: '',
    title: '',
    description: '',
  };

  function imageValue(value: unknown): void {
    if (typeof value === 'string') {
      evidence.images.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(imageValue);
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      imageValue(record.url || record.contentUrl || record.thumbnailUrl);
    }
  }

  function visit(value: unknown, depth = 0): void {
    if (!value || depth > 25) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const rawType = record['@type'];
    const types = (Array.isArray(rawType) ? rawType : [rawType])
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.toLowerCase());
    const isArticle = types.some((type) => type.includes('article') || type === 'newsmediaorganization');
    if (isArticle || record.headline || record.datePublished) {
      imageValue(record.image || record.thumbnailUrl || record.associatedMedia);
      if (!evidence.datePublished && typeof record.datePublished === 'string') {
        evidence.datePublished = record.datePublished;
      }
      if (!evidence.dateModified && typeof record.dateModified === 'string') {
        evidence.dateModified = record.dateModified;
      }
      if (!evidence.title && typeof record.headline === 'string') evidence.title = record.headline;
      if (!evidence.description && typeof record.description === 'string') evidence.description = record.description;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  }

  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[2]));
    } catch {
      // Publisher JSON-LD blocks that are not valid JSON are ignored.
    }
  }
  evidence.images = Array.from(new Set(evidence.images));
  return evidence;
}

function upgradeKnownPublisherImage(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname === 'image.hurimg.com') {
      url.pathname = url.pathname.replace(
        /\/i\/hurriyet\/\d+\/(?:\d+x\d+|0x0)\//,
        '/i/hurriyet/100/1920x1080/',
      );
    }
    if (url.hostname === 'image.milimaj.com') {
      url.pathname = url.pathname.replace(
        /\/i\/milliyet\/\d+\/(?:\d+x\d+|0x0)\//,
        '/i/milliyet/100/1920x1080/',
      );
    }
    if (url.hostname === 'ichef.bbci.co.uk') {
      url.pathname = url.pathname.replace(/\/ace\/standard\/\d+\//, '/ace/standard/1920/');
    }
    return url.toString();
  } catch {
    return value;
  }
}

function validImageCandidate(raw: string, baseUrl: string): string {
  try {
    const resolved = upgradeKnownPublisherImage(new URL(decodeHtml(raw), baseUrl).toString());
    if (!isSafeHttpsUrl(resolved)) return '';
    if (/(?:^|[\/_-])(logo|icon|avatar|favicon|sprite|badge)(?:[\/_-]|\.|$)/i.test(resolved)) return '';
    if (/\.(?:svg|gif)(?:\?|$)/i.test(resolved)) return '';
    return resolved;
  } catch {
    return '';
  }
}

function imageRank(value: string, index: number): number {
  const dimensions = Array.from(value.matchAll(/(?:^|[^\d])(\d{3,4})[x_\/-](\d{3,4})(?:[^\d]|$)/g))
    .map((match) => Number(match[1]) * Number(match[2]));
  const area = dimensions.length ? Math.max(...dimensions) : 0;
  const quality = /(?:1920|1600|1280|1200|1080)/.test(value) ? 500 : 0;
  return Math.min(1_000, area / 10_000) + quality - index * 3;
}

function firstDate(html: string, keys: string[]): string {
  return metaContents(html, keys)[0] || '';
}

function timeDate(html: string, itemprop: string): string {
  for (const tag of html.match(/<time\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (!itemprop || (attrs.get('itemprop') || '').toLowerCase() === itemprop.toLowerCase()) {
      const value = attrs.get('datetime') || '';
      if (value) return value;
    }
  }
  return '';
}

function validDate(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

async function readLimitedHtml(response: Response, maxBytes = 2_500_000): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = '';
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    output += decoder.decode(value, { stream: true });
    if (size >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return output;
}

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const requestUrl = new URL(request.url);
  const sourceUrl = requestUrl.searchParams.get('url') ?? '';
  const token = requestUrl.searchParams.get('token') ?? '';
  if (!verifyUrlSignature(sourceUrl, token, 'source')) {
    return NextResponse.json({ error: 'Kaynak doğrulanamadı.' }, { status: 403 });
  }

  try {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; DeepbriefContentStudio/2.0; +https://deepbrief.local)',
      },
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('text/html')) {
      return NextResponse.json({ error: 'Haber sayfası okunamadı.' }, { status: 422 });
    }

    const html = await readLimitedHtml(response);
    const structured = jsonLdEvidence(html);
    const rawImages = [
      ...metaContents(html, [
        'og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image:src', 'twitter:image',
      ]),
      ...structured.images,
      ...linkImages(html),
      ...srcsetImages(html),
    ];
    const imageCandidates = Array.from(new Set(rawImages
      .map((value) => validImageCandidate(value, response.url))
      .filter(Boolean)))
      .map((url, index) => ({ url, score: imageRank(url, index) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 8)
      .map(({ url }) => ({ url, token: signUrl(url, 'image') }));
    const imageUrl = imageCandidates[0]?.url || '';

    const title = metaContents(html, ['og:title', 'twitter:title', 'headline'])[0]
      || structured.title;
    const metaDescription = metaContents(html, [
      'og:description', 'twitter:description', 'description',
    ])[0] || structured.description;
    const description = metaDescription.split(/\s+/u).filter(Boolean).length >= 14
      ? metaDescription
      : extractArticleExcerpt(html, title) || metaDescription;
    const publishedAt = validDate(
      structured.datePublished
      || firstDate(html, ['article:published_time', 'datepublished', 'date', 'publishdate', 'parsely-pub-date'])
      || timeDate(html, 'datePublished'),
    );
    const modifiedAt = validDate(
      structured.dateModified
      || firstDate(html, ['article:modified_time', 'datemodified', 'last-modified', 'lastmodified'])
      || timeDate(html, 'dateModified'),
    );

    return NextResponse.json({
      imageUrl,
      imageToken: imageUrl ? signUrl(imageUrl, 'image') : '',
      imageCandidates,
      title,
      description,
      resolvedSourceUrl: response.url,
      canonicalPublishedAt: publishedAt,
      canonicalModifiedAt: modifiedAt,
      freshnessStatus: freshnessFor(publishedAt, modifiedAt),
    }, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Kaynak içeriği bulunamadı.',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
