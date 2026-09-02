import type { CropSettings, DraftContent } from '@/components/reel-preview';
import type { ContentCandidate, FreshnessStatus } from '@/lib/content';

export type { CropSettings };

/** Bir habere aday görselin adresi ve ölçüleri. */
export type ImageOption = {
  src: string;
  width: number;
  height: number;
  origin: string;
};

/** Ekranda düzenlenen tek bir içerik paketi. */
export type Draft = DraftContent & {
  caption: string;
  sourceName: string;
  sourceUrl: string;
  sourceToken: string;
  sourceTitle: string;
  sourceSummary: string;
  imageWidth: number;
  imageHeight: number;
  imageOptions: ImageOption[];
  sourceFreshnessStatus: FreshnessStatus;
};

export type ProviderUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  limit: number;
};

export type EnrichmentResponse = {
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

export type UpscaleStatus = {
  configured: boolean;
  provider: string;
  usage?: ProviderUsage;
};

export type CopyStatus = {
  configured: boolean;
  provider: string;
  model: string;
  usage?: ProviderUsage;
  groq?: {
    configured: boolean;
    model: string;
    /** Ücretsiz havuzun deneme sırası, örn. ["Gemini", "Cerebras", "Groq #1"]. */
    providerOrder?: string[];
    usage?: { requests: number; limit: number };
  };
};

export type GeneratedCopyResponse = {
  coverTitle?: string;
  visualText?: string;
  caption?: string;
  wordCounts?: { coverTitle: number; visualText: number; caption: number };
  provider?: string;
  model?: string;
  error?: string;
};

export type GroqStatusResponse = {
  configured: boolean;
  keyCount: number;
  analysisModel: string;
  searchModel: string;
  /** Ücretsiz havuzun deneme sırası, örn. ["Gemini", "Cerebras", "Groq #1"]. */
  providerOrder?: string[];
  usage: {
    date: string;
    analysis: number;
    analysisLimit: number;
    search: number;
    searchLimit: number;
  };
};

export type GroqAnalysisResponse = {
  candidates?: ContentCandidate[];
  analyzed?: number;
  error?: string;
};

export type GapScanResponse = {
  candidates?: ContentCandidate[];
  error?: string;
};
