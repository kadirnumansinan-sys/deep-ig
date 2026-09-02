import type { ContentCandidate } from '@/lib/content';

export type CandidateFilter = 'corroborated' | 'conflict' | 'with-image' | 'with-location';

export function filterCandidates(
  candidates: ContentCandidate[],
  search: string,
  activeFilters: ReadonlySet<CandidateFilter>,
): ContentCandidate[] {
  const needle = search.trim().toLocaleLowerCase('tr-TR');

  return candidates.filter((candidate) => (
    candidate.freshnessStatus !== 'stale'
    && (
      !needle
      || candidate.title.toLocaleLowerCase('tr-TR').includes(needle)
      || candidate.sourceName.toLocaleLowerCase('tr-TR').includes(needle)
    )
    && (
      !activeFilters.has('corroborated')
      || candidate.verification?.status === 'corroborated'
    )
    && (!activeFilters.has('conflict') || candidate.verification?.status === 'conflict')
    && (!activeFilters.has('with-image') || Boolean(candidate.imageUrl))
    && (!activeFilters.has('with-location') || Boolean(candidate.location?.label))
  ));
}
