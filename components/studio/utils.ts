import type { ContentCandidate, DiscoveryResponse, FreshnessStatus } from '@/lib/content';
import {
  completeExcerpt,
  containsPublisherLanguage,
  hasCompleteSentenceEnding,
  hasIncompleteEnding,
  hasRepeatedPhrase,
  stripSourceAttribution,
} from '@/lib/copy-guard';
import type { Draft } from '@/components/studio/types';

export const minimumImageWidth = 1080;
export const minimumImageHeight = 650;

/** Dış görselleri kendi proxy'imizden geçirir; doğrudan çekim CORS'a takılır. */
export function proxied(url: string, signature = ''): string {
  if (!url || url.startsWith('data:') || url.startsWith('/api/image?')) return url;
  const token = signature ? `&signature=${encodeURIComponent(signature)}` : '';
  return `/api/image?url=${encodeURIComponent(url)}${token}`;
}

/** Kayıtlı taslağı geri yüklerken bozuk ya da yayıncı diline kaçmış metni kaynağınkiyle değiştirir. */
export function restoreDraft(base: Draft, saved?: Partial<Draft>): Draft {
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
    imageOptions: Array.isArray(merged.imageOptions) ? merged.imageOptions : [],
  };
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Bugün';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function safeFileName(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    // NFD ayrıştırmasından kalan birleştirici işaretleri (şapka, çengel) atar.
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42) || 'icerik';
}

export function wordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

// Açıklamanın sonundaki 5 etiket hedef kelime aralığına dahil değil.
export function captionWordCount(value: string): number {
  return value.trim()
    ? value.trim().split(/\s+/u).filter((word) => !word.startsWith('#')).length
    : 0;
}

export function downloadBlob(blob: Blob, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export async function waitForImages(node: HTMLElement) {
  const images = Array.from(node.querySelectorAll('img'));
  await Promise.all(images.map((image) => {
    const source = image.currentSrc || image.src;
    const failure = new Error(`Görsel yüklenemedi: ${source.startsWith('data:') ? 'gömülü görsel' : source}`);
    if (image.complete) {
      return image.naturalWidth > 0 ? Promise.resolve() : Promise.reject(failure);
    }
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Görseller 20 saniyede yüklenemedi.')), 20_000);
      image.addEventListener('load', () => { window.clearTimeout(timer); resolve(); }, { once: true });
      image.addEventListener('error', () => { window.clearTimeout(timer); reject(failure); }, { once: true });
    });
  }));
}

export function isPublicationQuality(width: number, height: number): boolean {
  return width >= minimumImageWidth && height >= minimumImageHeight;
}

export function measureImage(src: string): Promise<{ width: number; height: number }> {
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

export function blobToDataUrl(blob: Blob): Promise<string> {
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

export async function prepareUpscaleBlob(blob: Blob): Promise<Blob> {
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

export async function upscaleBlobLocally(blob: Blob): Promise<{ blob: Blob; width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const source = await createImageBitmap(blob);
  // En fazla 2x: bikübik büyütme detay eklemez, aşırı büyütme bulanıklaştırır.
  const scale = Math.min(2, minimumImageWidth / source.width, 1920 / source.height);
  if (scale <= 1.01) {
    source.close();
    return null;
  }
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);

  let resized: ImageBitmap | null = null;
  try {
    resized = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  } catch {
    resized = null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    source.close();
    resized?.close();
    return null;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(resized ?? source, 0, 0, width, height);
  source.close();
  resized?.close();

  const result = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/webp', 0.95);
  });
  if (!result) return null;
  return { blob: result, width, height };
}

export function freshnessLabel(status?: FreshnessStatus): string {
  if (status === 'today') return 'Bugün doğrulandı';
  if (status === 'updated-today') return 'Bugün güncellendi';
  if (status === 'stale') return 'Bugüne ait değil';
  return 'Tarih kontrol edilecek';
}

/** Ekrandaki aday listesinden kapsama sayaçlarını yeniden hesaplar. */
export function coverageFromCandidates(
  candidates: ContentCandidate[],
  fallback?: DiscoveryResponse['coverage'],
): NonNullable<DiscoveryResponse['coverage']> {
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
    aiAnalyzed: candidates.filter((candidate) => Boolean(candidate.aiAnalysis)).length,
    aiPromoted: candidates.filter((candidate) => (
      Boolean(candidate.aiAnalysis) && candidate.score > (candidate.scoreBreakdown?.total || candidate.score)
    )).length || fallback?.aiPromoted || 0,
  };
}
