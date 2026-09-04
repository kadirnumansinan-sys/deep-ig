'use client';

import { Clock3, ExternalLink, LoaderCircle, MapPin, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ContentCandidate } from '@/lib/content';
import { formatTime, freshnessLabel, proxied } from '@/components/studio/utils';

/** Keşif listesindeki tek bir haber kartı; çelişki varsa kırmızı uyarı gösterir. */
export function CandidateCard({
  candidate,
  loading,
  disabled,
  onSelect,
}: {
  candidate: ContentCandidate;
  loading: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const sourceCount = candidate.verification?.sourceCount || 1;
  const conflicts = candidate.verification?.status === 'conflict' ? candidate.verification.conflicts ?? [] : [];
  const candidateTitle = [
    ...conflicts.map((conflict) => (
      `${conflict.label}: ${conflict.values.map((item) => `${item.sourceName} → ${item.value}`).join(' | ')}`
    )),
    candidate.readinessIssues?.join(' ') || '',
  ].filter(Boolean).join('\n');
  return (
    <button
      className={`candidate-card freshness-${candidate.freshnessStatus || 'unverified'}${candidate.breaking ? ' is-breaking' : ''}${conflicts.length ? ' has-conflict' : ''}`}
      disabled={loading || disabled || candidate.freshnessStatus === 'stale'}
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
          {candidate.breaking && <b className="breaking-badge">SON DAKİKA</b>}
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
          {conflicts.length > 0 && (
            <i className="conflict-badge"><TriangleAlert size={8} /> Kaynaklar çelişiyor</i>
          )}
          {candidate.location?.label && <i><MapPin size={8} /> {candidate.location.label}</i>}
          {candidate.aiAnalysis?.importance !== null && candidate.aiAnalysis?.importance !== undefined && (
            <i className="ai-badge">Groq {candidate.aiAnalysis.importance}</i>
          )}
        </span>
        {conflicts.map((conflict) => (
          <small className="conflict-line" key={conflict.key}>
            {conflict.label}: {conflict.values.map((item) => `${item.sourceName} → ${item.value}`).join(' · ')}
          </small>
        ))}
      </span>
      {loading
        ? <LoaderCircle aria-label="Yüksek çözünürlüklü görsel aranıyor" className="spin" size={13} />
        : <ExternalLink aria-hidden="true" size={13} strokeWidth={1.8} />}
    </button>
  );
}
