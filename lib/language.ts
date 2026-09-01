import { franc } from 'franc-min';

export type PublicationLanguage = 'tr' | 'en';

const nonLatinScript = /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const turkishCharacters = /[çğıöşüÇĞİÖŞÜ]/;
const turkishWords = /\b(ve|ile|için|bir|bu|şu|sonra|önce|bugün|yarın|olarak|olan|oldu|olacak|dedi|yeni|son|maçı|haber|türkiye|türk|dünya|başladı|açıkladı)\b/gi;
const englishWords = /\b(the|and|for|with|from|after|before|today|will|has|have|was|were|are|is|new|says|over|into|against|breaking|news|turkey|turkish)\b/gi;
const knownTurkishSources = /\b(hürriyet|milliyet|habertürk|sözcü|ntv|trt|meb|anadolu|cnn türk|dünya|sabah|haberler|cumhuriyet|birgün|karar|t24|gazete|bbc türkçe|dw türkçe|dw|deutsche welle)\b/i;
const knownEnglishSources = /\b(reuters|associated press|bbc|guardian|cnn|euronews|al jazeera|independent|times|bloomberg|cnbc|abc news|cbs news|nbc news|sky news)\b/i;

export function containsUnsupportedScript(value: string): boolean {
  return nonLatinScript.test(value);
}

function matches(regex: RegExp, value: string): number {
  return value.match(regex)?.length ?? 0;
}

export function isLanguageMatch(
  value: string,
  language: PublicationLanguage,
  sourceName = '',
): boolean {
  const clean = value.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length < 8 || containsUnsupportedScript(clean)) return false;

  const detected = franc(clean, { minLength: 12 });
  if (language === 'tr') {
    if (detected === 'tur') return true;
    if (turkishCharacters.test(clean) && matches(turkishWords, clean) >= 1) return true;
    if (matches(turkishWords, clean) >= 2) return true;
    return knownTurkishSources.test(sourceName) && !matches(englishWords, clean);
  }

  if (turkishCharacters.test(clean)) return false;
  if (detected === 'eng') return true;
  if (matches(englishWords, clean) >= 2) return true;
  return knownEnglishSources.test(sourceName) && matches(englishWords, clean) >= 1;
}
