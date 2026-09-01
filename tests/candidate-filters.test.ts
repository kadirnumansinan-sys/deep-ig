import assert from 'node:assert/strict';
import test from 'node:test';
import { filterCandidates, type CandidateFilter } from '../lib/candidate-filters';
import type { ContentCandidate } from '../lib/content';

function candidate(
  id: string,
  overrides: Partial<ContentCandidate> = {},
): ContentCandidate {
  return {
    id,
    kind: 'news',
    title: `Haber ${id}`,
    summary: '',
    imageUrl: '',
    sourceName: 'Test kaynağı',
    sourceUrl: `https://example.com/${id}`,
    publishedAt: '2026-09-01T08:00:00.000Z',
    freshnessStatus: 'today',
    score: 50,
    signal: '',
    ...overrides,
  };
}

const candidates = [
  candidate('complete', {
    imageUrl: 'https://example.com/image.jpg',
    location: { city: 'İstanbul', country: 'Türkiye', label: 'İstanbul', confidence: 1, method: 'rules' },
    verification: { status: 'corroborated', sourceCount: 2, sourceNames: ['A', 'B'], checkedAt: '', notes: [] },
  }),
  candidate('image-only', { imageUrl: 'https://example.com/other.jpg' }),
  candidate('plain'),
  candidate('stale', { freshnessStatus: 'stale' }),
];

test('filtre seçilmediğinde bugüne ait tüm adaylar listelenir', () => {
  assert.deepEqual(
    filterCandidates(candidates, '', new Set()).map((item) => item.id),
    ['complete', 'image-only', 'plain'],
  );
});

test('birden fazla sayaç seçildiğinde filtrelerin kesişimi uygulanır', () => {
  const filters = new Set<CandidateFilter>(['corroborated', 'with-image', 'with-location']);
  assert.deepEqual(filterCandidates(candidates, '', filters).map((item) => item.id), ['complete']);
});

test('son filtre kaldırıldığında liste yeniden tüm adayları gösterir', () => {
  const filters = new Set<CandidateFilter>(['with-image']);
  filters.delete('with-image');
  assert.equal(filterCandidates(candidates, '', filters).length, 3);
});
