function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceVariants(sourceName: string): string[] {
  const clean = sourceName.replace(/^https?:\/\//iu, '').replace(/^www\./iu, '').trim();
  const bareDomain = clean.replace(/\.(?:com|net|org|gov|edu)(?:\.tr)?$/iu, '');
  const sourceWords = clean.split(/\s+/u).filter(Boolean);
  const leadingName = sourceWords.length >= 3 ? sourceWords.slice(0, -1).join(' ') : '';
  const normalizedSource = normalizeCopy(clean);
  const knownAliases: Record<string, string[]> = {
    aa: ['Anadolu Ajansı'],
    dha: ['Demirören Haber Ajansı'],
    iha: ['İhlas Haber Ajansı'],
    meb: [
      'Millî Eğitim Bakanlığı',
      'Milli Eğitim Bakanlığı',
      'Millî Eğitim Bakanlığınca',
      'Milli Eğitim Bakanlığınca',
    ],
  };
  return Array.from(new Set([
    sourceName.trim(),
    clean,
    bareDomain,
    leadingName,
    ...(knownAliases[normalizedSource] ?? []),
  ]))
    .filter((value) => value.length >= 3)
    .sort((left, right) => right.length - left.length);
}

export function normalizeCopy(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü]+/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function stripSourceAttribution(value: string, sourceName: string): string {
  let output = value;
  for (const variant of sourceVariants(sourceName)) {
    output = output.replace(new RegExp(escapeRegExp(variant), 'giu'), ' ');
  }
  return output
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/^[\s\-–—|·,:]+|[\s\-–—|·,:]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function containsSourceAttribution(value: string, sourceName: string): boolean {
  const normalizedValue = ` ${normalizeCopy(value)} `;
  return sourceVariants(sourceName).some((variant) => {
    const normalizedVariant = normalizeCopy(variant);
    return normalizedVariant.length >= 3 && normalizedValue.includes(` ${normalizedVariant} `);
  });
}

export function containsPublisherLanguage(value: string): boolean {
  const normalized = normalizeCopy(value);
  const padded = ` ${normalized} `;
  const publisherPhrases = [
    'haber ajansi',
    'haber ajansı',
    'haber sitesi',
    'gazetesi',
    'news agency',
    'news outlet',
    'newspaper',
    'according to',
    'reported by',
  ];
  return publisherPhrases.some((phrase) => padded.includes(` ${phrase} `))
    || /\b(?:https?|www|com tr|com|net tr|net|org tr|org)\b/u.test(normalized);
}

const danglingEndings = new Set([
  'a',
  'an',
  'and',
  'as',
  'because',
  'before',
  'bir',
  'bu',
  'by',
  'çünkü',
  'da',
  'de',
  'due',
  'fakat',
  'for',
  'from',
  'gibi',
  'hakkında',
  'için',
  'ile',
  'ilgili',
  'ilişkin',
  'ise',
  'ki',
  'nedeniyle',
  'of',
  'olan',
  'olarak',
  'olduğu',
  'olduğunu',
  'olacağını',
  'or',
  'önce',
  'sonra',
  'şu',
  'the',
  'to',
  've',
  'veya',
  'while',
  'with',
]);

export function hasIncompleteEnding(value: string): boolean {
  const clean = value.replace(/\s+/gu, ' ').trim();
  if (!clean) return true;
  const straightQuotes = clean.match(/"/gu)?.length || 0;
  const openingQuotes = clean.match(/“/gu)?.length || 0;
  const closingQuotes = clean.match(/”/gu)?.length || 0;
  if (straightQuotes % 2 !== 0 || openingQuotes !== closingQuotes) return true;
  if (/(?:\.{2,}|…)["'”’)]?$/u.test(clean)) return true;
  if (/[,;:–—-]["'”’)]?$/u.test(clean)) return true;
  const tokens = normalizeCopy(clean).split(' ').filter(Boolean);
  const lastToken = tokens.at(-1) || '';
  return danglingEndings.has(lastToken)
    || /(?:dıgı|digi|dugu|tigi|tıgı|tugu)$/u.test(lastToken);
}

export function hasCompleteSentenceEnding(value: string): boolean {
  return /[.!?]["'”’)]?$/u.test(value.trim());
}

export function containsTeaserLanguage(value: string): boolean {
  const normalized = ` ${normalizeCopy(value)} `;
  const phrases = [
    'acıklama geldi',
    'detaylar belli oldu',
    'detaylar ortaya cıktı',
    'gundem oldu',
    'iste detaylar',
    'merak konusu oldu',
    'soke etti',
    'details emerged',
    'here are the details',
    'here is what happened',
    'shocked everyone',
  ];
  return phrases.some((phrase) => normalized.includes(` ${phrase} `));
}

export function completeExcerpt(value: string, preferredLimit: number): string {
  const clean = value.replace(/\s+/gu, ' ').trim();
  if (clean.length <= preferredLimit) return clean;

  const findLastCompleteBoundary = (text: string): number => {
    const expression = /[.!?](?:["”’)])?(?=\s|$)/gu;
    let boundary = -1;
    for (const match of text.matchAll(expression)) {
      boundary = (match.index || 0) + match[0].length;
    }
    return boundary;
  };

  const withinLimit = clean.slice(0, preferredLimit + 1);
  const boundary = findLastCompleteBoundary(withinLimit);
  if (boundary >= Math.min(80, Math.floor(preferredLimit * 0.4))) {
    return withinLimit.slice(0, boundary).trim();
  }

  const extended = clean.slice(0, preferredLimit + 160);
  const nextBoundary = findLastCompleteBoundary(extended);
  if (nextBoundary > preferredLimit) return extended.slice(0, nextBoundary).trim();

  // A full long sentence is safer than publishing a visibly truncated claim.
  return clean;
}

function words(value: string): string[] {
  const normalized = normalizeCopy(value);
  return normalized ? normalized.split(' ') : [];
}

export function hasRepeatedPhrase(value: string, phraseLength = 4): boolean {
  const tokens = words(value);
  const seen = new Set<string>();
  for (let index = 0; index <= tokens.length - phraseLength; index += 1) {
    const phrase = tokens.slice(index, index + phraseLength).join(' ');
    if (seen.has(phrase)) return true;
    seen.add(phrase);
  }
  return false;
}

export function sharesPhrase(left: string, right: string, phraseLength = 8): boolean {
  const leftWords = words(left);
  const rightText = ` ${words(right).join(' ')} `;
  for (let index = 0; index <= leftWords.length - phraseLength; index += 1) {
    const phrase = leftWords.slice(index, index + phraseLength).join(' ');
    if (rightText.includes(` ${phrase} `)) return true;
  }
  return false;
}

export function hasSufficientSourceDetail(title: string, summary: string): boolean {
  const normalizedTitle = normalizeCopy(title);
  const normalizedSummary = normalizeCopy(summary);
  const summaryWords = words(summary);
  const distinctWords = new Set(summaryWords);
  const extraText = normalizedTitle
    ? normalizedSummary.replace(normalizedTitle, ' ').replace(/\s+/gu, ' ').trim()
    : normalizedSummary;
  const extraWords = extraText ? extraText.split(' ') : [];

  return summaryWords.length >= 14
    && distinctWords.size >= 10
    && normalizedSummary !== normalizedTitle
    && extraWords.length >= 7;
}
