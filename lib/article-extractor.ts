const blockedCopy = /(çerez|cookie|gizlilik|privacy|telif|copyright|abonelik|newsletter|iletişim|contact)/iu;

const htmlEntities: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  ccedil: 'ç',
  Ccedil: 'Ç',
  copy: '©',
  deg: '°',
  emsp: ' ',
  ensp: ' ',
  euro: '€',
  gbreve: 'ğ',
  Gbreve: 'Ğ',
  hellip: '…',
  Idot: 'İ',
  inodot: 'ı',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  odot: 'ö',
  Odot: 'Ö',
  ograve: 'ò',
  ouml: 'ö',
  Ouml: 'Ö',
  quot: '"',
  rdquo: '”',
  rsquo: '’',
  scedil: 'ş',
  Scedil: 'Ş',
  trade: '™',
  ugrave: 'ù',
  uuml: 'ü',
  Uuml: 'Ü',
};

type ExcerptCandidate = {
  score: number;
  text: string;
};

export function decodeHtml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/giu, (match, entity: string) => {
    if (entity.startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return htmlEntities[entity] ?? htmlEntities[entity.toLowerCase()] ?? match;
  });
}

export function plainText(value: string): string {
  return decodeHtml(value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:style|script|noscript|svg)\b[\s\S]*?<\/(?:style|script|noscript|svg)>/gi, ' ')
    .replace(/<br\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalized(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü]+/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function wordList(value: string): string[] {
  const clean = normalized(value);
  return clean ? clean.split(' ') : [];
}

function cleanExcerpt(value: string): string {
  return plainText(value)
    .replace(/(?:^|\s)-(?:reklam|advertisement)\d*-(?=\s|$)/giu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/\s+(['’])/gu, '$1')
    .replace(/(?:[İIıi]şte o anlar|ayrıntılar için tıklayın|detaylar için tıklayın)\s*[.!…]*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function titleSimilarity(candidateTitle: string, pageTitle: string): number {
  const candidate = normalized(candidateTitle);
  const page = normalized(pageTitle);
  if (!candidate || !page) return 0;
  if (candidate === page) return 1;

  const candidateWords = new Set(candidate.split(' ').filter((word) => word.length >= 3));
  const pageWords = new Set(page.split(' ').filter((word) => word.length >= 3));
  if (candidateWords.size === 0 || pageWords.size === 0) return 0;
  const overlap = Array.from(candidateWords).filter((word) => pageWords.has(word)).length;
  return overlap / Math.max(candidateWords.size, pageWords.size);
}

function titleOverlap(text: string, title: string): number {
  const titleWords = new Set(wordList(title).filter((word) => word.length >= 4));
  const textWords = new Set(wordList(text));
  return Array.from(titleWords).filter((word) => textWords.has(word)).length;
}

function isUsefulExcerpt(text: string, title: string): boolean {
  const words = wordList(text);
  const distinctWords = new Set(words);
  const normalizedTitle = normalized(title);
  const normalizedText = normalized(text);
  const withoutTitle = normalizedTitle
    ? normalizedText.replace(normalizedTitle, ' ').replace(/\s+/gu, ' ').trim()
    : normalizedText;

  return words.length >= 10
    && distinctWords.size >= 8
    && normalizedText !== normalizedTitle
    && wordList(withoutTitle).length >= 4
    && !blockedCopy.test(text);
}

function shortened(value: string): string {
  if (value.length <= 1_800) return value;
  const excerpt = value.slice(0, 1_800);
  const sentenceBoundary = Math.max(
    excerpt.lastIndexOf('. '),
    excerpt.lastIndexOf('! '),
    excerpt.lastIndexOf('? '),
  );
  if (sentenceBoundary >= 1_000) return excerpt.slice(0, sentenceBoundary + 1).trim();
  const wordBoundary = excerpt.lastIndexOf(' ');
  return excerpt.slice(0, wordBoundary > 1_400 ? wordBoundary : 1_800).trim();
}

function structuredCandidates(html: string, title: string): ExcerptCandidate[] {
  const candidates: ExcerptCandidate[] = [];
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  const titleKeys = new Set(['headline', 'name', 'seotitle', 'title']);
  const contentPriority: Record<string, number> = {
    articlebody: 700,
    body: 650,
    content: 600,
    text: 500,
    abstract: 400,
    summary: 300,
    seodescription: 220,
    description: 200,
  };

  function visit(value: unknown, depth = 0): void {
    if (!value || depth > 30) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    const localTitles = entries
      .filter(([key, entry]) => titleKeys.has(key.toLowerCase()) && typeof entry === 'string')
      .map(([, entry]) => entry as string);
    const similarity = localTitles.reduce(
      (best, localTitle) => Math.max(best, titleSimilarity(localTitle, title)),
      0,
    );
    const rawType = record['@type'];
    const types = (Array.isArray(rawType) ? rawType : [rawType])
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.toLowerCase());
    const isArticleType = types.some((type) => type.includes('article') || type === 'videoobject');

    if (similarity >= 0.62 || isArticleType) {
      for (const [key, entry] of entries) {
        const priority = contentPriority[key.toLowerCase()];
        if (!priority || typeof entry !== 'string') continue;
        const text = cleanExcerpt(entry);
        if (!isUsefulExcerpt(text, title)) continue;
        candidates.push({
          text,
          score: 1_500 + priority + similarity * 1_000 + Math.min(wordList(text).length, 220),
        });
      }
    }

    entries.forEach(([, entry]) => visit(entry, depth + 1));
  }

  for (const match of scripts) {
    const attributes = match[1];
    if (!/(?:application\/(?:ld\+)?json|__NEXT_DATA__)/iu.test(attributes)) continue;
    try {
      visit(JSON.parse(match[2]));
    } catch {
      // Invalid or JavaScript-only data blocks are ignored.
    }
  }

  return candidates;
}

function balancedElementInnerHtml(
  html: string,
  openingIndex: number,
  openingTag: string,
  tagName: string,
): string {
  const contentStart = openingIndex + openingTag.length;
  const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'giu');
  tags.lastIndex = contentStart;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (!match[0].endsWith('/>')) depth += 1;
    if (depth === 0) return html.slice(contentStart, match.index);
    if (tags.lastIndex - contentStart > 250_000) break;
  }
  return '';
}

function bodyElementCandidates(html: string, title: string): ExcerptCandidate[] {
  const candidates: ExcerptCandidate[] = [];
  const openingElements = /<(article|div|section)\b[^>]*(?:class|id)\s*=\s*(["'])[^"']*(?:article[-_\s]?body|article[-_\s]?content|news[-_\s]?body|news[-_\s]?content|story[-_\s]?body|entry[-_\s]?content|post[-_\s]?content)[^"']*\2[^>]*>/giu;
  let match: RegExpExecArray | null;
  while ((match = openingElements.exec(html))) {
    const innerHtml = balancedElementInnerHtml(html, match.index, match[0], match[1]);
    const text = cleanExcerpt(innerHtml);
    if (!isUsefulExcerpt(text, title)) continue;
    candidates.push({
      text,
      score: 2_000 + titleOverlap(text, title) * 140 + Math.min(wordList(text).length, 220),
    });
  }
  return candidates;
}

function paragraphCandidates(html: string, title: string): ExcerptCandidate[] {
  const paragraphs = (html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [])
    .slice(0, 160)
    .map((paragraph) => cleanExcerpt(paragraph))
    .filter((paragraph) => paragraph.length >= 20 && !blockedCopy.test(paragraph));
  const candidates: ExcerptCandidate[] = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    let combined = '';
    for (let windowSize = 1; windowSize <= 4 && index + windowSize <= paragraphs.length; windowSize += 1) {
      combined = `${combined} ${paragraphs[index + windowSize - 1]}`.trim();
      if (!isUsefulExcerpt(combined, title)) continue;
      candidates.push({
        text: combined,
        score: 500
          + Math.min(combined.length, 1_000)
          + titleOverlap(combined, title) * 140
          - index * 2,
      });
    }
  }
  return candidates;
}

export function extractArticleExcerpt(html: string, title: string): string {
  const candidates = [
    ...structuredCandidates(html, title),
    ...bodyElementCandidates(html, title),
    ...paragraphCandidates(html, title),
  ].sort((left, right) => right.score - left.score);

  return shortened(candidates[0]?.text || '');
}
