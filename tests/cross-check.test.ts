import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentCandidate } from '@/lib/content';
import { conflictNote, findConflicts } from '@/lib/cross-check';

function candidate(patch: Partial<ContentCandidate> = {}): ContentCandidate {
  return {
    id: 'candidate-1',
    kind: 'news',
    title: 'Depremde can kaybı açıklandı',
    summary: 'Yetkililer bilgi verdi.',
    imageUrl: '',
    sourceName: 'Örnek Haber',
    sourceUrl: 'https://example.com/news',
    publishedAt: '2026-09-01T08:00:00.000Z',
    freshnessStatus: 'today',
    sourceType: 'publisher',
    score: 70,
    signal: 'test',
    ...patch,
  };
}

test('aynı olayda farklı can kaybı sayıları çelişki sayılır', () => {
  const conflicts = findConflicts([
    candidate({ id: 'a', sourceName: 'A Ajansı', summary: 'Depremde 12 kişi hayatını kaybetti.' }),
    candidate({ id: 'b', sourceName: 'B Gazetesi', summary: 'Depremde 19 kişi hayatını kaybetti.' }),
  ]);
  const toll = conflicts.find((conflict) => conflict.key === 'toll');
  assert.ok(toll, 'can kaybı çelişkisi bulunmalı');
  assert.equal(toll?.values.length, 2);
  assert.match(conflictNote(toll!), /Can kaybı/u);
});

test('aynı sayıyı veren kaynaklar çelişki üretmez', () => {
  const conflicts = findConflicts([
    candidate({ id: 'a', sourceName: 'A Ajansı', summary: 'Depremde 12 kişi hayatını kaybetti.' }),
    candidate({ id: 'b', sourceName: 'B Gazetesi', summary: 'Kazada 12 kişi hayatını kaybetti.' }),
  ]);
  assert.equal(conflicts.length, 0);
});

test('tek kaynak birden fazla sayı verirse çelişki sayılmaz', () => {
  const conflicts = findConflicts([
    candidate({ id: 'a', sourceName: 'A Ajansı', summary: 'Depremde 10 kişi hayatını kaybetti.' }),
    candidate({ id: 'b', sourceName: 'A Ajansı', summary: 'Depremde 14 kişi hayatını kaybetti.' }),
  ]);
  assert.equal(conflicts.length, 0);
});

test('farklı ülkeler yer çelişkisi olarak işaretlenir', () => {
  const conflicts = findConflicts([
    candidate({
      id: 'a',
      sourceName: 'A Ajansı',
      location: { city: 'İzmir', country: 'Türkiye', label: 'İzmir', confidence: 0.9, method: 'rules' },
    }),
    candidate({
      id: 'b',
      sourceName: 'B Gazetesi',
      location: { city: 'Atina', country: 'Yunanistan', label: 'Atina', confidence: 0.9, method: 'rules' },
    }),
  ]);
  assert.ok(conflicts.some((conflict) => conflict.key === 'location'));
});
