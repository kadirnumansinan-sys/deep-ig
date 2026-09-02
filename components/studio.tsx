'use client';

import { upload } from '@vercel/blob/client';
import JSZip from 'jszip';
import { toJpeg } from 'html-to-image';
import {
  Check,
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
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MiniCropPreview, ReelPreview, type CropSettings } from '@/components/reel-preview';
import { filterCandidates, type CandidateFilter } from '@/lib/candidate-filters';
import type {
  Channel,
  ContentCandidate,
  DiscoveryResponse,
} from '@/lib/content';
import {
  completeExcerpt,
  hasCompleteSentenceEnding,
  hasIncompleteEnding,
  hasSufficientSourceDetail,
  stripSourceAttribution,
} from '@/lib/copy-guard';
import { loadStudioState, saveStudioState } from '@/lib/draft-storage';
import { isLanguageMatch } from '@/lib/language';
import { MusicPicker, type MusicSelection } from '@/components/music-picker';
import { musicCredit, suggestTrack, trackById, trackUrl } from '@/lib/music/catalog';
import { loadReelAudio } from '@/lib/video/audio';
import {
  encodeReel,
  videoExportSupported,
  REEL_DURATION_SEC,
  REEL_SOURCE_SCALE,
  REEL_WIDTH,
} from '@/lib/video/encode-reel';
import { CandidateCard } from '@/components/studio/candidate-card';
import { channels, defaultCrop, initialDrafts } from '@/components/studio/defaults';
import { SchedulePanel } from '@/components/studio/schedule-panel';
import type {
  CopyStatus,
  Draft,
  EnrichmentResponse,
  GapScanResponse,
  GeneratedCopyResponse,
  GroqAnalysisResponse,
  GroqStatusResponse,
  ImageOption,
  ProviderUsage,
  UpscaleStatus,
} from '@/components/studio/types';
import {
  blobToDataUrl,
  coverageFromCandidates,
  downloadBlob,
  freshnessLabel,
  isPublicationQuality,
  measureImage,
  prepareUpscaleBlob,
  proxied,
  restoreDraft,
  safeFileName,
  upscaleBlobLocally,
  waitForImages,
  wordCount,
} from '@/components/studio/utils';

// Tek render turunda üretilen medya: ZIP indirmede de planlı yayında da aynı çıktı kullanılır.
type BuiltMedia = {
  base: string;
  cover: string;
  detail: string;
  video: Blob | null;
  videoNote: string;
  musicNote: string | null;
};

// next.config.ts bu üçünü derleme sırasında hesaplar; webpack DefinePlugin satır içine gömer.
const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
const appBuild = process.env.NEXT_PUBLIC_APP_BUILD || 'dev';
const appCommit = process.env.NEXT_PUBLIC_APP_COMMIT || 'local';

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
  const [miniPreviewOpen, setMiniPreviewOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [musicSelection, setMusicSelection] = useState<Record<Channel, MusicSelection | null>>(() => ({
    history: null,
    news: null,
    international: null,
    media: null,
  }));
  const [enrichingId, setEnrichingId] = useState('');
  const [upscaling, setUpscaling] = useState(false);
  const [localEnhancing, setLocalEnhancing] = useState(false);
  const [upscaleConfigured, setUpscaleConfigured] = useState<boolean | null>(null);
  const [upscaleUsage, setUpscaleUsage] = useState<ProviderUsage | null>(null);
  const [generatingCopy, setGeneratingCopy] = useState(false);
  const [captionOnlyBusy, setCaptionOnlyBusy] = useState(false);
  const [copyConfigured, setCopyConfigured] = useState<boolean | null>(null);
  const [copyUsage, setCopyUsage] = useState<ProviderUsage | null>(null);
  const [groqCopy, setGroqCopy] = useState<
    { configured: boolean; requests: number; limit: number; providerOrder: string[] } | null
  >(null);
  // Ücretsiz havuzda sıra Gemini → Cerebras → Groq; etiket sabit "Groq" yazmak yerine
  // sunucudan gelen gerçek sırayı gösterir.
  const freePoolLabel = groqCopy?.providerOrder?.length
    ? groqCopy.providerOrder.join(' → ')
    : 'ücretsiz havuz';
  const [locating, setLocating] = useState(false);
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

  // Her kanala ilk açılışta ruh haline uygun bir parça ata; kullanıcı sonra değiştirebilir.
  // Seçim rastgele olduğu için useState başlatıcısında yapılamaz: SSR ile hydration uyuşmazdı.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMusicSelection((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of channels) {
        if (next[item.id]) continue;
        const track = suggestTrack(item.id);
        if (!track) continue;
        next[item.id] = { id: track.id, startSec: track.startSec };
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

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
    // Dar ekranda önizleme kırpma panelinin altında kalıyor; yüzen mini önizlemeyi aç.
    if (isNarrow) setMiniPreviewOpen(true);
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
          || Number(right.breaking === true) - Number(left.breaking === true)
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
          body: JSON.stringify({ channel: targetChannel, candidates: snapshot.candidates.slice(0, 24) }),
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
          || Number(right.breaking === true) - Number(left.breaking === true)
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
    const query = window.matchMedia('(max-width: 760px)');
    const apply = (matches: boolean) => {
      setIsNarrow(matches);
      if (!matches) setMiniPreviewOpen(false);
    };
    apply(query.matches);
    const listener = (event: MediaQueryListEvent) => apply(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

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
        setGroqCopy(body.groq
          ? {
            configured: Boolean(body.groq.configured),
            requests: body.groq.usage?.requests ?? 0,
            limit: body.groq.usage?.limit ?? 30,
            providerOrder: body.groq.providerOrder ?? [],
          }
          : null);
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
    const timer = window.setTimeout(() => setNotice(''), notice.length > 140 ? 6500 : 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function selectCandidate(candidate: ContentCandidate) {
    const targetChannel = channel;
    const warnings: string[] = [];
    if (candidate.freshnessStatus === 'stale') {
      warnings.push('Kaynak sayfası bugüne ait görünmüyor — tarihi kontrol et.');
    }
    const expectedLanguage = targetChannel === 'international' ? 'en' : 'tr';
    const cleanCandidateTitle = stripSourceAttribution(candidate.title, candidate.sourceName);
    const cleanCandidateSummary = stripSourceAttribution(candidate.summary, candidate.sourceName);
    if (!isLanguageMatch(`${cleanCandidateTitle} ${cleanCandidateSummary}`, expectedLanguage, candidate.sourceName)) {
      warnings.push(targetChannel === 'international'
        ? 'Metin İngilizce görünmüyor — kontrol et.'
        : 'Metin Türkçe görünmüyor — kontrol et.');
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
        imageOptions: [],
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
          // Dil kontrolü burada bilinçli olarak kalır: yabancı dilde cookie/boilerplate
          // metninin taslaktaki kaynak metnin üzerine yazılmasını engeller.
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
    // Madde 5: ölçülebilen tüm varyantlar saklanır; kullanıcı şeritten seçebilir.
    const measured: ImageOption[] = [];
    for (const variant of uniqueVariants) {
      try {
        const size = await measureImage(variant.src);
        measured.push({ ...variant, ...size });
      } catch {
        // Try the next source image.
      }
    }
    measured.sort((left, right) => right.width * right.height - left.width * left.height);
    const options = measured.slice(0, 10);
    const best = options[0] || null;

    if (selectionRequestRef.current !== requestId) return;
    if (best) {
      setDrafts((current) => ({
        ...current,
        [targetChannel]: {
          ...current[targetChannel],
          image: best.src,
          imageWidth: best.width,
          imageHeight: best.height,
          imageOptions: options,
        },
      }));
      const successNotice = isPublicationQuality(best.width, best.height)
        ? `${best.width} × ${best.height}px görsel ${best.origin} üzerinden alındı. Konumu girip metni kontrol et.`
        : `${best.width} × ${best.height}px görsel ${best.origin} üzerinden eklendi. İstersen “Görsel kalitesini artır” düğmesini kullanabilirsin.`;
      setNotice([successNotice, ...warnings].join(' '));
    } else {
      setNotice(['Kaynakta kullanılabilir görsel bulunamadı. Kendi görselini yükleyebilirsin.', ...warnings].join(' '));
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
        const uploaded: ImageOption = {
          src: reader.result as string,
          width: image.naturalWidth,
          height: image.naturalHeight,
          origin: 'yükleme',
        };
        setDrafts((current) => ({
          ...current,
          [channel]: {
            ...current[channel],
            image: uploaded.src,
            imageWidth: uploaded.width,
            imageHeight: uploaded.height,
            imageOptions: [
              uploaded,
              ...current[channel].imageOptions.filter((option) => option.src !== uploaded.src),
            ].slice(0, 10),
            coverCrop: { ...defaultCrop },
            detailCrop: { ...defaultCrop },
          },
        }));
        setNotice(!isPublicationQuality(image.naturalWidth, image.naturalHeight)
          ? `Görsel ${image.naturalWidth} × ${image.naturalHeight}px olarak eklendi. İstersen kalitesini artırabilirsin.`
          : 'Görsel yüklendi. Kapak ve gönderi kırpmasını ayrı ayrı ayarlayabilirsin.');
      };
      image.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  function chooseImageOption(option: ImageOption) {
    if (draft.image === option.src) return;
    updateDraft({
      image: option.src,
      imageWidth: option.width,
      imageHeight: option.height,
      coverCrop: { ...defaultCrop },
      detailCrop: { ...defaultCrop },
    });
    setNotice(`${option.width} × ${option.height}px görsel seçildi (${option.origin}). Kırpmalar sıfırlandı.`);
  }

  async function generateCopy(force?: 'openai', only?: 'caption') {
    if (force === 'openai' && copyConfigured !== true) {
      setNotice('OPENAI_API_KEY sunucuda ayarlı değil. .env dosyasına ekleyip Docker’ı yeniden başlat.');
      return;
    }
    if (copyConfigured !== true && groqCopy?.configured !== true) {
      setNotice('Metin üretimi için GROQ_API_KEY_1 veya OPENAI_API_KEY sunucuda ayarlı olmalı.');
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
    setCaptionOnlyBusy(only === 'caption');
    setNotice(only === 'caption'
      ? 'Yalnızca gönderi açıklaması hazırlanıyor…'
      : 'Kaynağa bağlı görsel metni ve caption hazırlanıyor…');
    try {
      const response = await fetch('/api/generate-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: targetChannel,
          ...source,
          ...(force === 'openai' ? { provider: 'openai' } : {}),
        }),
      });
      const body = await response.json().catch(() => ({ error: '' })) as GeneratedCopyResponse;
      if (!response.ok || !body.coverTitle || !body.visualText || !body.caption) {
        throw new Error(body.error || 'Metinler üretilemedi.');
      }

      // Sadece-caption modunda kapak ve gönderi metni korunur; kullanıcı beğendiği
      // yazıları kaybetmeden açıklamayı yeniden üretebilir.
      setDrafts((current) => ({
        ...current,
        [targetChannel]: only === 'caption'
          ? { ...current[targetChannel], caption: body.caption || current[targetChannel].caption }
          : {
            ...current[targetChannel],
            title: body.coverTitle
              ? body.coverTitle.toLocaleUpperCase(targetChannel === 'international' ? 'en-US' : 'tr-TR')
              : current[targetChannel].title,
            body: body.visualText || current[targetChannel].body,
            caption: body.caption || current[targetChannel].caption,
          },
      }));
      const providerLabel = body.provider === 'groq' ? `${freePoolLabel} (ücretsiz)` : 'OpenAI';
      setNotice(only === 'caption'
        ? `Gönderi açıklaması ${providerLabel} ile yenilendi: ${body.wordCounts?.caption ?? wordCount(body.caption)} kelime. Kapak ve gönderi metni değişmedi.`
        : `Metinler ${providerLabel} ile tamamlandı: kapak ${body.wordCounts?.coverTitle ?? wordCount(body.coverTitle)} kelime, gönderi ${body.wordCounts?.visualText ?? wordCount(body.visualText)} kelime, caption ${body.wordCounts?.caption ?? wordCount(body.caption)} kelime.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Metinler üretilemedi.');
    } finally {
      setGeneratingCopy(false);
      setCaptionOnlyBusy(false);
      void fetch('/api/generate-copy', { cache: 'no-store' })
        .then((response) => response.json() as Promise<CopyStatus>)
        .then((status) => {
          setCopyUsage(status.usage || null);
          if (status.groq) {
            setGroqCopy({
              configured: Boolean(status.groq.configured),
              requests: status.groq.usage?.requests ?? 0,
              limit: status.groq.usage?.limit ?? 30,
              providerOrder: status.groq.providerOrder ?? [],
            });
          }
        })
        .catch(() => undefined);
    }
  }

  async function findLocation() {
    const title = draft.sourceTitle.trim() || draft.title.trim();
    if (!title) {
      setNotice('Konum bulmak için önce bir haber seç veya başlık gir.');
      return;
    }
    setLocating(true);
    try {
      const response = await fetch('/api/groq/locate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          title,
          body: draft.sourceSummary.trim() || draft.body.trim(),
          sourceName: draft.sourceName,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        location?: { label?: string } | null;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || 'Konum bulunamadı.');
      if (payload.location?.label) {
        updateDraft({ location: payload.location.label });
        setNotice(`Konum bulundu: ${payload.location.label}`);
      } else {
        setNotice('Kaynak metinde açık bir konum yok; elle girebilirsin.');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Konum bulunamadı; elle girebilirsin.');
    } finally {
      setLocating(false);
    }
  }

  async function enhanceImageLocally() {
    if (!draft.image) {
      setNotice('Önce bir görsel seç veya yükle.');
      return;
    }
    if (isPublicationQuality(draft.imageWidth, draft.imageHeight)) {
      setNotice('Görsel zaten yeterli çözünürlükte; iyileştirme gerekmiyor.');
      return;
    }
    const targetChannel = channel;
    setLocalEnhancing(true);
    setNotice('Görsel tarayıcıda yüksek kaliteyle yeniden örnekleniyor…');
    try {
      const sourceResponse = await fetch(draft.image, { cache: 'no-store' });
      if (!sourceResponse.ok) throw new Error('Kaynak görsel indirilemedi.');
      const upscaled = await upscaleBlobLocally(await sourceResponse.blob());
      if (!upscaled) throw new Error('Bu görsel yerel olarak büyütülemedi.');
      const dataUrl = await blobToDataUrl(upscaled.blob);
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
      setNotice(`Görsel ücretsiz yerel yöntemle ${size.width} × ${size.height}px boyutuna yükseltildi.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Görsel yerel olarak iyileştirilemedi.');
    } finally {
      setLocalEnhancing(false);
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

  // Medya üretimi hem ZIP indirmede hem de planlı yayında kullanıldığı için tek yerde toplandı.
  async function buildMedia(): Promise<BuiltMedia> {
    if (!coverRef.current || !detailRef.current) throw new Error('Önizleme henüz hazır değil.');
    await document.fonts.ready;
    await Promise.all([waitForImages(coverRef.current), waitForImages(detailRef.current)]);

    async function render(node: HTMLDivElement, targetWidth = REEL_WIDTH) {
      const ratio = targetWidth / node.offsetWidth;
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

    // Gönderi kartından 7 saniyelik, hafif zoom'lu MP4. Kapak görseli JPG olarak kalır.
    let video: Blob | null = null;
    let musicNote: string | null = null;
    let videoNote = 'video atlandı (tarayıcı desteklemiyor, Chrome/Edge gerekli)';
    if (videoExportSupported()) {
      setNotice('7 saniyelik video hazırlanıyor…');
      const selection = musicSelection[channel];
      const track = selection ? trackById(selection.id) : null;
      // Zoom'un hiçbir anında büyütme olmaması için kaynak kareyi 1080'in üstünde üret.
      const frameSource = await render(detailRef.current, Math.round(REEL_WIDTH * REEL_SOURCE_SCALE));
      const bitmap = await createImageBitmap(await (await fetch(frameSource)).blob());
      let audio = null;
      let trackNote = 'müziksiz';
      if (track && selection) {
        try {
          audio = await loadReelAudio({
            url: trackUrl(track),
            startSec: selection.startSec,
            durationSec: REEL_DURATION_SEC,
            gain: track.gain,
          });
          trackNote = track.title;
        } catch {
          trackNote = 'müzik yüklenemedi, sessiz';
        }
      }
      try {
        const { blob, hasAudio } = await encodeReel({
          image: bitmap,
          audio,
          onProgress: setExportProgress,
        });
        video = blob;
        if (track && hasAudio) musicNote = musicCredit(track);
        videoNote = hasAudio ? `video: ${trackNote}` : 'video: sessiz';
      } finally {
        bitmap.close();
      }
    }

    return { base, cover, detail, video, videoNote, musicNote };
  }

  async function exportPackage() {
    if (!coverRef.current || !detailRef.current) return;
    setExporting(true);
    setExportProgress(0);
    setNotice('1080 × 1920 dosyalar hazırlanıyor…');
    try {
      const media = await buildMedia();
      const zip = new JSZip();
      zip.file(`${media.base}-thumbnail.jpg`, media.cover.split(',')[1], { base64: true });
      zip.file(`${media.base}-gonderi.jpg`, media.detail.split(',')[1], { base64: true });
      zip.file(`${media.base}-caption.txt`, draft.caption.trim());
      zip.file(`${media.base}-kaynak.txt`, [
        `Kanal: ${channel}`,
        `Tarih: ${today}`,
        `Kaynak: ${draft.sourceName || '-'}`,
        `Bağlantı: ${draft.sourceUrl || '-'}`,
        `Konum: ${draft.location || '-'}`,
        `Tazelik: ${draft.sourceFreshnessStatus}`,
      ].join('\n'));
      if (media.video) zip.file(`${media.base}-gonderi.mp4`, media.video);
      if (media.musicNote) zip.file(`${media.base}-muzik.txt`, media.musicNote);

      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${media.base}.zip`);
      setNotice(`Reels paketi indirildi: thumbnail, gönderi, caption, kaynak notu · ${media.videoNote}.`);
    } catch (error) {
      setNotice(error instanceof Error ? `Dışa aktarma başarısız: ${error.message}` : 'Dışa aktarma başarısız.');
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  }

  // Instagram medyayı herkese açık bir HTTPS adresinden çektiği için önce Blob'a yüklenir,
  // sonra kayıt kuyruğa yazılır. Yayını cron (/api/internal/publish) yapar.
  async function schedulePost(scheduledAt: Date) {
    if (!videoExportSupported()) {
      throw new Error('Bu tarayıcı video dışa aktarmayı desteklemiyor; Chrome veya Edge gerekli.');
    }
    setExporting(true);
    setExportProgress(0);
    setNotice('Yayın için medya hazırlanıyor…');
    try {
      const media = await buildMedia();
      if (!media.video) throw new Error('Video üretilemedi, planlama iptal edildi.');

      setNotice('Medya Blob deposuna yükleniyor…');
      const uploadOptions = { access: 'public', handleUploadUrl: '/api/blob/upload' } as const;
      const [videoBlob, coverBlob] = await Promise.all([
        upload(`deepbrief/${media.base}.mp4`, media.video, {
          ...uploadOptions,
          contentType: 'video/mp4',
        }),
        upload(`deepbrief/${media.base}-kapak.jpg`, await (await fetch(media.cover)).blob(), {
          ...uploadOptions,
          contentType: 'image/jpeg',
        }),
      ]);

      const response = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          caption: draft.caption.trim(),
          videoUrl: videoBlob.url,
          coverUrl: coverBlob.url,
          scheduledAt: scheduledAt.toISOString(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || 'Yayın planlanamadı.');
      setNotice(
        `Yayın planlandı: ${new Intl.DateTimeFormat('tr-TR', {
          timeZone: 'Europe/Istanbul',
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(scheduledAt)} · ${media.videoNote}.`,
      );
    } finally {
      setExporting(false);
      setExportProgress(0);
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
          <span className="brand-version" title={`Sürüm ${appVersion} · derleme ${appBuild} · commit ${appCommit}`}>
            v{appVersion}
            <em>{appBuild}</em>
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
                {discovery.coverage.conflictingEvents > 0 && (
                  <button
                    aria-pressed={candidateFilters.has('conflict')}
                    className={`coverage-filter conflict ${candidateFilters.has('conflict') ? 'active' : ''}`}
                    onClick={() => toggleCandidateFilter('conflict')}
                    type="button"
                  >
                    <b>{discovery.coverage.conflictingEvents}</b> çelişkili
                  </button>
                )}
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
                <span>
                  <ShieldCheck size={11} />
                  {' '}{groqStatus.providerOrder?.join(' → ') || 'Ücretsiz havuz'}
                  {' '}{groqChecking ? 'kontrol ediyor…' : 'kota korumalı'}
                </span>
                <small>
                  Analiz {groqStatus.usage.analysis}/{groqStatus.usage.analysisLimit}
                  {' · '}arama {groqStatus.usage.search}/{groqStatus.usage.searchLimit}
                  {' · '}{groqStatus.keyCount} anahtar
                </small>
              </div>
            )}
            {(copyConfigured || upscaleConfigured || groqCopy?.configured) && (
              <div className="groq-budget openai-budget">
                <span><Sparkles size={11} /> Metin/görsel maliyet koruması</span>
                <small>
                  Metin OpenAI {copyUsage?.requests ?? 0}/{copyUsage?.limit ?? 40}
                  {groqCopy?.configured ? ` · ücretsiz havuz ${groqCopy.requests}/${groqCopy.limit}` : ''}
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
            {draft.imageOptions.length > 1 && (
              <>
                <label className="field-label">
                  Görsel seçenekleri <span>{draft.imageOptions.length} görsel bulundu</span>
                </label>
                <div className="image-options-strip">
                  {draft.imageOptions.map((option) => (
                    <button
                      className={`image-option ${draft.image === option.src ? 'active' : ''}`}
                      key={option.src.slice(0, 200)}
                      onClick={() => chooseImageOption(option)}
                      title={`${option.width} × ${option.height}px · ${option.origin}`}
                      type="button"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img alt="" loading="lazy" src={option.src} />
                      <small>{option.width}×{option.height}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
            <button
              className="upscale-button"
              disabled={!draft.image || localEnhancing || upscaling || isPublicationQuality(draft.imageWidth, draft.imageHeight)}
              onClick={() => void enhanceImageLocally()}
              type="button"
            >
              {localEnhancing ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span>
                <strong>{localEnhancing ? 'İyileştiriliyor…' : 'Kaliteyi iyileştir (ücretsiz)'}</strong>
                <small>
                  {draft.image && isPublicationQuality(draft.imageWidth, draft.imageHeight)
                    ? 'Görsel zaten yeterli çözünürlükte'
                    : 'Yerel yüksek kaliteli yeniden örnekleme · ücretsiz'}
                </small>
              </span>
            </button>
            <button
              className="upscale-button"
              disabled={!draft.image || upscaling || localEnhancing || upscaleConfigured !== true || isPublicationQuality(draft.imageWidth, draft.imageHeight)}
              onClick={() => void upscaleImage()}
              type="button"
            >
              {upscaling ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span>
                <strong>{upscaling ? 'Kalite artırılıyor…' : 'AI ile iyileştir (OpenAI)'}</strong>
                <small>
                  {upscaleConfigured === null
                    ? 'API durumu kontrol ediliyor'
                    : !upscaleConfigured
                      ? 'OPENAI_API_KEY gerekli'
                      : draft.image && isPublicationQuality(draft.imageWidth, draft.imageHeight)
                        ? 'Görsel zaten yeterli çözünürlükte'
                        : 'Dengeli mod · medium kalite · maks. 1920px · ücretli'}
                </small>
              </span>
            </button>

            <div className="crop-card">
              <div className="crop-topline">
                <span><SlidersHorizontal size={13} /> Kırpma</span>
                <button
                  className="crop-preview-toggle"
                  onClick={() => setMiniPreviewOpen((open) => !open)}
                  type="button"
                >
                  {miniPreviewOpen ? 'Önizlemeyi kapat' : 'Önizleme'}
                </button>
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
              disabled={!draft.sourceTitle || !draft.sourceSummary || Boolean(enrichingId) || generatingCopy || (copyConfigured !== true && groqCopy?.configured !== true)}
              onClick={() => void generateCopy()}
              type="button"
            >
              {generatingCopy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span>
                <strong>{generatingCopy ? 'Metinler üretiliyor…' : 'API ile metinleri oluştur'}</strong>
                <small>
                  {copyConfigured === null
                    ? 'API durumu kontrol ediliyor'
                    : groqCopy?.configured
                      ? `Önce ${freePoolLabel} (ücretsiz) · gerekirse OpenAI`
                      : copyConfigured
                        ? 'Kaynak tabanlı · 3 metin · GPT-5.6 Luna · ücretli'
                        : 'GEMINI_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY_1 veya OPENAI_API_KEY gerekli'}
                </small>
              </span>
            </button>

            {copyConfigured === true && groqCopy?.configured === true && (
              <button
                className="upscale-button copy-button"
                disabled={!draft.sourceTitle || !draft.sourceSummary || Boolean(enrichingId) || generatingCopy}
                onClick={() => void generateCopy('openai')}
                type="button"
              >
                <Sparkles size={16} />
                <span>
                  <strong>OpenAI ile yeniden üret</strong>
                  <small>Groq sonucu beğenmediysen · GPT-5.6 Luna · ücretli</small>
                </span>
              </button>
            )}

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

            {/* Kapak ve gönderi metnini beğendiysen sadece açıklamayı yenilemek için. */}
            <button
              className="upscale-button copy-button caption-only-button"
              disabled={!draft.sourceTitle || !draft.sourceSummary || Boolean(enrichingId) || generatingCopy || (copyConfigured !== true && groqCopy?.configured !== true)}
              onClick={() => void generateCopy(undefined, 'caption')}
              type="button"
            >
              {captionOnlyBusy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span>
                <strong>{captionOnlyBusy ? 'Açıklama üretiliyor…' : 'Sadece açıklamayı üret'}</strong>
                <small>
                  {copyConfigured === null
                    ? 'API durumu kontrol ediliyor'
                    : groqCopy?.configured
                      ? `Sadece caption · önce ${freePoolLabel} (ücretsiz) · gerekirse OpenAI`
                      : copyConfigured
                        ? 'Sadece caption · GPT-5.6 Luna · ücretli'
                        : 'GEMINI_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY_1 veya OPENAI_API_KEY gerekli'}
                </small>
              </span>
            </button>

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
            <div className="location-row">
              <input
                className={`text-input ${draft.location.trim() ? '' : 'field-warning'}`}
                id="location"
                maxLength={54}
                onChange={(event) => updateDraft({ location: event.target.value })}
                placeholder="Örn. İstanbul, Türkiye"
                value={draft.location}
              />
              <button
                className="locate-button"
                disabled={locating || (!draft.sourceTitle.trim() && !draft.title.trim())}
                onClick={() => void findLocation()}
                title="Kaynak metinden konumu Groq ile bul"
                type="button"
              >
                {locating ? <LoaderCircle className="spin" size={12} /> : <MapPin size={12} />}
                Konum bul
              </button>
            </div>
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
          <MusicPicker
            channel={channel}
            disabled={exporting}
            onChange={(selection) => setMusicSelection((current) => ({ ...current, [channel]: selection }))}
            selection={musicSelection[channel]}
          />
          <div className="export-panel">
            <div>
              <Download size={16} />
              <span><strong>Paylaşıma hazır paket</strong><small>2 adet 1080 × 1920 JPG + 7 sn MP4 + caption + kaynak notu</small></span>
            </div>
            <button disabled={exporting} onClick={() => void exportPackage()} type="button">
              {exporting
                ? exportProgress > 0
                  ? `Video %${Math.round(exportProgress * 100)}`
                  : 'Hazırlanıyor…'
                : 'ZIP olarak indir'}
            </button>
          </div>
          <SchedulePanel
            busy={exporting}
            channel={channel}
            onSchedule={schedulePost}
            progress={exportProgress}
          />
        </section>
      </div>

      {isNarrow && miniPreviewOpen && (
        <div className="mini-preview">
          <button
            aria-label="Mini önizlemeyi kapat"
            className="mini-preview-close"
            onClick={() => setMiniPreviewOpen(false)}
            type="button"
          >
            <X size={12} />
          </button>
          <MiniCropPreview channel={channel} draft={draft} target={cropTarget} />
        </div>
      )}

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
