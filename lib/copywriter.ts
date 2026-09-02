import type { Channel } from '@/lib/content';
import {
  containsTeaserLanguage,
  containsPublisherLanguage,
  containsSourceAttribution,
  forbiddenWordIn,
  hasCompleteSentenceEnding,
  hasIncompleteEnding,
  hasRepeatedPhrase,
  sharesPhrase,
  stripSourceAttribution,
} from '@/lib/copy-guard';
import { isLanguageMatch } from '@/lib/language';
import { copyDeskPrompt } from '@/lib/prompts';

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

export function sanitizeGeneratedCopy(copy: GeneratedCopy, sourceName: string): GeneratedCopy {
  return {
    coverTitle: stripSourceAttribution(copy.coverTitle, sourceName),
    visualText: stripSourceAttribution(copy.visualText, sourceName),
    caption: stripSourceAttribution(copy.caption, sourceName),
    // Kaynak adını etikete çeviren yanıtlar eksik kalır ve doğrulamada düzeltmeye gider.
    hashtags: copy.hashtags.filter((tag) => !containsSourceAttribution(tag, sourceName)),
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
  if (
    copy.hashtags.length !== hashtagCount
    || copy.hashtags.some((tag) => !/^#[\p{L}\p{N}_]+$/u.test(tag))
  ) {
    return `hashtags must contain exactly ${hashtagCount} distinct topic hashtags; each one is a single word starting with # and must not name a publisher or source`;
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
  }, correction);
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
