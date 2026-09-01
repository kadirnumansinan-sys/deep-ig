import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeExcerpt,
  containsTeaserLanguage,
  hasCompleteSentenceEnding,
  hasIncompleteEnding,
} from '../lib/copy-guard';

test('tamamlanmış sosyal medya başlıkları yarım sayılmaz', () => {
  assert.equal(hasIncompleteEnding("Tokat'ta çocuklar halıdan halı saha yaptı"), false);
  assert.equal(hasIncompleteEnding("Girne'de batan tekneyi fark edip yardıma koştu"), false);
});

test('üç nokta, iki nokta ve bağlaçla biten metinler reddedilir', () => {
  assert.equal(hasIncompleteEnding('Bakan toplantıda şunları söyledi:'), true);
  assert.equal(hasIncompleteEnding('Yeni kararın ardından…'), true);
  assert.equal(hasIncompleteEnding('Ekipler olay yerine geldi ve'), true);
  assert.equal(hasIncompleteEnding('Şüpheli yakalandığı'), true);
  assert.equal(hasIncompleteEnding('Yetkili "çalışmalar sürüyor.'), true);
});

test('gönderi metni tamamlanmış cümle noktalamasıyla biter', () => {
  assert.equal(hasCompleteSentenceEnding('Taksi şoförü gözaltına alındı.'), true);
  assert.equal(hasCompleteSentenceEnding('Taksi şoförü gözaltına alındı'), false);
});

test('kaynak özeti karakter ortasında değil son tamamlanmış cümlede kesilir', () => {
  const source = 'İlk cümle olayın ne olduğunu açıkça anlatıyor. İkinci cümle önemli ayrıntıları veriyor. Üçüncü cümle ise çok daha sonra devam ediyor.';
  const excerpt = completeExcerpt(source, 95);
  assert.equal(excerpt.endsWith('…'), false);
  assert.equal(hasCompleteSentenceEnding(excerpt), true);
});

test('devamı varmış izlenimi veren tanıtım kalıpları reddedilir', () => {
  assert.equal(containsTeaserLanguage('İşte detaylar.'), true);
  assert.equal(containsTeaserLanguage('Açıklama geldi.'), true);
  assert.equal(containsTeaserLanguage('Detaylar ortaya çıktı.'), true);
  assert.equal(containsTeaserLanguage('İtfaiye ekipleri yangına müdahale etti.'), false);
});
