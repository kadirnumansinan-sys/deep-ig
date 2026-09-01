import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCopyInstructions,
  copyFromWordArrays,
  copyJsonSchema,
  validationIssue,
} from '../lib/copywriter';

test('kelime dizileri tek metne birleştirilir, eksik alan reddedilir', () => {
  const copy = copyFromWordArrays({
    coverWords: ['Ankara', 'için', 'karar'],
    visualWords: 'Yeni karar bugün açıklandı ve uygulama yarın kentte resmen başlayacak dendi.'.split(' '),
    captionWords: ['Detay'],
  });
  assert.equal(copy?.coverTitle, 'Ankara için karar');
  assert.equal(copyFromWordArrays({ coverWords: ['x'], visualWords: ['y'] }), null);
});

test('talimat metni kritik kural cümlelerini korur ve düzeltmeyi ekler', () => {
  const base = buildCopyInstructions('news');
  assert.ok(base.includes('You are the factual copy desk for the Deepbrief social media studio.'));
  assert.ok(base.includes('Write both output fields only in Turkish.'));
  assert.ok(base.includes('Never identify, cite, mention, or refer to a publisher'));
  assert.ok(buildCopyInstructions('international').includes('only in English'));
  assert.ok(buildCopyInstructions('news', 'FIX-IT').endsWith('FIX-IT'));
});

test('doğrulama kelime aralıklarını uygular', () => {
  const caption = Array.from({ length: 60 }, (_, index) => `kelime${index}`).join(' ');
  const good = {
    coverTitle: 'Ankara yeni ulaşım kararını duyurdu',
    visualText: 'Belediye yeni ulaşım kararını bugün duyurdu. Uygulama gelecek hafta on iki hatta başlayacak.',
    caption: `Belediye ulaşım planını genişletiyor. ${caption} Bu adım kart sistemini de yeniliyor.`,
  };
  assert.equal(validationIssue({ ...good, caption: 'Çok kısa kaldı.' }, 'news', 'Kaynak').startsWith('caption has'), true);
  assert.ok(copyJsonSchema.required.includes('captionWords'));
});
