import type { Channel } from '@/lib/content';
import {
  containsBareDeathWord,
  containsTeaserLanguage,
  containsPublisherLanguage,
  containsSourceAttribution,
  forbiddenWordIn,
  hasCompleteSentenceEnding,
  hasIncompleteEnding,
  hasRepeatedPhrase,
  maskDeathWords,
  sharesPhrase,
  stripSourceAttribution,
} from '@/lib/copy-guard';
import { isLanguageMatch } from '@/lib/language';
import { copyDeskPrompt, historyVisualInstructions } from '@/lib/prompts';

// Kural sabitleri burada; talimat metni config/ai-prompts.json içinde durur.
// Metin kalitesi kuralları burada değişmez; Groq ve OpenAI aynı talimatı alır.
export const coverMinimumWords = 3;
export const coverMaximumWords = 15;
export const coverMaximumCharacters = 105;
export const visualMinimumWords = 12;
export const visualMaximumWords = 36;
export const captionMinimumWords = 50;
export const captionMaximumWords = 95;
export const visualTargetWords = 23;
export const captionTargetWords = 74;
export const hashtagCount = 5;
// Konuya özel etiket tek başına erişim getirmiyor; her gönderide en az iki tanesi
// Instagram'da en çok kullanılan geniş erişimli etiketlerden olur.
export const reachHashtagMinimum = 2;
export const topicHashtagCount = hashtagCount - reachHashtagMinimum;

// Kanal başına Instagram'da yüksek kullanım hacmine sahip etiketler. Havuz genişçe tutulur ve
// seçim her gönderide karıştırılır (bkz. withReachHashtags); aksi halde günde 5-6 gönderiyle aynı
// hesap aynı iki etiketi yüzlerce kez tekrarlar, bu da tekrarlayan/spam benzeri içerik sinyali olur.
const reachHashtagsByChannel: Record<Channel, readonly string[]> = {
  news: [
    '#sondakika', '#haber', '#gündem', '#türkiye', '#haberler',
    '#günün haberleri', '#haberturk', '#sondakikahaber',
  ],
  media: [
    '#keşfet', '#gündem', '#haber', '#türkiye', '#sondakika',
    '#viral', '#keşfetteyiz', '#trend',
  ],
  history: [
    '#tarih', '#keşfet', '#tarihtebugün', '#bilgi', '#türkiye',
    '#tarihibilgiler', '#genelkültür', '#tarihaşkı',
  ],
  international: [
    '#news', '#breakingnews', '#worldnews', '#globalnews', '#today',
    '#worldnewstoday', '#currentaffairs', '#explore',
  ],
};

// Basit, bağımlılıksız bir Fisher-Yates: her çağrıda etiket seçimi değişsin diye.
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function reachHashtags(channel: Channel): readonly string[] {
  return reachHashtagsByChannel[channel] ?? reachHashtagsByChannel.news;
}

export type GeneratedCopy = {
  coverTitle: string;
  visualText: string;
  caption: string;
  hashtags: string[];
};

export type GeneratedWordArrays = {
  coverWords: string[];
  visualWords: string[];
  captionWords: string[];
  hashtagWords: string[];
};

export function limitedText(value: unknown, maximumLength: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim().slice(0, maximumLength)
    : '';
}

export function wordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

// Modeller ara sıra birden fazla kelimeyi tek dizi öğesine yapıştırıyor
// ("edildi.Şimdilik", "AnkaraBüyükşehirBelediyesi"). Marka yazımlarını (iPhone, YouTube)
// bozmamak için yalnızca noktalama sonrası ve en az üç küçük harften sonra ayır.
function splitGluedWords(word: string): string {
  return word
    .replace(/([.,!?:;])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Ll}{3,})(\p{Lu})/gu, '$1 $2');
}

// Model "# Ankara", "ankara!" gibi varyantlar döndürebiliyor; tek kelimeye indirger.
function normalizeHashtag(word: string): string {
  const clean = limitedText(word, 60)
    .replace(/\s+/gu, '')
    .replace(/^#+/u, '')
    .replace(/[^\p{L}\p{N}_]/gu, '');
  return clean ? `#${clean}` : '';
}

function hashtagList(words: readonly string[]): string[] {
  const tags: string[] = [];
  for (const word of words) {
    const tag = normalizeHashtag(word);
    const key = tag.toLocaleLowerCase('tr-TR');
    if (tag && !tags.some((existing) => existing.toLocaleLowerCase('tr-TR') === key)) {
      tags.push(tag);
    }
  }
  return tags;
}

/** Etiketler açıklamanın sonuna ayrı bir satırda eklenir. */
export function captionWithHashtags(copy: GeneratedCopy): string {
  return copy.hashtags.length ? `${copy.caption}\n\n${copy.hashtags.join(' ')}` : copy.caption;
}

export function copyFromWordArrays(parsed: Partial<GeneratedWordArrays>): GeneratedCopy | null {
  if (
    !Array.isArray(parsed.coverWords)
    || !Array.isArray(parsed.visualWords)
    || !Array.isArray(parsed.captionWords)
    || !Array.isArray(parsed.hashtagWords)
  ) return null;
  const coverTitle = parsed.coverWords
    .map((word) => limitedText(splitGluedWords(word), 80))
    .filter(Boolean)
    .join(' ');
  const visualText = parsed.visualWords
    .map((word) => limitedText(splitGluedWords(word), 80))
    .filter(Boolean)
    .join(' ');
  const caption = parsed.captionWords
    .map((word) => limitedText(splitGluedWords(word), 80))
    .filter(Boolean)
    .join(' ');
  const hashtags = hashtagList(parsed.hashtagWords);
  return coverTitle && visualText && caption
    ? { coverTitle, visualText, caption, hashtags }
    : null;
}

const hashtagKey = (tag: string): string => tag.toLocaleLowerCase('tr-TR');

/**
 * Konu etiketlerini korur, listeyi kanalın yüksek erişimli etiketleriyle tamamlar.
 * Modelin ne döndürdüğünden bağımsız çalışır; dört sağlayıcı da aynı karışımı verir.
 */
function withReachHashtags(tags: readonly string[], channel: Channel): string[] {
  const pool = shuffled(reachHashtags(channel));
  const poolKeys = new Set(pool.map(hashtagKey));
  const topic = tags.filter((tag) => !poolKeys.has(hashtagKey(tag)));
  const popular = tags.filter((tag) => poolKeys.has(hashtagKey(tag)));
  for (const tag of pool) {
    if (popular.length >= reachHashtagMinimum) break;
    if (!popular.some((existing) => hashtagKey(existing) === hashtagKey(tag))) popular.push(tag);
  }
  const merged = [...topic.slice(0, Math.max(0, hashtagCount - popular.length)), ...popular];
  // Model az etiket döndürdüyse boşluk yine havuzdan kapatılır; sayı hep hashtagCount.
  for (const tag of pool) {
    if (merged.length >= hashtagCount) break;
    if (!merged.some((existing) => hashtagKey(existing) === hashtagKey(tag))) merged.push(tag);
  }
  return merged.slice(0, hashtagCount);
}

export function sanitizeGeneratedCopy(
  copy: GeneratedCopy,
  sourceName: string,
  channel: Channel,
): GeneratedCopy {
  return {
    coverTitle: maskDeathWords(stripSourceAttribution(copy.coverTitle, sourceName)),
    visualText: maskDeathWords(stripSourceAttribution(copy.visualText, sourceName)),
    caption: maskDeathWords(stripSourceAttribution(copy.caption, sourceName)),
    // Kaynak adını ya da maskelenemeyen "ölüm" kelimesini taşıyan etiket atılır;
    // eksilen yer kanalın yüksek erişimli etiketinden tamamlanır.
    hashtags: withReachHashtags(
      copy.hashtags.filter((tag) => (
        !containsSourceAttribution(tag, sourceName) && !containsBareDeathWord(tag)
      )),
      channel,
    ),
  };
}

export function validationIssue(copy: GeneratedCopy, channel: Channel, sourceName: string): string {
  const coverWords = wordCount(copy.coverTitle);
  const visualWords = wordCount(copy.visualText);
  const captionWords = wordCount(copy.caption);
  if (
    coverWords < coverMinimumWords
    || coverWords > coverMaximumWords
    || copy.coverTitle.length > coverMaximumCharacters
  ) {
    return `coverTitle has ${coverWords} words and ${copy.coverTitle.length} characters; it must have ${coverMinimumWords}-${coverMaximumWords} words and at most ${coverMaximumCharacters} characters`;
  }
  if (visualWords < visualMinimumWords || visualWords > visualMaximumWords) {
    return `visualText has ${visualWords} words; it must have ${visualMinimumWords}-${visualMaximumWords}`;
  }
  if (captionWords < captionMinimumWords || captionWords > captionMaximumWords) {
    return `caption has ${captionWords} words; it must have ${captionMinimumWords}-${captionMaximumWords}`;
  }
  const forbiddenWord = forbiddenWordIn(
    `${copy.coverTitle} ${copy.visualText} ${copy.caption} ${copy.hashtags.join(' ')}`,
  );
  if (forbiddenWord) {
    return `the word "${forbiddenWord}" is forbidden; never use yaratmak, mucit, icat or any word derived from them in any field`;
  }
  if (containsBareDeathWord(`${copy.coverTitle} ${copy.visualText} ${copy.caption}`)) {
    return 'the words ölüm and ölü must never appear in plain form; write them masked as ö*üm and *lü, and only when the fact truly requires them';
  }
  if (
    copy.hashtags.length !== hashtagCount
    || copy.hashtags.some((tag) => !/^#[\p{L}\p{N}_]+$/u.test(tag))
  ) {
    return `hashtags must contain exactly ${hashtagCount} distinct topic hashtags; each one is a single word starting with # and must not name a publisher or source`;
  }
  if (copy.hashtags.filter((tag) => (
    reachHashtags(channel).some((popular) => hashtagKey(popular) === hashtagKey(tag))
  )).length < reachHashtagMinimum) {
    return `at least ${reachHashtagMinimum} hashtags must be high-reach tags that Instagram audiences already follow, taken from ${reachHashtags(channel).join(' ')}`;
  }
  if (
    containsSourceAttribution(`${copy.coverTitle} ${copy.visualText} ${copy.caption}`, sourceName)
    || containsPublisherLanguage(`${copy.coverTitle} ${copy.visualText} ${copy.caption}`)
  ) {
    return 'publisher, news agency, website, outlet, or source attribution must never appear';
  }
  if (hasRepeatedPhrase(copy.visualText, 4) || hasRepeatedPhrase(copy.caption, 5)) {
    return 'a sentence, claim, or phrase is repeated; every sentence must add distinct information';
  }
  if (
    hasIncompleteEnding(copy.coverTitle)
    || hasIncompleteEnding(copy.visualText)
    || hasIncompleteEnding(copy.caption)
    || !hasCompleteSentenceEnding(copy.visualText)
    || !hasCompleteSentenceEnding(copy.caption)
  ) {
    return 'coverTitle, visualText, and caption must contain complete standalone claims; visualText and caption must end with sentence punctuation';
  }
  if (containsTeaserLanguage(`${copy.coverTitle} ${copy.visualText} ${copy.caption}`)) {
    return 'teaser or vague continuation language is forbidden; state the concrete event and outcome';
  }
  if (sharesPhrase(copy.visualText, copy.caption, 8)) {
    return 'caption copies the visual text too closely; it must add distinct detail without repeating the same sentence';
  }
  const expectedLanguage = channel === 'international' ? 'en' : 'tr';
  if (!isLanguageMatch(`${copy.coverTitle} ${copy.visualText} ${copy.caption}`, expectedLanguage)) {
    return channel === 'international'
      ? 'both fields must be written only in English'
      : 'both fields must be written only in Turkish';
  }
  return '';
}

export function buildCopyInstructions(channel: Channel, correction = ''): string {
  return copyDeskPrompt({
    language: channel === 'international' ? 'English' : 'Turkish',
    coverMinimumWords,
    coverMaximumWords,
    coverMaximumCharacters,
    visualMinimumWords,
    visualMaximumWords,
    visualTargetWords,
    captionMinimumWords,
    captionMaximumWords,
    captionTargetWords,
    hashtagCount,
    topicHashtagCount,
    reachHashtagMinimum,
    reachHashtagExamples: reachHashtags(channel).join(', '),
  }, correction, channel === 'history' ? historyVisualInstructions() : []);
}

// json_schema gövdesi: OpenAI'de text.format.schema, Groq'ta response_format.json_schema.schema.
export const copyJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    coverWords: {
      type: 'array',
      minItems: coverMinimumWords,
      maxItems: coverMaximumWords,
      items: { type: 'string', pattern: '^\\S+$' },
    },
    visualWords: {
      type: 'array',
      minItems: visualMinimumWords,
      maxItems: visualMaximumWords,
      items: { type: 'string', pattern: '^\\S+$' },
    },
    captionWords: {
      type: 'array',
      minItems: captionMinimumWords,
      maxItems: captionMaximumWords,
      items: { type: 'string', pattern: '^\\S+$' },
    },
    hashtagWords: {
      type: 'array',
      minItems: hashtagCount,
      maxItems: hashtagCount,
      items: { type: 'string', pattern: '^#[^\\s#]+$' },
    },
  },
  required: ['coverWords', 'visualWords', 'captionWords', 'hashtagWords'],
} as const;
