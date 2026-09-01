'use client';

import JSZip from 'jszip';
import { toJpeg } from 'html-to-image';
import {
  Check,
  Clock3,
  Download,
  ExternalLink,
  ImagePlus,
  LoaderCircle,
  MapPin,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ReelPreview, type CropSettings, type DraftContent } from '@/components/reel-preview';
import { filterCandidates, type CandidateFilter } from '@/lib/candidate-filters';
import type {
  Channel,
  ContentCandidate,
  DiscoveryResponse,
  FreshnessStatus,
} from '@/lib/content';
import {
  completeExcerpt,
  containsTeaserLanguage,
  containsPublisherLanguage,
  containsSourceAttribution,
  hasCompleteSentenceEnding,
  hasIncompleteEnding,
  hasRepeatedPhrase,
  hasSufficientSourceDetail,
  stripSourceAttribution,
} from '@/lib/copy-guard';
import { loadStudioState, saveStudioState } from '@/lib/draft-storage';
import { isLanguageMatch } from '@/lib/language';

type Draft = DraftContent & {
  caption: string;
  sourceName: string;
  sourceUrl: string;
  sourceToken: string;
  sourceTitle: string;
  sourceSummary: string;
  imageWidth: number;
  imageHeight: number;
  sourceFreshnessStatus: FreshnessStatus;
};

const channels: Array<{ id: Channel; label: string; language: string }> = [
  { id: 'history', label: 'History', language: 'TR' },
  { id: 'news', label: 'News', language: 'TR' },
  { id: 'international', label: 'International', language: 'EN' },
  { id: 'media', label: 'Media', language: 'TR' },
];

const defaultCrop: CropSettings = { zoom: 1, x: 50, y: 50 };

function proxied(url: string, signature = ''): string {
  if (!url || url.startsWith('data:') || url.startsWith('/api/image?')) return url;
  const token = signature ? `&signature=${encodeURIComponent(signature)}` : '';
  return `/api/image?url=${encodeURIComponent(url)}${token}`;
}

const newsDemo = proxied(
  'https://images.unsplash.com/photo-1561731216-c3a4d99437d5?auto=format&fit=crop&w=1600&q=88',
);
const historyDemo = proxied(
  'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1600&q=88',
);

const initialDrafts: Record<Channel, Draft> = {
  history: {
    title: '113 KİŞİ HAYATINI KAYBETTİ',
    body: "25 Temmuz 2000’de Air France’a ait Concorde, Paris’ten kalkışından kısa süre sonra Gonesse’ye düştü. Kazada uçaktaki 109 kişi ile yerdeki 4 kişi hayatını kaybetti.",
    location: 'Gonesse, Paris Yakınları, Fransa',
    image: historyDemo,
    coverCrop: { zoom: 1.08, x: 50, y: 48 },
    detailCrop: { zoom: 1, x: 50, y: 48 },
    caption: '',
    sourceName: 'Örnek içerik',
    sourceUrl: '',
    sourceToken: '',
    sourceTitle: '',
    sourceSummary: '',
    imageWidth: 1600,
    imageHeight: 1067,
    sourceFreshnessStatus: 'today',
  },
  news: {
    title: '30 ASLAN VE KAPLAN ÖZGÜRLÜĞE TAŞINIYOR',
    body: 'Yıllarca kapalı ve kötü koşullardaki kafeslerde yaşayan 30 aslan ve kaplan için büyük bir kurtarma operasyonu başladı. Hayvanlar, Güney Afrika ve ABD’deki koruma alanlarına taşınacak.',
    location: 'Luján, Arjantin',
    image: newsDemo,
    coverCrop: { zoom: 1.12, x: 50, y: 49 },
    detailCrop: { zoom: 1, x: 50, y: 48 },
    caption: '',
    sourceName: 'Örnek içerik',
    sourceUrl: '',
    sourceToken: '',
    sourceTitle: '',
    sourceSummary: '',
    imageWidth: 1600,
    imageHeight: 1067,
    sourceFreshnessStatus: 'today',
  },
  international: {
    title: '30 LIONS AND TIGERS ARE MOVING TO FREEDOM',
    body: 'A major rescue operation has begun for 30 lions and tigers kept for years in cramped, poor conditions. The animals will be moved to sanctuaries in South Africa and the United States.',
    location: 'Luján, Argentina',
    image: newsDemo,
    coverCrop: { zoom: 1.12, x: 50, y: 49 },
    detailCrop: { zoom: 1, x: 50, y: 48 },
    caption: '',
    sourceName: 'Sample content',
    sourceUrl: '',
    sourceToken: '',
    sourceTitle: '',
    sourceSummary: '',
    imageWidth: 1600,
    imageHeight: 1067,
    sourceFreshnessStatus: 'today',
  },
  media: {
    title: 'MEDYA GÜNDEMİNDE BUGÜN',
    body: 'Deepbrief Media için günün öne çıkan gelişmesini kaynak metnini kontrol ederek burada düzenleyebilirsin.',
    location: 'İstanbul, Türkiye',
    image: newsDemo,
    coverCrop: { zoom: 1.12, x: 50, y: 49 },
    detailCrop: { zoom: 1, x: 50, y: 48 },
    caption: '',
    sourceName: 'Örnek içerik',
    sourceUrl: '',
    sourceToken: '',
    sourceTitle: '',
    sourceSummary: '',
    imageWidth: 1600,
    imageHeight: 1067,
    sourceFreshnessStatus: 'today',
  },
};

function restoreDraft(base: Draft, saved?: Partial<Draft>): Draft {
  const merged = { ...base, ...saved };
  const sourceTitle = stripSourceAttribution(
    saved?.sourceTitle?.trim() || (merged.sourceUrl ? merged.title : ''),
    merged.sourceName,
  );
  const sourceSummary = stripSourceAttribution(
    saved?.sourceSummary?.trim() || (merged.sourceUrl ? merged.body : ''),
    merged.sourceName,
  );
  const cleanTitle = stripSourceAttribution(merged.title, merged.sourceName);
  const cleanBody = stripSourceAttribution(merged.body, merged.sourceName);
  const cleanCaption = stripSourceAttribution(saved?.caption ?? base.caption, merged.sourceName);
  const titleIsUnsafe = containsPublisherLanguage(cleanTitle) || hasIncompleteEnding(cleanTitle);
  const bodyIsUnsafe = containsPublisherLanguage(cleanBody)
    || hasRepeatedPhrase(cleanBody, 4)
    || hasIncompleteEnding(cleanBody)
    || !hasCompleteSentenceEnding(cleanBody);
  const captionIsUnsafe = containsPublisherLanguage(cleanCaption) || hasRepeatedPhrase(cleanCaption, 5);
  return {
    ...merged,
    title: titleIsUnsafe && sourceTitle && !hasIncompleteEnding(sourceTitle)
      ? sourceTitle
      : cleanTitle,
    body: bodyIsUnsafe && sourceSummary ? completeExcerpt(sourceSummary, 320) : cleanBody,
    caption: captionIsUnsafe ? '' : cleanCaption,
    sourceTitle,
    sourceSummary,
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Bugün';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function safeFileName(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42) || 'icerik';
}

function wordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

function downloadBlob(blob: Blob, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function waitForImages(node: HTMLElement) {
  const images = Array.from(node.querySelectorAll('img'));
  await Promise.all(images.map((image) => {
    if (image.complete && image.naturalWidth > 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => reject(new Error('Görsel yüklenemedi.')), { once: true });
    });
  }));
}

const minimumImageWidth = 1080;
const minimumImageHeight = 650;

function isPublicationQuality(width: number, height: number): boolean {
  return width >= minimumImageWidth && height >= minimumImageHeight;
}

function measureImage(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => {
      image.src = '';
      reject(new Error('Görsel boyutu okunamadı.'));
    }, 12_000);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Görsel yüklenemedi.'));
    };
    image.src = src;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('İyileştirilen görsel okunamadı.'));
    };
    reader.onerror = () => reject(new Error('İyileştirilen görsel okunamadı.'));
    reader.readAsDataURL(blob);
  });
}

async function prepareUpscaleBlob(blob: Blob): Promise<Blob> {
  const providerSupportsType = ['image/jpeg', 'image/png', 'image/webp'].includes(blob.type);
  if (providerSupportsType && blob.size <= 12 * 1024 * 1024) return blob;
  if (typeof createImageBitmap !== 'function') return blob;

  const bitmap = await createImageBitmap(blob);
  const maxSide = 3840;
  const scale = Math.min(
    1,
    maxSide / bitmap.width,
    maxSide / bitmap.height,
  );

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(32, Math.floor(bitmap.width * scale));
  canvas.height = Math.max(32, Math.floor(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return blob;
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error('Görsel upscale için hazırlanamadı.')),
      'image/webp',
      0.92,
    );
  });
}

type EnrichmentResponse = {
  imageUrl?: string;
  imageToken?: string;
  imageCandidates?: Array<{ url: string; token: string }>;
  title?: string;
  description?: string;
  resolvedSourceUrl?: string;
  canonicalPublishedAt?: string;
  canonicalModifiedAt?: string;
  freshnessStatus?: FreshnessStatus;
  error?: string;
};

type UpscaleStatus = {
  configured: boolean;
  provider: string;
  usage?: ProviderUsage;
};

type CopyStatus = {
  configured: boolean;
  provider: string;
  model: string;
  usage?: ProviderUsage;
};

type ProviderUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  limit: number;
};

type GeneratedCopyResponse = {
  coverTitle?: string;
  visualText?: string;
  caption?: string;
  wordCounts?: { coverTitle: number; visualText: number; caption: number };
  error?: string;
};

type GroqStatusResponse = {
  configured: boolean;
  keyCount: number;
  analysisModel: string;
  searchModel: string;
  usage: {
    date: string;
    analysis: number;
    analysisLimit: number;
    search: number;
    searchLimit: number;
  };
};

type GroqAnalysisResponse = {
  candidates?: ContentCandidate[];
  analyzed?: number;
  error?: string;
};

type GapScanResponse = {
  candidates?: ContentCandidate[];
  error?: string;
};

function freshnessLabel(status?: FreshnessStatus): string {
  if (status === 'today') return 'Bugün doğrulandı';
  if (status === 'updated-today') return 'Bugün güncellendi';
  if (status === 'stale') return 'Bugüne ait değil';
  return 'Tarih kontrol edilecek';
}

function coverageFromCandidates(
  candidates: ContentCandidate[],
  fallback?: DiscoveryResponse['coverage'],
): NonNullable<DiscoveryResponse['coverage']> {
  const clusters = new Set(candidates.map((candidate) => candidate.clusterId || candidate.id));
  const corroborated = new Set(candidates
    .filter((candidate) => candidate.verification?.status === 'corroborated')
    .map((candidate) => candidate.clusterId || candidate.id));
  return {
    totalDiscovered: candidates.length,
    uniqueEvents: clusters.size,
    corroboratedEvents: corroborated.size,
    withImages: candidates.filter((candidate) => Boolean(candidate.imageUrl)).length,
    withLocations: candidates.filter((candidate) => Boolean(candidate.location?.label)).length,
    aiAnalyzed: candidates.filter((candidate) => Boolean(candidate.aiAnalysis)).length,
    aiPromoted: candidates.filter((candidate) => (
      Boolean(candidate.aiAnalysis) && candidate.score > (candidate.scoreBreakdown?.total || candidate.score)
    )).length || fallback?.aiPromoted || 0,
  };
}

function CandidateCard({
  candidate,
  loading,
  onSelect,
}: {
  candidate: ContentCandidate;
  loading: boolean;
  onSelect: () => void;
}) {
  const sourceCount = candidate.verification?.sourceCount || 1;
  const candidateTitle = candidate.readinessIssues?.join(' ') || '';
  return (
    <button
      className={`candidate-card freshness-${candidate.freshnessStatus || 'unverified'}`}
      disabled={loading || candidate.freshnessStatus === 'stale'}
      onClick={onSelect}
      title={candidateTitle}
      type="button"
    >
      <span className="candidate-thumb">
        {candidate.imageUrl ? (
          // Native img keeps proxied source thumbnails independent from Next image optimization.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt="" loading="lazy" src={proxied(candidate.imageUrl, candidate.imageToken)} />
        ) : (
          <span className="candidate-no-image">DB</span>
        )}
        <i>{candidate.score}</i>
      </span>
      <span className="candidate-content">
        <span className="candidate-meta">
          <b>{candidate.kind === 'trend' ? 'TREND' : candidate.kind === 'history' ? 'TARİH' : 'HABER'}</b>
          <i>{candidate.signal}</i>
        </span>
        <strong>{candidate.title}</strong>
        <small>{candidate.sourceName} · {formatTime(candidate.publishedAt)}</small>
        <span className="candidate-badges">
          <i className={`freshness-badge freshness-${candidate.freshnessStatus || 'unverified'}`}>
            <Clock3 size={8} /> {freshnessLabel(candidate.freshnessStatus)}
          </i>
          <i><ShieldCheck size={8} /> {sourceCount} kaynak</i>
          {candidate.location?.label && <i><MapPin size={8} /> {candidate.location.label}</i>}
          {candidate.aiAnalysis?.importance !== null && candidate.aiAnalysis?.importance !== undefined && (
            <i className="ai-badge">Groq {candidate.aiAnalysis.importance}</i>
          )}
        </span>
      </span>
      {loading
        ? <LoaderCircle aria-label="Yüksek çözünürlüklü görsel aranıyor" className="spin" size={13} />
        : <ExternalLink aria-hidden="true" size={13} strokeWidth={1.8} />}
    </button>
  );
}

export function Studio() {
  const [channel, setChannel] = useState<Channel>('news');
  const [drafts, setDrafts] = useState<Record<Channel, Draft>>(initialDrafts);
  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [search, setSearch] = useState('');
  const [candidateFilters, setCandidateFilters] = useState<Set<CandidateFilter>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [cropTarget, setCropTarget] = useState<'cover' | 'detail'>('cover');
  const [exporting, setExporting] = useState(false);
  const [enrichingId, setEnrichingId] = useState('');
  const [upscaling, setUpscaling] = useState(false);
  const [upscaleConfigured, setUpscaleConfigured] = useState<boolean | null>(null);
  const [upscaleUsage, setUpscaleUsage] = useState<ProviderUsage | null>(null);
  const [generatingCopy, setGeneratingCopy] = useState(false);
  const [copyConfigured, setCopyConfigured] = useState<boolean | null>(null);
  const [copyUsage, setCopyUsage] = useState<ProviderUsage | null>(null);
  const [groqStatus, setGroqStatus] = useState<GroqStatusResponse | null>(null);
  const [groqChecking, setGroqChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageReady, setStorageReady] = useState(false);
  const selectionRequestRef = useRef(0);
  const discoveryRequestRef = useRef(0);
  const imageHydrationRef = useRef(new Set<string>());
  const coverRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const draft = drafts[channel];

  const today = useMemo(() => new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date()), []);

  const filteredCandidates = useMemo(() => filterCandidates(
    discovery?.candidates ?? [],
    search,
    candidateFilters,
  ), [candidateFilters, discovery, search]);

  const visibleCandidates = useMemo(
    () => (showAll ? filteredCandidates : filteredCandidates.slice(0, 6)),
    [filteredCandidates, showAll],
  );

  const crop = cropTarget === 'cover' ? draft.coverCrop : draft.detailCrop;

  function updateDraft(patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [channel]: { ...current[channel], ...patch },
    }));
  }

  function updateCrop(patch: Partial<CropSettings>) {
    const key = cropTarget === 'cover' ? 'coverCrop' : 'detailCrop';
    updateDraft({ [key]: { ...draft[key], ...patch } });
  }

  async function scanSources(force = false) {
    const targetChannel = channel;
    const requestId = discoveryRequestRef.current + 1;
    discoveryRequestRef.current = requestId;
    setLoading(true);
    setDiscoveryError('');
    setShowAll(false);
    imageHydrationRef.current.clear();
    try {
      const response = await fetch(
        `/api/discover?channel=${targetChannel}${force ? '&refresh=1' : ''}`,
        { cache: 'no-store' },
      );
      const body = await response.json() as DiscoveryResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Kaynaklar okunamadı.');
      if (discoveryRequestRef.current !== requestId) return;
      setDiscovery(body);
      void hydrateCandidateMetadata(body);
      void runGroqChecks(body, targetChannel, requestId);
    } catch (error) {
      if (discoveryRequestRef.current !== requestId) return;
      setDiscovery(null);
      setDiscoveryError(error instanceof Error ? error.message : 'Kaynaklar okunamadı.');
    } finally {
      if (discoveryRequestRef.current === requestId) setLoading(false);
    }
  }

  async function hydrateCandidateMetadata(snapshot: DiscoveryResponse, limit = 12) {
    const pending = snapshot.candidates
      .filter((candidate) => (
        Boolean(candidate.sourceUrl)
        && Boolean(candidate.sourceToken)
        && !imageHydrationRef.current.has(candidate.id)
      ))
      .slice(0, limit);

    if (pending.length === 0) return;
    pending.forEach((candidate) => imageHydrationRef.current.add(candidate.id));

    const enriched = await Promise.all(pending.map(async (candidate) => {
      try {
        const response = await fetch(
          `/api/enrich?url=${encodeURIComponent(candidate.sourceUrl)}&token=${encodeURIComponent(candidate.sourceToken || '')}`,
          { cache: 'no-store' },
        );
        const body = await response.json() as EnrichmentResponse;
        if (!response.ok) return null;
        return {
          id: candidate.id,
          body,
        };
      } catch {
        return null;
      }
    }));

    const images = new Map(enriched
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => [item.id, item.body]));
    if (images.size === 0) return;

    setDiscovery((current) => {
      if (!current || current.generatedAt !== snapshot.generatedAt) return current;
      return {
        ...current,
        candidates: current.candidates.map((candidate) => {
          const enriched = images.get(candidate.id);
          if (!enriched) return candidate;
          const canonicalDateFound = Boolean(
            enriched.canonicalPublishedAt || enriched.canonicalModifiedAt,
          );
          const freshnessStatus = canonicalDateFound
            ? enriched.freshnessStatus || candidate.freshnessStatus
            : candidate.freshnessStatus;
          const imageCandidate = enriched.imageCandidates?.[0];
          const imageUrl = candidate.imageUrl || imageCandidate?.url || enriched.imageUrl || '';
          const imageToken = candidate.imageToken || imageCandidate?.token || enriched.imageToken || '';
          return {
            ...candidate,
            imageUrl,
            imageToken,
            canonicalPublishedAt: enriched.canonicalPublishedAt || candidate.canonicalPublishedAt,
            canonicalModifiedAt: enriched.canonicalModifiedAt || candidate.canonicalModifiedAt,
            freshnessStatus,
            score: freshnessStatus === 'stale' ? Math.min(candidate.score, 10) : candidate.score,
            signal: freshnessStatus === 'stale' ? 'Bugüne ait değil' : candidate.signal,
            readinessIssues: freshnessStatus === 'stale'
              ? Array.from(new Set([...(candidate.readinessIssues || []), 'Kaynak sayfası bugüne ait değil.']))
              : candidate.readinessIssues,
          };
        }).sort((left, right) => (
          Number(left.freshnessStatus === 'stale') - Number(right.freshnessStatus === 'stale')
          || right.score - left.score
        )),
      };
    });
  }

  async function runGroqChecks(
    snapshot: DiscoveryResponse,
    targetChannel: Channel,
    requestId: number,
  ) {
    try {
      const statusResponse = await fetch('/api/groq/status', { cache: 'no-store' });
      const status = await statusResponse.json() as GroqStatusResponse;
      if (discoveryRequestRef.current !== requestId) return;
      setGroqStatus(status);
      if (!statusResponse.ok || !status.configured) return;
      setGroqChecking(true);

      const [analysisResult, gapResult] = await Promise.allSettled([
        fetch('/api/groq/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: targetChannel, candidates: snapshot.candidates.slice(0, 12) }),
        }).then(async (response) => ({
          ok: response.ok,
          body: await response.json() as GroqAnalysisResponse,
        })),
        targetChannel === 'history'
          ? Promise.resolve({ ok: true, body: { candidates: [] } as GapScanResponse })
          : fetch(`/api/groq/gap-scan?channel=${targetChannel}`, { cache: 'no-store' })
            .then(async (response) => ({
              ok: response.ok,
              body: await response.json() as GapScanResponse,
            })),
      ]);
      if (discoveryRequestRef.current !== requestId) return;

      const analyzed = analysisResult.status === 'fulfilled' && analysisResult.value.ok
        ? analysisResult.value.body.candidates || []
        : [];
      const gapCandidates = gapResult.status === 'fulfilled' && gapResult.value.ok
        ? gapResult.value.body.candidates || []
        : [];
      const analyzedById = new Map(analyzed.map((candidate) => [candidate.id, candidate]));
      setDiscovery((current) => {
        if (!current || current.generatedAt !== snapshot.generatedAt) return current;
        const merged = current.candidates.map((candidate) => analyzedById.get(candidate.id) || candidate);
        for (const gap of gapCandidates) {
          const duplicate = merged.some((candidate) => (
            candidate.sourceUrl === gap.sourceUrl
            || candidate.title.toLocaleLowerCase('tr-TR') === gap.title.toLocaleLowerCase('tr-TR')
          ));
          if (!duplicate) merged.push(gap);
        }
        merged.sort((left, right) => (
          Number(left.freshnessStatus === 'stale') - Number(right.freshnessStatus === 'stale')
          || right.score - left.score
        ));
        return {
          ...current,
          candidates: merged,
          coverage: coverageFromCandidates(merged, current.coverage),
        };
      });

      const refreshedStatus = await fetch('/api/groq/status', { cache: 'no-store' })
        .then((response) => response.json() as Promise<GroqStatusResponse>)
        .catch(() => status);
      if (discoveryRequestRef.current === requestId) setGroqStatus(refreshedStatus);
    } catch {
      // Groq is an optional promotion and verification layer; source discovery remains usable.
    } finally {
      if (discoveryRequestRef.current === requestId) setGroqChecking(false);
    }
  }

  function toggleCandidateList() {
    const next = !showAll;
    setShowAll(next);
    if (next && discovery) void hydrateCandidateMetadata(discovery, 24);
  }

  function toggleCandidateFilter(filter: CandidateFilter) {
    setCandidateFilters((current) => {
      const next = new Set(current);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });
    setShowAll(false);
  }

  function clearCandidateFilters() {
    setCandidateFilters(new Set());
    setShowAll(false);
  }

  function changeChannel(nextChannel: Channel) {
    setChannel(nextChannel);
    setCandidateFilters(new Set());
    setShowAll(false);
  }

  useEffect(() => {
    // Loading state belongs to the external source request initiated by this channel change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void scanSources();
    // Kanal değiştiğinde yalnızca o kanalın bugünkü kaynakları yeniden okunur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  useEffect(() => {
    void fetch('/api/upscale', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as UpscaleStatus;
        setUpscaleConfigured(response.ok && Boolean(body.configured));
        setUpscaleUsage(body.usage || null);
      })
      .catch(() => setUpscaleConfigured(false));
  }, []);

  useEffect(() => {
    void fetch('/api/generate-copy', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as CopyStatus;
        setCopyConfigured(response.ok && Boolean(body.configured));
        setCopyUsage(body.usage || null);
      })
      .catch(() => setCopyConfigured(false));
  }, []);

  useEffect(() => {
    void loadStudioState<{ channel?: Channel; drafts?: Partial<Record<Channel, Draft>> }>()
      .then((saved) => {
        if (!saved) return;
        if (saved.channel && channels.some((item) => item.id === saved.channel)) {
          setChannel(saved.channel);
        }
        if (saved.drafts) {
          setDrafts((current) => ({
            history: restoreDraft(current.history, saved.drafts?.history),
            news: restoreDraft(current.news, saved.drafts?.news),
            international: restoreDraft(current.international, saved.drafts?.international),
            media: restoreDraft(current.media, saved.drafts?.media),
          }));
        }
      })
      .catch(() => undefined)
      .finally(() => setStorageReady(true));
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    const timer = window.setTimeout(() => {
      void saveStudioState({ channel, drafts }).catch(() => undefined);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [channel, drafts, storageReady]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function selectCandidate(candidate: ContentCandidate) {
    const targetChannel = channel;
    if (candidate.freshnessStatus === 'stale') {
      setNotice('Bu haber kaynak sayfasında bugüne ait görünmüyor; taslağa alınmadı.');
      return;
    }
    const expectedLanguage = targetChannel === 'international' ? 'en' : 'tr';
    const cleanCandidateTitle = stripSourceAttribution(candidate.title, candidate.sourceName);
    const cleanCandidateSummary = stripSourceAttribution(candidate.summary, candidate.sourceName);
    if (!isLanguageMatch(`${cleanCandidateTitle} ${cleanCandidateSummary}`, expectedLanguage, candidate.sourceName)) {
      setNotice(targetChannel === 'international'
        ? 'Bu kaynak İngilizce değil; taslağa alınmadı.'
        : 'Bu kaynak Türkçe değil; taslağa alınmadı.');
      return;
    }

    const requestId = selectionRequestRef.current + 1;
    selectionRequestRef.current = requestId;
    setEnrichingId(candidate.id);
    const locale = targetChannel === 'international' ? 'en-US' : 'tr-TR';
    const nextTitle = cleanCandidateTitle.toLocaleUpperCase(locale).replace(/\s+/gu, ' ').trim();
    const nextBody = completeExcerpt(cleanCandidateSummary, 320);
    setDrafts((current) => ({
      ...current,
      [targetChannel]: {
        ...current[targetChannel],
        title: nextTitle,
        body: nextBody,
        caption: '',
        location: candidate.location?.label || '',
        image: '',
        imageWidth: 0,
        imageHeight: 0,
        sourceFreshnessStatus: candidate.freshnessStatus || 'unverified',
        sourceName: candidate.sourceName,
        sourceUrl: candidate.sourceUrl,
        sourceToken: candidate.sourceToken || '',
        sourceTitle: cleanCandidateTitle,
        sourceSummary: cleanCandidateSummary,
        coverCrop: { ...defaultCrop },
        detailCrop: { ...defaultCrop },
      },
    }));
    setNotice('Kaynak seçildi; yayın görselinin yüksek çözünürlüklü sürümü aranıyor…');

    const variants: Array<{ src: string; origin: string }> = [];
    if (candidate.sourceUrl && candidate.sourceToken) {
      try {
        const response = await fetch(
          `/api/enrich?url=${encodeURIComponent(candidate.sourceUrl)}&token=${encodeURIComponent(candidate.sourceToken)}`,
          { cache: 'no-store' },
        );
        const body = await response.json() as EnrichmentResponse;
        if (response.ok) {
          for (const image of body.imageCandidates || []) {
            variants.push({ src: proxied(image.url, image.token), origin: 'haber sayfası' });
          }
          if (body.imageUrl) {
            variants.push({
              src: proxied(body.imageUrl, body.imageToken),
              origin: 'haber sayfası',
            });
          }
        }
        if (response.ok && selectionRequestRef.current === requestId) {
          const enrichedTitle = stripSourceAttribution(body.title?.trim() || cleanCandidateTitle, candidate.sourceName);
          const enrichedSummary = stripSourceAttribution(body.description?.trim() || cleanCandidateSummary, candidate.sourceName);
          const combinedEvidence = `${enrichedTitle} ${enrichedSummary}`;
          if (isLanguageMatch(combinedEvidence, expectedLanguage, candidate.sourceName)) {
            setDrafts((current) => ({
              ...current,
              [targetChannel]: {
                ...current[targetChannel],
                sourceTitle: enrichedTitle,
                sourceSummary: enrichedSummary,
                sourceUrl: body.resolvedSourceUrl || candidate.sourceUrl,
                sourceFreshnessStatus: body.canonicalPublishedAt || body.canonicalModifiedAt
                  ? body.freshnessStatus || current[targetChannel].sourceFreshnessStatus
                  : current[targetChannel].sourceFreshnessStatus,
              },
            }));
          }
        }
      } catch {
        // The signed discovery image below remains a safe fallback.
      }
    }
    if (candidate.imageUrl) {
      variants.push({
        src: proxied(candidate.imageUrl, candidate.imageToken),
        origin: 'kaynak akışı',
      });
    }

    const uniqueVariants = variants.filter((variant, index, list) => (
      list.findIndex((item) => item.src === variant.src) === index
    ));
    let best: { src: string; width: number; height: number; origin: string } | null = null;
    for (const variant of uniqueVariants) {
      try {
        const size = await measureImage(variant.src);
        if (!best || size.width * size.height > best.width * best.height) {
          best = { ...variant, ...size };
        }
      } catch {
        // Try the next source image.
      }
    }

    if (selectionRequestRef.current !== requestId) return;
    if (best) {
      setDrafts((current) => ({
        ...current,
        [targetChannel]: {
          ...current[targetChannel],
          image: best.src,
          imageWidth: best.width,
          imageHeight: best.height,
        },
      }));
      setNotice(isPublicationQuality(best.width, best.height)
        ? `${best.width} × ${best.height}px görsel ${best.origin} üzerinden alındı. Konumu girip metni kontrol et.`
        : `${best.width} × ${best.height}px görsel ${best.origin} üzerinden eklendi. İstersen “Görsel kalitesini artır” düğmesini kullanabilirsin.`);
    } else {
      setNotice('Kaynakta kullanılabilir görsel bulunamadı. Kendi görselini yükleyebilirsin.');
    }
    setEnrichingId('');
  }

  function loadImage(file?: File) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      setNotice('Görsel 12 MB sınırını aşıyor.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const image = new Image();
      image.onload = () => {
        updateDraft({
          image: reader.result as string,
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight,
          coverCrop: { ...defaultCrop },
          detailCrop: { ...defaultCrop },
        });
        setNotice(!isPublicationQuality(image.naturalWidth, image.naturalHeight)
          ? `Görsel ${image.naturalWidth} × ${image.naturalHeight}px olarak eklendi. İstersen kalitesini artırabilirsin.`
          : 'Görsel yüklendi. Kapak ve gönderi kırpmasını ayrı ayrı ayarlayabilirsin.');
      };
      image.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  async function generateCopy() {
    if (copyConfigured !== true) {
      setNotice('OPENAI_API_KEY sunucuda ayarlı değil. .env dosyasına ekleyip Docker’ı yeniden başlat.');
      return;
    }
    if (!draft.sourceTitle.trim() || !draft.sourceSummary.trim()) {
      setNotice('Metin üretmek için önce bugünün kaynaklarından bir içerik seç.');
      return;
    }
    if (draft.sourceFreshnessStatus === 'stale') {
      setNotice('Kaynak sayfası bugüne ait değil. Bu haber için metin üretimi başlatılmadı.');
      return;
    }
    if (enrichingId) {
      setNotice('Haber sayfasındaki ayrıntılar okunuyor. İşlem tamamlanınca yeniden dene.');
      return;
    }

    const targetChannel = channel;
    let cleanSourceTitle = stripSourceAttribution(draft.sourceTitle, draft.sourceName);
    let cleanSourceSummary = stripSourceAttribution(draft.sourceSummary, draft.sourceName);

    if (
      !hasSufficientSourceDetail(cleanSourceTitle, cleanSourceSummary)
      && draft.sourceUrl
      && draft.sourceToken
    ) {
      setGeneratingCopy(true);
      setNotice('Haber sayfasındaki ayrıntılar yeniden okunuyor…');
      try {
        const response = await fetch(
          `/api/enrich?url=${encodeURIComponent(draft.sourceUrl)}&token=${encodeURIComponent(draft.sourceToken)}`,
          { cache: 'no-store' },
        );
        const body = await response.json() as EnrichmentResponse;
        if (response.ok) {
          cleanSourceTitle = stripSourceAttribution(
            body.title?.trim() || cleanSourceTitle,
            draft.sourceName,
          );
          cleanSourceSummary = stripSourceAttribution(
            body.description?.trim() || cleanSourceSummary,
            draft.sourceName,
          );
          setDrafts((current) => ({
            ...current,
            [targetChannel]: {
              ...current[targetChannel],
              sourceTitle: cleanSourceTitle,
              sourceSummary: cleanSourceSummary,
              sourceUrl: body.resolvedSourceUrl || current[targetChannel].sourceUrl,
              sourceFreshnessStatus: body.canonicalPublishedAt || body.canonicalModifiedAt
                ? body.freshnessStatus || current[targetChannel].sourceFreshnessStatus
                : current[targetChannel].sourceFreshnessStatus,
            },
          }));
        }
      } catch {
        // The validation below gives the user a precise, non-paid failure.
      }
    }

    if (!hasSufficientSourceDetail(cleanSourceTitle, cleanSourceSummary)) {
      setGeneratingCopy(false);
      setNotice(draft.sourceToken
        ? 'Kaynak sayfasındaki haber gövdesi okunamadı. OpenAI çağrısı yapılmadı; haberi yeniden seçmeyi veya başka bir kaynak kullanmayı dene.'
        : 'Bu haber eski bir taslaktan yüklendi ve kaynak erişim anahtarı kayıtlı değil. Haberi kaynak listesinden yeniden seç; sayfa ayrıntıları tekrar okunacak.');
      return;
    }

    const source = {
      sourceTitle: cleanSourceTitle,
      sourceText: cleanSourceSummary,
      sourceName: draft.sourceName,
    };
    setGeneratingCopy(true);
    setNotice('Kaynağa bağlı görsel metni ve caption hazırlanıyor…');
    try {
      const response = await fetch('/api/generate-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: targetChannel, ...source }),
      });
      const body = await response.json().catch(() => ({ error: '' })) as GeneratedCopyResponse;
      if (!response.ok || !body.coverTitle || !body.visualText || !body.caption) {
        throw new Error(body.error || 'Metinler üretilemedi.');
      }

      setDrafts((current) => ({
        ...current,
        [targetChannel]: {
          ...current[targetChannel],
          title: body.coverTitle
            ? body.coverTitle.toLocaleUpperCase(targetChannel === 'international' ? 'en-US' : 'tr-TR')
            : current[targetChannel].title,
          body: body.visualText || current[targetChannel].body,
          caption: body.caption || current[targetChannel].caption,
        },
      }));
      setNotice(`Metinler tamamlandı: kapak ${body.wordCounts?.coverTitle ?? wordCount(body.coverTitle)} kelime, gönderi ${body.wordCounts?.visualText ?? wordCount(body.visualText)} kelime, caption ${body.wordCounts?.caption ?? wordCount(body.caption)} kelime.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Metinler üretilemedi.');
    } finally {
      setGeneratingCopy(false);
      void fetch('/api/generate-copy', { cache: 'no-store' })
        .then((response) => response.json() as Promise<CopyStatus>)
        .then((status) => setCopyUsage(status.usage || null))
        .catch(() => undefined);
    }
  }

  async function upscaleImage() {
    if (!draft.image) {
      setNotice('Önce bir görsel seç veya yükle.');
      return;
    }
    if (upscaleConfigured !== true) {
      setNotice('OPENAI_API_KEY sunucuda ayarlı değil. .env dosyasına ekleyip Docker’ı yeniden başlat.');
      return;
    }
    if (!window.confirm('Bu işlem OpenAI kredisi kullanır. Dengeli modda, en fazla 1920px ve medium kaliteyle devam edilsin mi?')) {
      return;
    }

    const targetChannel = channel;
    setUpscaling(true);
    setNotice('Görsel OpenAI dengeli moduyla işleniyor…');
    try {
      const sourceResponse = await fetch(draft.image, { cache: 'no-store' });
      if (!sourceResponse.ok) throw new Error('Kaynak görsel indirilemedi.');
      const sourceBlob = await prepareUpscaleBlob(await sourceResponse.blob());
      const form = new FormData();
      form.append('image', sourceBlob, 'deepbrief-source.webp');
      form.append('width', String(draft.imageWidth));
      form.append('height', String(draft.imageHeight));

      const response = await fetch('/api/upscale', {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: '' })) as { error?: string };
        throw new Error(body.error || 'Görsel kalitesi artırılamadı.');
      }

      const dataUrl = await blobToDataUrl(await response.blob());
      const size = await measureImage(dataUrl);
      setDrafts((current) => ({
        ...current,
        [targetChannel]: {
          ...current[targetChannel],
          image: dataUrl,
          imageWidth: size.width,
          imageHeight: size.height,
        },
      }));
      setNotice(`Görsel dengeli modda ${size.width} × ${size.height}px boyutuna yükseltildi. Yayınlamadan önce yüzleri, yazıları ve ayrıntıları kontrol et.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Görsel kalitesi artırılamadı.');
    } finally {
      setUpscaling(false);
      void fetch('/api/upscale', { cache: 'no-store' })
        .then((response) => response.json() as Promise<UpscaleStatus>)
        .then((status) => setUpscaleUsage(status.usage || null))
        .catch(() => undefined);
    }
  }

  async function exportPackage() {
    if (!coverRef.current || !detailRef.current) return;
    if (!draft.title.trim() || !draft.body.trim() || !draft.caption.trim()) {
      setNotice('Dışa aktarmadan önce başlık, gönderi metni ve caption alanını doldur.');
      return;
    }
    if (!draft.location.trim()) {
      setNotice('Konum alanı boş. Beyaz çubuk için habere ait konumu gir.');
      return;
    }
    if (channel !== 'history' && draft.sourceFreshnessStatus === 'stale') {
      setNotice('Kaynak sayfası bugüne ait değil; paket oluşturulmadı. Başka bir güncel haber seç.');
      return;
    }
    if (
      channel !== 'history'
      && draft.sourceFreshnessStatus === 'unverified'
      && !window.confirm('Kaynak sayfasının yayın tarihi doğrulanamadı. Haberin bugün yayımlandığını elle kontrol ettiysen devam et.')
    ) return;
    if (!draft.image) {
      setNotice('Dışa aktarmadan önce bir görsel seç.');
      return;
    }
    const expectedLanguage = channel === 'international' ? 'en' : 'tr';
    if (!isLanguageMatch(`${draft.title} ${draft.body} ${draft.caption}`, expectedLanguage, draft.sourceName)) {
      setNotice(channel === 'international'
        ? 'International içeriği İngilizce olmalı. Metni kontrol et.'
        : 'History ve News içeriği Türkçe olmalı. Metni kontrol et.');
      return;
    }
    if (
      containsSourceAttribution(`${draft.title} ${draft.body} ${draft.caption}`, draft.sourceName)
      || containsPublisherLanguage(`${draft.title} ${draft.body} ${draft.caption}`)
    ) {
      setNotice('Yayın metinlerinde haber kaynağı, ajans, gazete veya site adı bulunamaz. Metni temizleyip yeniden dene.');
      return;
    }
    if (
      wordCount(draft.title) < 3
      || wordCount(draft.title) > 15
      || draft.title.length > 105
      || hasIncompleteEnding(draft.title)
    ) {
      setNotice('Kapak başlığı 3–15 kelimelik, en fazla 105 karakterlik ve tamamlanmış bir ifade olmalı. API ile yeniden oluşturabilir veya elle düzeltebilirsin.');
      return;
    }
    if (
      wordCount(draft.body) < 12
      || wordCount(draft.body) > 36
      || hasIncompleteEnding(draft.body)
      || !hasCompleteSentenceEnding(draft.body)
    ) {
      setNotice('Gönderi metni 12–36 kelime arasında, kendi başına anlaşılır ve noktalama işaretiyle tamamlanmış olmalı. Hedef aralık 18–30 kelimedir.');
      return;
    }
    if (
      hasIncompleteEnding(draft.caption)
      || !hasCompleteSentenceEnding(draft.caption)
      || wordCount(draft.caption) < 50
      || wordCount(draft.caption) > 95
      || containsTeaserLanguage(`${draft.title} ${draft.body} ${draft.caption}`)
    ) {
      setNotice('Metinde yarım kalan veya devamı varmış izlenimi veren bir ifade bulunuyor. Metni tamamlayıp yeniden dene.');
      return;
    }
    setExporting(true);
    setNotice('1080 × 1920 dosyalar hazırlanıyor…');
    try {
      await document.fonts.ready;
      await Promise.all([waitForImages(coverRef.current), waitForImages(detailRef.current)]);

      async function render(node: HTMLDivElement) {
        const ratio = 1080 / node.offsetWidth;
        return toJpeg(node, {
          quality: 0.96,
          pixelRatio: ratio,
          cacheBust: true,
          backgroundColor: '#080808',
        });
      }

      const [cover, detail] = await Promise.all([
        render(coverRef.current),
        render(detailRef.current),
      ]);
      const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
      const base = `deepbrief-${channel}-${stamp}-${safeFileName(draft.title)}`;
      const zip = new JSZip();
      zip.file(`${base}-thumbnail.jpg`, cover.split(',')[1], { base64: true });
      zip.file(`${base}-gonderi.jpg`, detail.split(',')[1], { base64: true });
      zip.file(`${base}-caption.txt`, draft.caption.trim());
      zip.file(`${base}-kaynak.txt`, [
        `Kanal: ${channel}`,
        `Tarih: ${today}`,
        `Kaynak: ${draft.sourceName || '-'}`,
        `Bağlantı: ${draft.sourceUrl || '-'}`,
        `Konum: ${draft.location || '-'}`,
        `Tazelik: ${draft.sourceFreshnessStatus}`,
      ].join('\n'));
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${base}.zip`);
      setNotice('Reels paketi indirildi: thumbnail, gönderi, caption ve kaynak notu.');
    } catch (error) {
      setNotice(error instanceof Error ? `Dışa aktarma başarısız: ${error.message}` : 'Dışa aktarma başarısız.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-label="Deepbrief Studio">
          <span className="brand-glyph">D</span>
          <span>
            <strong>Deepbrief</strong>
            <small>CONTENT STUDIO</small>
          </span>
        </div>
        <div className="topbar-status">
          <span className="status-dot" />
          İstanbul · {today}
        </div>
        <button
          className="button button-primary"
          disabled={exporting}
          onClick={() => void exportPackage()}
          type="button"
        >
          {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
          {exporting ? 'Hazırlanıyor' : 'Paketi indir'}
        </button>
      </header>

      <div className="workspace">
        <aside className="control-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">YENİ İÇERİK</span>
              <h1>Gönderiyi düzenle</h1>
            </div>
            <span className="no-ai-badge"><ShieldCheck size={12} /> AI işlemleri yalnızca düğmeyle çalışır</span>
          </div>

          <div className="channel-tabs" aria-label="Kanal seçimi">
            {channels.map((item) => (
              <button
                className={item.id === channel ? 'channel-tab active' : 'channel-tab'}
                key={item.id}
                onClick={() => changeChannel(item.id)}
                type="button"
              >
                <span>{item.label}</span>
                <small>{item.language}</small>
              </button>
            ))}
          </div>

          <section className="source-section">
            <div className="source-heading">
              <div>
                <span className="eyebrow">BUGÜNÜN KAYNAKLARI</span>
                <h2>
                  {channel === 'history'
                    ? 'Tarihte bugün'
                    : channel === 'media' ? 'Medya gündemi' : 'Türkiye’de yükselenler'}
                </h2>
              </div>
              <button aria-label="Kaynakları yenile" className="icon-button" disabled={loading} onClick={() => void scanSources(true)} type="button">
                <RefreshCw className={loading ? 'spin' : ''} size={15} />
              </button>
            </div>

            <div className="source-strip">
              <span><i className="live-dot" /> Canlı · kaynak tarihi kontrollü</span>
              <span>İstanbul tarihi · {today}</span>
            </div>

            {discovery?.coverage && (
              <div aria-label="Liste filtreleri" className="coverage-grid" role="group">
                <button
                  aria-label="Tüm olayları göster"
                  aria-pressed={candidateFilters.size === 0}
                  className={`coverage-filter ${candidateFilters.size === 0 ? 'active' : ''}`}
                  onClick={clearCandidateFilters}
                  type="button"
                >
                  <b>{discovery.coverage.uniqueEvents}</b> olay
                </button>
                <button
                  aria-pressed={candidateFilters.has('corroborated')}
                  className={`coverage-filter ${candidateFilters.has('corroborated') ? 'active' : ''}`}
                  onClick={() => toggleCandidateFilter('corroborated')}
                  type="button"
                >
                  <b>{discovery.coverage.corroboratedEvents}</b> çok kaynaklı
                </button>
                <button
                  aria-pressed={candidateFilters.has('with-image')}
                  className={`coverage-filter ${candidateFilters.has('with-image') ? 'active' : ''}`}
                  onClick={() => toggleCandidateFilter('with-image')}
                  type="button"
                >
                  <b>{discovery.coverage.withImages}</b> görselli
                </button>
                <button
                  aria-pressed={candidateFilters.has('with-location')}
                  className={`coverage-filter ${candidateFilters.has('with-location') ? 'active' : ''}`}
                  onClick={() => toggleCandidateFilter('with-location')}
                  type="button"
                >
                  <b>{discovery.coverage.withLocations}</b> konumlu
                </button>
              </div>
            )}

            {(discovery?.warnings?.length ?? 0) > 0 && (
              <div className="source-warnings">
                {discovery?.warnings?.map((warning) => <span key={warning}>{warning}</span>)}
              </div>
            )}

            <label className="source-search">
              <Search size={13} />
              <input aria-label="Kaynaklarda ara" onChange={(event) => setSearch(event.target.value)} placeholder="Başlık veya kaynak ara" value={search} />
            </label>

            <div className="candidate-list" aria-live="polite">
              {loading && Array.from({ length: 4 }).map((_, index) => <span className="candidate-skeleton" key={index} />)}
              {!loading && discoveryError && (
                <div className="source-error">
                  <p>{discoveryError}</p>
                  <button onClick={() => void scanSources(true)} type="button">Yeniden dene</button>
                </div>
              )}
              {!loading && !discoveryError && visibleCandidates.map((candidate) => (
                <CandidateCard
                  candidate={candidate}
                  key={candidate.id}
                  loading={enrichingId === candidate.id}
                  onSelect={() => void selectCandidate(candidate)}
                />
              ))}
              {!loading && !discoveryError && visibleCandidates.length === 0 && (
                <p className="empty-results">Bugüne ait eşleşen kaynak bulunamadı.</p>
              )}
            </div>

            {!loading && filteredCandidates.length > 6 && (
              <button className="show-more" onClick={toggleCandidateList} type="button">
                {showAll ? 'İlk 6 kaynağı göster' : `Tümünü göster (${filteredCandidates.length})`}
              </button>
            )}

            <div className="connector-heading">
              <strong>Kaynak bağlantıları</strong>
              <small>Yeşil olanlar bugünün verisini sağlıyor</small>
            </div>
            <div className="connector-status">
              {(discovery?.sourceStatus ?? []).map((source) => (
                <span
                  className={`connector-${source.status}`}
                  key={source.id}
                  title={source.status === 'needs-key'
                    ? 'API anahtarı eklendiğinde etkinleşir'
                    : source.status === 'unavailable'
                      ? `Kaynağa şu anda ulaşılamıyor · ${source.detail || ''}`
                      : `${source.candidateCount ?? 0} aday · ${source.detail || 'Bugünün verisi alınıyor'}`}
                >
                  {source.status === 'active' && <Check size={9} />}
                  {source.label}
                </span>
              ))}
            </div>
            {groqStatus?.configured && (
              <div className="groq-budget">
                <span><ShieldCheck size={11} /> Groq {groqChecking ? 'kontrol ediyor…' : 'kota korumalı'}</span>
                <small>
                  Analiz {groqStatus.usage.analysis}/{groqStatus.usage.analysisLimit}
                  {' · '}arama {groqStatus.usage.search}/{groqStatus.usage.searchLimit}
                  {' · '}{groqStatus.keyCount} anahtar
                </small>
              </div>
            )}
            {(copyConfigured || upscaleConfigured) && (
              <div className="groq-budget openai-budget">
                <span><Sparkles size={11} /> OpenAI maliyet koruması</span>
                <small>
                  Metin {copyUsage?.requests ?? 0}/{copyUsage?.limit ?? 40}
                  {' · '}görsel {upscaleUsage?.requests ?? 0}/{upscaleUsage?.limit ?? 6}
                </small>
              </div>
            )}
          </section>

          <section className="form-section">
            <div className="section-title">
              <span>01</span>
              <div>
                <h2>Görsel</h2>
                <p>Kaynak görselini kullan veya kendi dosyanı yükle.</p>
              </div>
            </div>
            <label className="upload-field">
              <input
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => {
                  loadImage(event.target.files?.[0]);
                  event.target.value = '';
                }}
                type="file"
              />
              <span className="upload-icon"><ImagePlus size={17} /></span>
              <span>
                <strong>Görsel seç</strong>
                <small>JPG, PNG veya WEBP · en fazla 12 MB</small>
              </span>
            </label>
            <div className={`image-quality-row ${isPublicationQuality(draft.imageWidth, draft.imageHeight) ? 'quality-good' : 'quality-low'}`}>
              <span>Kaynak çözünürlüğü</span>
              <strong>
                {draft.imageWidth && draft.imageHeight
                  ? `${draft.imageWidth} × ${draft.imageHeight}px`
                  : 'Görsel seçilmedi'}
              </strong>
            </div>
            <button
              className="upscale-button"
              disabled={!draft.image || upscaling || upscaleConfigured !== true}
              onClick={() => void upscaleImage()}
              type="button"
            >
              {upscaling ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span>
                <strong>{upscaling ? 'Kalite artırılıyor…' : 'Görsel kalitesini artır'}</strong>
                <small>
                  {upscaleConfigured === null
                    ? 'API durumu kontrol ediliyor'
                    : upscaleConfigured
                      ? 'Dengeli mod · medium kalite · maks. 1920px · ücretli'
                      : 'OPENAI_API_KEY gerekli'}
                </small>
              </span>
            </button>

            <div className="crop-card">
              <div className="crop-topline">
                <span><SlidersHorizontal size={13} /> Kırpma</span>
                <button onClick={() => updateCrop(defaultCrop)} type="button"><RotateCcw size={11} /> Sıfırla</button>
              </div>
              <div className="crop-tabs">
                <button className={cropTarget === 'cover' ? 'active' : ''} onClick={() => setCropTarget('cover')} type="button">Kapak · 9:16</button>
                <button className={cropTarget === 'detail' ? 'active' : ''} onClick={() => setCropTarget('detail')} type="button">Gönderi · 3:4</button>
              </div>
              <label className="range-field">
                <span>Yakınlık <b>%{Math.round(crop.zoom * 100)}</b></span>
                <input max="1.8" min="1" onChange={(event) => updateCrop({ zoom: Number(event.target.value) })} step="0.01" type="range" value={crop.zoom} />
              </label>
              <label className="range-field">
                <span>Yatay konum <b>%{crop.x}</b></span>
                <input max="100" min="0" onChange={(event) => updateCrop({ x: Number(event.target.value) })} type="range" value={crop.x} />
              </label>
              <label className="range-field">
                <span>Dikey konum <b>%{crop.y}</b></span>
                <input max="100" min="0" onChange={(event) => updateCrop({ y: Number(event.target.value) })} type="range" value={crop.y} />
              </label>
            </div>
          </section>

          <section className="form-section">
            <div className="section-title">
              <span>02</span>
              <div>
                <h2>Metin ve konum</h2>
                <p>Kaynak metnini yayın dilinde elle son hâline getir.</p>
              </div>
            </div>

            {draft.sourceName && (
              <div className="selected-source">
                <span>
                  Kaynak: <b>{draft.sourceName}</b>
                  <i className={`draft-freshness freshness-${draft.sourceFreshnessStatus}`}>
                    {freshnessLabel(draft.sourceFreshnessStatus)}
                  </i>
                </span>
                {draft.sourceUrl && <a href={draft.sourceUrl} rel="noreferrer" target="_blank">Haberi aç <ExternalLink size={10} /></a>}
              </div>
            )}

            <button
              className="upscale-button copy-button"
              disabled={!draft.sourceTitle || !draft.sourceSummary || Boolean(enrichingId) || generatingCopy || copyConfigured !== true}
              onClick={() => void generateCopy()}
              type="button"
            >
              {generatingCopy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span>
                <strong>{generatingCopy ? 'Metinler üretiliyor…' : 'API ile metinleri oluştur'}</strong>
                <small>
                  {copyConfigured === null
                    ? 'API durumu kontrol ediliyor'
                    : copyConfigured
                      ? 'Kaynak tabanlı · 3 metin · GPT-5.6 Luna · ücretli'
                      : 'OPENAI_API_KEY gerekli'}
                </small>
              </span>
            </button>

            <label className="field-label" htmlFor="title">
              Kısa kapak başlığı <span>{wordCount(draft.title)} kelime · {draft.title.length}/105</span>
            </label>
            <textarea
              className={`text-input title-input ${draft.title && (wordCount(draft.title) < 3 || wordCount(draft.title) > 15 || draft.title.length > 105 || hasIncompleteEnding(draft.title)) ? 'field-warning' : ''}`}
              id="title"
              maxLength={105}
              onChange={(event) => updateDraft({ title: event.target.value })}
              rows={3}
              value={draft.title}
            />

            <label className="field-label" htmlFor="body">
              Görsel içi gönderi metni <span>{wordCount(draft.body)} kelime · hedef 18–30</span>
            </label>
            <textarea
              className={`text-input ${draft.body && (wordCount(draft.body) < 12 || wordCount(draft.body) > 36 || hasIncompleteEnding(draft.body) || !hasCompleteSentenceEnding(draft.body)) ? 'field-warning' : ''}`}
              id="body"
              maxLength={1_000}
              onChange={(event) => updateDraft({ body: event.target.value })}
              rows={7}
              value={draft.body}
            />

            <label className="field-label" htmlFor="caption">
              Gönderi açıklaması (caption) <span>{wordCount(draft.caption)} kelime · hedef 50–95</span>
            </label>
            <textarea
              className={`text-input ${draft.caption && (wordCount(draft.caption) < 50 || wordCount(draft.caption) > 95) ? 'field-warning' : ''}`}
              id="caption"
              maxLength={1_400}
              onChange={(event) => updateDraft({ caption: event.target.value })}
              placeholder="Instagram gönderi açıklaması"
              rows={6}
              value={draft.caption}
            />

            <label className="field-label" htmlFor="location">
              Konum <span>Beyaz çubukta değişen tek alan</span>
            </label>
            <input
              className={`text-input ${draft.location.trim() ? '' : 'field-warning'}`}
              id="location"
              maxLength={54}
              onChange={(event) => updateDraft({ location: event.target.value })}
              placeholder="Örn. İstanbul, Türkiye"
              value={draft.location}
            />
          </section>
        </aside>

        <section className="preview-stage">
          <div className="preview-heading">
            <div>
              <span className="eyebrow">CANLI ÖNİZLEME</span>
              <h2>Reels paketi</h2>
            </div>
            <div className="preview-key">
              <span><i className="key-dot key-dark" /> Thumbnail: daha koyu</span>
              <span><i className="key-dot key-light" /> Gönderi: daha açık</span>
            </div>
          </div>
          <ReelPreview channel={channel} coverRef={coverRef} detailRef={detailRef} draft={draft} />
          <div className="export-panel">
            <div>
              <Download size={16} />
              <span><strong>Paylaşıma hazır paket</strong><small>2 adet 1080 × 1920 JPG + caption + kaynak notu</small></span>
            </div>
            <button disabled={exporting} onClick={() => void exportPackage()} type="button">
              {exporting ? 'Hazırlanıyor…' : 'ZIP olarak indir'}
            </button>
          </div>
        </section>
      </div>

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
