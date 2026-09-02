import type {
  CandidateLocation,
  CandidateScore,
  CandidateVerification,
  Channel,
  ContentCandidate,
  FreshnessStatus,
} from '@/lib/content';
import { conflictNote, findConflicts } from '@/lib/cross-check';
import { registryTrust } from '@/lib/discovery/sources/registry';

const TURKEY_CITIES = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Aksaray', 'Amasya', 'Ankara', 'Antalya',
  'Ardahan', 'Artvin', 'Aydın', 'Balıkesir', 'Bartın', 'Batman', 'Bayburt', 'Bilecik',
  'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum', 'Denizli',
  'Diyarbakır', 'Düzce', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep',
  'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Iğdır', 'Isparta', 'İstanbul', 'İzmir',
  'Kahramanmaraş', 'Karabük', 'Karaman', 'Kars', 'Kastamonu', 'Kayseri', 'Kırıkkale',
  'Kırklareli', 'Kırşehir', 'Kilis', 'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa',
  'Mardin', 'Mersin', 'Muğla', 'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Osmaniye', 'Rize',
  'Sakarya', 'Samsun', 'Siirt', 'Sinop', 'Sivas', 'Şanlıurfa', 'Şırnak', 'Tekirdağ',
  'Tokat', 'Trabzon', 'Tunceli', 'Uşak', 'Van', 'Yalova', 'Yozgat', 'Zonguldak',
] as const;

const CITY_ALIASES: Record<string, string> = {
  afyon: 'Afyonkarahisar',
  antep: 'Gaziantep',
  'antep ': 'Gaziantep',
  'maraş': 'Kahramanmaraş',
  'urfa': 'Şanlıurfa',
  'izmit': 'Kocaeli',
};

const TURKEY_HINTS = /\b(türkiye|türk|tbmm|bakanlık|valiliği|belediyesi|kaymakamlığı)\b/iu;
const CYPRUS_HINTS = /\b(kıbrıs|girne|lefkoşa|gazimağusa|güzelyurt|iskele)\b/iu;

export function istanbulDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function istanbulNowDate(): string {
  return istanbulDate(new Date());
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isTodayIstanbul(value: string, now: Date | string = new Date()): boolean {
  const parsed = parseDate(value);
  if (!parsed) return false;
  return istanbulDate(parsed) === istanbulDate(now instanceof Date ? now : new Date(now));
}

export function isRecentHours(
  value: string,
  hours: number,
  now: Date | string = new Date(),
): boolean {
  const parsed = parseDate(value);
  if (!parsed) return false;
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const delta = current - parsed.getTime();
  const limitMs = hours * 60 * 60_000;
  return Number.isFinite(delta) && delta >= 0 && delta <= limitMs;
}

export function freshnessFor(
  publishedAt: string,
  modifiedAt = '',
  now = new Date(),
): FreshnessStatus {
  const today = istanbulDate(now);
  if (publishedAt && istanbulDate(publishedAt) === today) return 'today';
  if (modifiedAt && istanbulDate(modifiedAt) === today) return 'updated-today';
  if (publishedAt || modifiedAt) return 'stale';
  return 'unverified';
}

export function normalizeNewsText(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9çğıöşü]+/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tokens(value: string): Set<string> {
  const stop = new Set([
    've', 'ile', 'bir', 'bu', 'da', 'de', 'için', 'son', 'yeni', 'the', 'and', 'for', 'from',
    'that', 'this', 'after', 'news', 'haber', 'bugün', 'today',
  ]);
  return new Set(normalizeNewsText(value).split(' ').filter((word) => word.length >= 3 && !stop.has(word)));
}

export function titleSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((word) => { if (b.has(word)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function clusterCandidates(candidates: ContentCandidate[]): ContentCandidate[] {
  const clusters: Array<{ id: string; representatives: string[]; indexes: number[] }> = [];

  candidates.forEach((candidate, index) => {
    const match = clusters.find((cluster) => (
      cluster.representatives.some((title) => titleSimilarity(title, candidate.title) >= 0.58)
    ));
    if (match) {
      match.representatives.push(candidate.title);
      match.indexes.push(index);
    } else {
      clusters.push({
        id: `event-${stableHash(`${istanbulDate(candidate.publishedAt)}:${normalizeNewsText(candidate.title)}`)}`,
        representatives: [candidate.title],
        indexes: [index],
      });
    }
  });

  const byIndex = new Map<number, { clusterId: string; verification: CandidateVerification }>();
  clusters.forEach((cluster) => {
    const sourceNames = Array.from(new Set(cluster.indexes.map((index) => candidates[index].sourceName))).filter(Boolean);
    // Aynı olayı veren kaynaklar sayı ya da yer konusunda ayrışıyorsa haber doğrulanmış sayılmaz.
    const conflicts = findConflicts(cluster.indexes.map((index) => candidates[index]));
    const corroborated = sourceNames.length >= 2;
    const verification: CandidateVerification = {
      status: conflicts.length > 0 ? 'conflict' : corroborated ? 'corroborated' : 'single-source',
      sourceCount: sourceNames.length,
      sourceNames,
      checkedAt: new Date().toISOString(),
      notes: conflicts.length > 0
        ? ['Kaynaklar aynı olayda farklı bilgi veriyor; yayından önce doğrulayın.', ...conflicts.map(conflictNote)]
        : corroborated
          ? ['Benzer olay birden fazla bağımsız kaynakta bulundu.']
          : ['Şimdilik yalnızca tek kaynakta bulundu; editör kontrolü gerekli.'],
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
    cluster.indexes.forEach((index) => byIndex.set(index, { clusterId: cluster.id, verification }));
  });

  return candidates.map((candidate, index) => ({
    ...candidate,
    clusterId: byIndex.get(index)?.clusterId,
    verification: byIndex.get(index)?.verification,
  }));
}

function containsNormalized(haystack: string, needle: string): boolean {
  const pattern = new RegExp(`(?:^|\\s)${normalizeNewsText(needle).replace(/\s+/gu, '\\s+')}(?:$|\\s)`, 'u');
  return pattern.test(normalizeNewsText(haystack));
}

export function detectLocation(title: string, summary: string, channel: Channel): CandidateLocation | null {
  const evidence = `${title} ${summary}`;
  const city = TURKEY_CITIES.find((name) => containsNormalized(evidence, name))
    || Object.entries(CITY_ALIASES).find(([alias]) => containsNormalized(evidence, alias))?.[1]
    || '';
  if (city) {
    return {
      city,
      country: 'Türkiye',
      label: city,
      confidence: 0.9,
      method: 'rules',
    };
  }
  if (CYPRUS_HINTS.test(evidence)) {
    const cyprusCity = ['Girne', 'Lefkoşa', 'Gazimağusa', 'Güzelyurt', 'İskele']
      .find((name) => containsNormalized(evidence, name)) || '';
    return {
      city: cyprusCity,
      country: 'Kuzey Kıbrıs Türk Cumhuriyeti',
      label: cyprusCity ? `${cyprusCity}, KKTC` : 'KKTC',
      confidence: cyprusCity ? 0.9 : 0.78,
      method: 'rules',
    };
  }
  if ((channel === 'news' || channel === 'media') && TURKEY_HINTS.test(evidence)) {
    return {
      city: '',
      country: 'Türkiye',
      label: 'Türkiye',
      confidence: 0.72,
      method: 'rules',
    };
  }
  return null;
}

export function sourceTrust(sourceName: string, sourceUrl: string, sourceType: ContentCandidate['sourceType']): number {
  if (sourceType === 'official' || /\.gov\.tr(?:\/|$)/iu.test(sourceUrl)) return 15;
  if (sourceType === 'encyclopedia') return 10;
  // `config/news-sources.json` içindeki 0-100 puanı, buradaki 0-15 ölçeğine taşınır.
  const registered = registryTrust(sourceName, sourceUrl);
  if (registered !== undefined) {
    return Math.max(5, Math.min(15, Math.round(7 + (registered - 55) * 0.175)));
  }
  if (/\b(trt haber|anadolu ajansı|bbc|reuters|associated press|ap news)\b/iu.test(sourceName)) return 13;
  if (sourceType === 'publisher') return 11;
  if (sourceType === 'trend') return 8;
  if (sourceType === 'aggregator') return 7;
  return 6;
}

// \b Türkçe diakritiklerde güvenilmez (ASCII tabanlı); Unicode harf sınırları kullanılır.
const HIGH_IMPACT_PATTERN = /(?<![\p{L}\d])(son dakika|asgari ücret\p{L}*|merkez bankas\p{L}*|hayatını kaybet\p{L}*|iptal edil\p{L}*|karar\p{L}*|yasa\p{L}*|kanun\p{L}*|yönetmelik\p{L}*|faiz\p{L}*|enflasyon\p{L}*|deprem\p{L}*|sel|yangın\p{L}*|saldırı\p{L}*|savaş\p{L}*|patlama\p{L}*|çatışma\p{L}*|grev\p{L}*|zam|zaml\p{L}+|kabine\p{L}*|ölü\p{L}*|öldü\p{L}*|ölen|tahliye\p{L}*|tutukland\p{L}*|istifa\p{L}*|seçim\p{L}*|kriz\p{L}*|acil\p{L}*|rekor\p{L}*)(?![\p{L}\d])/iu;

// Sayısal büyüklük/sonuç işaretleri: can kaybı, oran, para tutarı, deprem büyüklüğü.
const MAGNITUDE_PATTERN = /(\d+\s*(ölü|yaralı|kayıp|gözaltı|tutuklama)(?!\p{L})|%\s?\d+|\d+\s?(baz puan|puan)(?!\p{L})|\d+(?:[.,]\d+)?\s*(milyar|milyon|bin)?\s*(tl|lira|dolar|euro)(?!\p{L})|\d(?:[.,]\d)?\s*büyüklüğünde)/iu;

const CLICKBAIT_PATTERN = /(?<![\p{L}\d])(şok\p{L}*|inanılmaz|bomba gibi|görenler\p{L}*|akılalmaz|damga vurdu|dikkat çekti|sosyal medyada gündem\p{L}*|viral\p{L}*|bakın ne)(?![\p{L}\d])/iu;

export function hasHighImpactSignal(evidence: string): boolean {
  return HIGH_IMPACT_PATTERN.test(evidence) || MAGNITUDE_PATTERN.test(evidence);
}

export function scoreCandidate(candidate: ContentCandidate, channel: Channel): CandidateScore {
  const evidence = `${candidate.title} ${candidate.summary}`;
  const highImpactSignal = hasHighImpactSignal(evidence);
  const magnitudeSignal = MAGNITUDE_PATTERN.test(evidence);
  const clickbaitSignal = CLICKBAIT_PATTERN.test(evidence);
  const routineAnnouncement = /\b(kutladı|kutlama|tebrik|mesajı|hayırlı olsun|başarılar diledi|bereketli seferler|ziyaret etti|kabul etti)\b/iu.test(evidence)
    && !highImpactSignal;
  const verificationCount = candidate.verification?.sourceCount ?? 1;
  const freshness = candidate.freshnessStatus === 'today'
    ? 20
    : candidate.freshnessStatus === 'updated-today' ? 16 : 0;
  const trust = sourceTrust(candidate.sourceName, candidate.sourceUrl, candidate.sourceType);
  const crossSource = Math.min(15, verificationCount <= 1 ? 2 : 8 + (verificationCount - 2) * 3);
  const trend = channel === 'history'
    ? Math.min(20, Math.max(1, Math.round((candidate.score - 48) / 2.2)))
    : candidate.kind === 'trend'
      ? Math.min(20, Math.max(8, candidate.score - 70))
      : (highImpactSignal ? 10 : 3) + (magnitudeSignal ? 2 : 0);
  const location = candidate.location;
  const channelFit = channel === 'international'
    ? 17
    : channel === 'history' ? 20 : location?.country === 'Türkiye' ? 20 : location ? 14 : 12;
  const imageReadiness = candidate.imageUrl ? 5 : 0;
  const novelty = routineAnnouncement
    ? -12
    : clickbaitSignal && !highImpactSignal
      ? -8
      : highImpactSignal ? 5 : 3;
  const total = Math.min(100, freshness + trust + crossSource + trend + channelFit + imageReadiness + novelty);
  return {
    total,
    freshness,
    sourceTrust: trust,
    crossSource,
    trend,
    channelFit,
    imageReadiness,
    novelty,
  };
}

export function enrichIntelligence(candidates: ContentCandidate[], channel: Channel): ContentCandidate[] {
  const clustered = clusterCandidates(candidates.map((candidate) => {
    const freshnessStatus = candidate.freshnessStatus
      || freshnessFor(candidate.canonicalPublishedAt || candidate.publishedAt, candidate.canonicalModifiedAt);
    const location = candidate.location ?? detectLocation(candidate.title, candidate.summary, channel);
    return {
      ...candidate,
      freshnessStatus,
      location,
      discoveredAt: candidate.discoveredAt || new Date().toISOString(),
    };
  }));

  return clustered.map((candidate) => {
    const scoreBreakdown = scoreCandidate(candidate, channel);
    // Son dakika: akış kaynağı işaretlediyse ya da yüksek etkili + en az 2 kaynak + bugünse.
    const breaking = candidate.breaking === true || (
      hasHighImpactSignal(`${candidate.title} ${candidate.summary}`)
      && (candidate.verification?.sourceCount ?? 1) >= 2
      && candidate.freshnessStatus === 'today'
    );
    if (breaking) scoreBreakdown.total = Math.max(scoreBreakdown.total, 88);
    const readinessIssues = [
      candidate.freshnessStatus === 'unverified' ? 'Yayın tarihi doğrulanmadı.' : '',
      candidate.freshnessStatus === 'stale' ? 'Kaynak sayfası bugüne ait değil.' : '',
      !candidate.imageUrl ? 'Görsel henüz bulunamadı.' : '',
      !candidate.location && channel !== 'history' ? 'Konum henüz doğrulanmadı.' : '',
      candidate.verification?.status === 'single-source' ? 'İkinci bağımsız kaynak bulunamadı.' : '',
      candidate.verification?.status === 'conflict' ? 'Kaynaklar çelişiyor; bilgiyi teyit edin.' : '',
    ].filter(Boolean);
    return {
      ...candidate,
      breaking,
      score: scoreBreakdown.total,
      scoreBreakdown,
      sourceTrust: scoreBreakdown.sourceTrust,
      readinessIssues,
    };
  });
}

function trustRank(candidate: ContentCandidate): number {
  const base = sourceTrust(candidate.sourceName, candidate.sourceUrl, candidate.sourceType);
  // Eşitlikte görseli ve tarihi olan kopya tercih edilir.
  return base * 10 + (candidate.imageUrl ? 2 : 0) + (candidate.canonicalPublishedAt ? 1 : 0);
}

// Aynı haber birkaç kaynaktan geldiyse metni daha güvenilir kaynağınkiyle tutarız.
export function deduplicateCandidates(candidates: ContentCandidate[]): ContentCandidate[] {
  const unique: ContentCandidate[] = [];
  for (const candidate of candidates) {
    const duplicateIndex = unique.findIndex((existing) => (
      existing.sourceUrl === candidate.sourceUrl
      || titleSimilarity(existing.title, candidate.title) >= 0.92
    ));
    if (duplicateIndex === -1) {
      unique.push(candidate);
      continue;
    }
    if (trustRank(candidate) > trustRank(unique[duplicateIndex])) {
      unique[duplicateIndex] = candidate;
    }
  }
  return unique;
}
