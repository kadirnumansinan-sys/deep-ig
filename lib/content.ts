export type Channel = 'history' | 'news' | 'international' | 'media';

export type FreshnessStatus = 'today' | 'updated-today' | 'unverified' | 'stale';
export type VerificationStatus = 'corroborated' | 'single-source' | 'unverified' | 'conflict';

export type CandidateLocation = {
  city: string;
  country: string;
  label: string;
  confidence: number;
  method: 'source' | 'rules' | 'groq' | 'manual' | 'unknown';
};

export type CandidateScore = {
  total: number;
  freshness: number;
  sourceTrust: number;
  crossSource: number;
  trend: number;
  channelFit: number;
  imageReadiness: number;
  novelty: number;
};

/** Aynı olayda kaynakların farklı söylediği tek bir bilgi (ör. can kaybı). */
export type CandidateConflict = {
  key: string;
  label: string;
  values: Array<{ sourceName: string; value: string }>;
};

export type CandidateVerification = {
  status: VerificationStatus;
  sourceCount: number;
  sourceNames: string[];
  checkedAt: string;
  notes: string[];
  conflicts?: CandidateConflict[];
};

export type CandidateAiAnalysis = {
  status: 'not-run' | 'verified' | 'needs-review' | 'unavailable';
  importance: number | null;
  channelFit: number | null;
  location: CandidateLocation | null;
  flags: string[];
  rationale: string;
  model: string;
  analyzedAt: string;
};

export type ContentCandidate = {
  id: string;
  kind: 'trend' | 'news' | 'history';
  title: string;
  summary: string;
  imageUrl: string;
  imageToken?: string;
  sourceName: string;
  sourceUrl: string;
  sourceToken?: string;
  publishedAt: string;
  score: number;
  signal: string;
  breaking?: boolean;
  canonicalPublishedAt?: string;
  canonicalModifiedAt?: string;
  freshnessStatus?: FreshnessStatus;
  discoveredAt?: string;
  sourceType?: 'aggregator' | 'publisher' | 'official' | 'trend' | 'encyclopedia' | 'ai-search';
  sourceTrust?: number;
  clusterId?: string;
  location?: CandidateLocation | null;
  verification?: CandidateVerification;
  scoreBreakdown?: CandidateScore;
  aiAnalysis?: CandidateAiAnalysis;
  readinessIssues?: string[];
};

export type DiscoveryResponse = {
  candidates: ContentCandidate[];
  generatedAt: string;
  sourceStatus: Array<{
    id: string;
    label: string;
    status: 'active' | 'needs-key' | 'unavailable';
    candidateCount?: number;
    checkedAt?: string;
    latencyMs?: number;
    detail?: string;
  }>;
  coverage?: {
    totalDiscovered: number;
    uniqueEvents: number;
    corroboratedEvents: number;
    conflictingEvents: number;
    withImages: number;
    withLocations: number;
    aiAnalyzed: number;
    aiPromoted: number;
  };
  warnings?: string[];
};
