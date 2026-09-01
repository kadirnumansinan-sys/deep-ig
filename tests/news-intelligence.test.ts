import assert from 'node:assert/strict';
import test from 'node:test';
import type { CandidateAiAnalysis, ContentCandidate } from '@/lib/content';
import { mergeGroqAnalysis } from '@/lib/groq';
import {
  clusterCandidates,
  detectLocation,
  enrichIntelligence,
  freshnessFor,
  hasHighImpactSignal,
  scoreCandidate,
  titleSimilarity,
} from '@/lib/news-intelligence';

function candidate(patch: Partial<ContentCandidate> = {}): ContentCandidate {
  return {
    id: 'candidate-1',
    kind: 'news',
    title: 'Ankara için önemli karar açıklandı',
    summary: 'Yeni karar bugün Ankara’da kamuoyuna açıklandı.',
    imageUrl: 'https://example.com/news.jpg',
    sourceName: 'Örnek Haber',
    sourceUrl: 'https://example.com/news',
    publishedAt: '2026-09-01T08:00:00.000Z',
    freshnessStatus: 'today',
    sourceType: 'publisher',
    score: 70,
    signal: 'test',
    location: {
      city: 'Ankara',
      country: 'Türkiye',
      label: 'Ankara',
      confidence: 0.9,
      method: 'rules',
    },
    verification: {
      status: 'corroborated',
      sourceCount: 2,
      sourceNames: ['Örnek Haber', 'İkinci Kaynak'],
      checkedAt: '2026-09-01T08:05:00.000Z',
      notes: [],
    },
    ...patch,
  };
}

test('tazelik Europe/Istanbul gün sınırına göre hesaplanır', () => {
  const now = new Date('2026-09-01T08:00:00.000Z');
  assert.equal(freshnessFor('2026-08-31T22:30:00.000Z', '', now), 'today');
  assert.equal(freshnessFor('2026-08-31T10:00:00.000Z', '', now), 'stale');
  assert.equal(
    freshnessFor('2026-08-30T10:00:00.000Z', '2026-09-01T06:00:00.000Z', now),
    'updated-today',
  );
  assert.equal(freshnessFor('', '', now), 'unverified');
});

test('Türkiye haberlerinde şehir ve KKTC konumu yalnızca açık kanıttan çıkarılır', () => {
  assert.equal(
    detectLocation('İstanbul’da metro seferleri uzatıldı', 'Karar gece saatlerinde uygulanacak.', 'media')?.label,
    'İstanbul',
  );
  assert.equal(
    detectLocation('Girne açıklarında gemi kazası', 'Kuzey Kıbrıs ekipleri bölgede çalışıyor.', 'news')?.label,
    'Girne, KKTC',
  );
  assert.equal(detectLocation('Yeni karar açıklandı', 'Kurum ayrıntıları paylaştı.', 'news'), null);
});

test('benzer başlıklar farklı kaynaklarda aynı olay kümesine alınır', () => {
  const clustered = clusterCandidates([
    candidate({ id: 'a', sourceName: 'Kaynak A', title: 'Ankara için önemli karar açıklandı' }),
    candidate({ id: 'b', sourceName: 'Kaynak B', title: 'Ankara hakkında önemli karar açıklandı' }),
    candidate({ id: 'c', sourceName: 'Kaynak C', title: 'İzmir’de yeni vapur hattı başladı' }),
  ]);
  assert.ok(titleSimilarity(clustered[0].title, clustered[1].title) >= 0.58);
  assert.equal(clustered[0].clusterId, clustered[1].clusterId);
  assert.equal(clustered[0].verification?.status, 'corroborated');
  assert.equal(clustered[0].verification?.sourceCount, 2);
  assert.notEqual(clustered[0].clusterId, clustered[2].clusterId);
});

test('rutin protokol açıklaması yüksek etkili gelişmenin önüne geçmez', () => {
  const routine = candidate({
    title: 'Başkan balıkçılara bereketli seferler diledi',
    summary: 'Başkan yeni sezon dolayısıyla kutlama mesajı yayımladı.',
  });
  const critical = candidate({
    title: 'Ankara’da yeni deprem yönetmeliği kararı açıklandı',
    summary: 'Yönetmelik bugün yürürlüğe girdi ve milyonlarca kişiyi ilgilendiriyor.',
  });
  assert.ok(scoreCandidate(routine, 'news').total < scoreCandidate(critical, 'news').total);
});

test('sayısal büyüklük işareti skoru kontrol grubuna göre yükseltir', () => {
  const control = candidate({
    title: 'Kentte toplantı yapıldı',
    summary: 'Yetkililer gündemi değerlendirdi.',
  });
  const magnitude = candidate({
    title: 'Kentte kaza: 3 ölü, 12 yaralı',
    summary: 'Yetkililer olay yerinde inceleme başlattı.',
  });
  assert.ok(hasHighImpactSignal(`${magnitude.title} ${magnitude.summary}`));
  assert.ok(scoreCandidate(magnitude, 'news').total > scoreCandidate(control, 'news').total);
});

test('etkisiz clickbait başlık puan kaybeder', () => {
  const control = candidate({
    title: 'Kentte yeni sergi açıldı',
    summary: 'Sanatseverler açılışta buluştu.',
  });
  const clickbait = candidate({
    title: 'Görenler inanamadı, sosyal medyada gündem oldu',
    summary: 'Paylaşım kısa sürede viral hale geldi.',
  });
  assert.ok(scoreCandidate(clickbait, 'news').novelty < scoreCandidate(control, 'news').novelty);
});

test('doğrulanmış yüksek etkili aday son dakika işareti ve 88 taban puanı alır', () => {
  const enriched = enrichIntelligence([
    candidate({
      id: 'x',
      sourceName: 'Kaynak A',
      title: 'Bakanlık yeni deprem kararı açıkladı',
      summary: 'Karar bugün yürürlüğe girdi.',
      publishedAt: new Date().toISOString(),
      freshnessStatus: 'today',
    }),
    candidate({
      id: 'y',
      sourceName: 'Kaynak B',
      title: 'Bakanlık deprem kararını açıkladı',
      summary: 'Karar bugün yürürlüğe girdi.',
      publishedAt: new Date().toISOString(),
      freshnessStatus: 'today',
    }),
  ], 'news');
  assert.equal(enriched[0].breaking, true);
  assert.ok(enriched[0].score >= 88);
});

test('akıştan gelen son dakika bayrağı tek kaynakta da korunur', () => {
  const enriched = enrichIntelligence([
    candidate({
      breaking: true,
      verification: undefined,
      title: 'Kentte yeni sergi açıldı',
      summary: 'Sanatseverler açılışta buluştu.',
      freshnessStatus: 'today',
    }),
  ], 'news');
  assert.equal(enriched[0].breaking, true);
  assert.ok(enriched[0].score >= 88);
});

test('Groq hiçbir adayı düşürmez ve en fazla sekiz puan dikkat bonusu verir', () => {
  const base = candidate({ score: 64 });
  const analysis: CandidateAiAnalysis = {
    status: 'verified',
    importance: 100,
    channelFit: 100,
    location: null,
    flags: [],
    rationale: 'Yüksek kamu etkisi',
    model: 'openai/gpt-oss-20b',
    analyzedAt: '2026-09-01T08:00:00.000Z',
  };
  const promoted = mergeGroqAnalysis([base], new Map([[base.id, analysis]]))[0];
  assert.equal(promoted.score, 72);

  const low = mergeGroqAnalysis([base], new Map([[
    base.id,
    { ...analysis, importance: 20, channelFit: 10 },
  ]]))[0];
  assert.equal(low.score, 64);
});
