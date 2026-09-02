import type { Channel, ContentCandidate, DiscoveryResponse } from '@/lib/content';
import {
  databaseConfigured,
  databaseLastError,
  loadRecentCandidates,
  persistDiscoverySnapshot,
} from '@/lib/database';
import { groqStatus } from '@/lib/groq';
import type { PublicationLanguage } from '@/lib/language';
import {
  deduplicateCandidates,
  enrichIntelligence,
  freshnessFor,
} from '@/lib/news-intelligence';
import { isSafeHttpsUrl, signUrl } from '@/lib/url-signing';
import { channelTuning } from './config';
import { cachedSource, runSource } from './feed';
import { getGdelt } from './sources/gdelt';
import { getGoogleNews } from './sources/google-news';
import { getTrends } from './sources/google-trends';
import { getHistory } from './sources/wikimedia';
import { getNewsApi } from './sources/newsapi';
import { getPublisherRss } from './sources/publisher-rss';
import { publisherGroups } from './sources/registry';

export const discoveryCache = new Map<Channel, { expiresAt: number; payload: DiscoveryResponse }>();

export function signedCandidates(candidates: ContentCandidate[]): ContentCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    sourceToken: isSafeHttpsUrl(candidate.sourceUrl) ? signUrl(candidate.sourceUrl, 'source') : undefined,
    imageToken: candidate.imageUrl && isSafeHttpsUrl(candidate.imageUrl)
      ? signUrl(candidate.imageUrl, 'image')
      : undefined,
  }));
}

export function coverageFor(candidates: ContentCandidate[]): NonNullable<DiscoveryResponse['coverage']> {
  const clusters = new Set(candidates.map((candidate) => candidate.clusterId || candidate.id));
  const corroborated = new Set(candidates
    .filter((candidate) => candidate.verification?.status === 'corroborated')
    .map((candidate) => candidate.clusterId || candidate.id));
  const conflicting = new Set(candidates
    .filter((candidate) => candidate.verification?.status === 'conflict')
    .map((candidate) => candidate.clusterId || candidate.id));
  return {
    totalDiscovered: candidates.length,
    uniqueEvents: clusters.size,
    corroboratedEvents: corroborated.size,
    conflictingEvents: conflicting.size,
    withImages: candidates.filter((candidate) => Boolean(candidate.imageUrl)).length,
    withLocations: candidates.filter((candidate) => Boolean(candidate.location?.label)).length,
    aiAnalyzed: candidates.filter((candidate) => candidate.aiAnalysis?.status !== undefined).length,
    aiPromoted: candidates.filter((candidate) => (
      Boolean(candidate.aiAnalysis) && candidate.score > (candidate.scoreBreakdown?.total || candidate.score)
    )).length,
  };
}

export async function discover(channel: Channel): Promise<DiscoveryResponse> {
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

export const MEMORY_SIGNAL_SUFFIX = ' · kalıcı hafızadan';

// Arşiv rozeti eskiden adayla birlikte kaydediliyordu; her tarama turunda yeniden
// eklenince sinyal metni "· kalıcı hafızadan · kalıcı hafızadan …" diye uzuyordu.
export function baseSignal(signal: string): string {
  return signal.split(MEMORY_SIGNAL_SUFFIX).join('').trim();
}

export function validChannel(value: string | null): Channel {
  return value === 'history' || value === 'international' || value === 'media' ? value : 'news';
}

export async function applyDurableMemory(
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
