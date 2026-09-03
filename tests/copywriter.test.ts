import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCopyInstructions,
  captionWithHashtags,
  copyFromWordArrays,
  copyJsonSchema,
  hashtagCount,
  reachHashtagMinimum,
  reachHashtags,
  sanitizeGeneratedCopy,
  validationIssue,
} from '../lib/copywriter';

const sampleHashtags = ['#Ankara', '#Ulaşım', '#Belediye', '#sondakika', '#haber'];

test('kelime dizileri tek metne birleştirilir, eksik alan reddedilir', () => {
  const copy = copyFromWordArrays({
    coverWords: ['Ankara', 'için', 'karar'],
    visualWords: 'Yeni karar bugün açıklandı ve uygulama yarın kentte resmen başlayacak dendi.'.split(' '),
    captionWords: ['Detay'],
    hashtagWords: sampleHashtags,
  });
  assert.equal(copy?.coverTitle, 'Ankara için karar');
  assert.equal(copyFromWordArrays({ coverWords: ['x'], visualWords: ['y'] }), null);
  assert.equal(copyFromWordArrays({
    coverWords: ['Ankara', 'için', 'karar'],
    visualWords: ['bir'],
    captionWords: ['Detay'],
  }), null);
});

test('etiketler tekilleştirilir, tek kelimeye indirilir ve açıklamanın sonuna eklenir', () => {
  const copy = copyFromWordArrays({
    coverWords: ['Ankara', 'için', 'karar'],
    visualWords: ['Karar', 'açıklandı.'],
    captionWords: ['Detay', 'geldi.'],
    hashtagWords: ['# Ankara', 'ulaşım!', '#ankara', '#Belediye', '#Karar', '#Gündem'],
  });
  assert.deepEqual(copy?.hashtags, ['#Ankara', '#ulaşım', '#Belediye', '#Karar', '#Gündem']);
  assert.equal(captionWithHashtags(copy!), 'Detay geldi.\n\n#Ankara #ulaşım #Belediye #Karar #Gündem');
});

test('yapışık kelimeler ayrılır, marka yazımı korunur', () => {
  const copy = copyFromWordArrays({
    coverWords: ['AnkaraBüyükşehirBelediyesi', 'karar'],
    visualWords: ['ifade', 'edildi.Şimdilik', 'sürüyor'],
    captionWords: ['iPhone', 'YouTube', 'detayı'],
    hashtagWords: sampleHashtags,
  });
  assert.equal(copy?.coverTitle, 'Ankara Büyükşehir Belediyesi karar');
  assert.equal(copy?.visualText, 'ifade edildi. Şimdilik sürüyor');
  assert.equal(copy?.caption, 'iPhone YouTube detayı');
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
    hashtags: sampleHashtags,
  };
  assert.equal(validationIssue({ ...good, caption: 'Çok kısa kaldı.' }, 'news', 'Kaynak').startsWith('caption has'), true);
  assert.equal(validationIssue(good, 'news', 'Kaynak'), '');
  assert.ok(copyJsonSchema.required.includes('captionWords'));
  assert.ok(copyJsonSchema.required.includes('hashtagWords'));
});

test('yasaklı kelimeler ve eksik etiket doğrulamada takılır', () => {
  const caption = Array.from({ length: 60 }, (_, index) => `kelime${index}`).join(' ');
  const good = {
    coverTitle: 'Ankara yeni ulaşım kararını duyurdu',
    visualText: 'Belediye yeni ulaşım kararını bugün duyurdu. Uygulama gelecek hafta on iki hatta başlayacak.',
    caption: `Belediye ulaşım planını genişletiyor. ${caption} Bu adım kart sistemini de yeniliyor.`,
    hashtags: sampleHashtags,
  };
  for (const word of ['yarattı', 'yaratıcı', 'mucidi', 'icadı']) {
    const issue = validationIssue(
      { ...good, visualText: `Belediye yeni bir hattı ${word} ve bugün duyurdu. Uygulama gelecek hafta başlayacak.` },
      'news',
      'Kaynak',
    );
    assert.ok(issue.includes('forbidden'), `${word} yakalanmalı`);
  }
  // "mucize" gövde eşleşmesine takılmamalı.
  assert.equal(
    validationIssue(
      { ...good, visualText: 'Belediye bunu mucize gibi anlattı ve bugün duyurdu. Uygulama gelecek hafta başlayacak.' },
      'news',
      'Kaynak',
    ),
    '',
  );
  assert.ok(validationIssue({ ...good, hashtags: sampleHashtags.slice(0, 3) }, 'news', 'Kaynak')
    .includes(`exactly ${hashtagCount}`));
});

test('ölüm ve ölü maskesiz geçemez, maskeli biçim kabul edilir', () => {
  const caption = Array.from({ length: 60 }, (_, index) => `kelime${index}`).join(' ');
  const good = {
    coverTitle: 'Ankara yeni ulaşım kararını duyurdu',
    visualText: 'Belediye yeni ulaşım kararını bugün duyurdu. Uygulama gelecek hafta on iki hatta başlayacak.',
    caption: `Belediye ulaşım planını genişletiyor. ${caption} Bu adım kart sistemini de yeniliyor.`,
    hashtags: sampleHashtags,
  };
  for (const text of ['Kazada ölüm haberi geldi.', 'Ölüm sayısı bugün açıklandı.', 'Yaralılar ve ölüler sayıldı.']) {
    assert.ok(
      validationIssue({ ...good, visualText: `${text} Uygulama gelecek hafta on iki hatta başlayacak yine.` }, 'news', 'Kaynak')
        .includes('masked'),
      `${text} yakalanmalı`,
    );
  }
  // Maskeli biçim ve "ölçüm" gibi benzeyen kelimeler takılmamalı.
  assert.equal(
    validationIssue(
      { ...good, visualText: 'Kazada ö*üm bildirildi ve *lü sayısı açıklandı. Ölçüm sonuçları da bugün paylaşıldı.' },
      'news',
      'Kaynak',
    ),
    '',
  );
});

test('sanitize maskeler, kaynak etiketini atar ve erişim etiketiyle tamamlar', () => {
  const copy = sanitizeGeneratedCopy({
    coverTitle: 'Ölüm haberi Hürriyet kaynaklı',
    visualText: 'Ölümü doğrulandı ve ölüler sayıldı.',
    caption: 'Yetkililer ölüm sayısını açıkladı.',
    hashtags: ['#Ankara', '#Hürriyet', '#ölüm'],
  }, 'Hürriyet', 'news');

  assert.equal(copy.coverTitle, 'Ö*üm haberi kaynaklı');
  assert.equal(copy.visualText, 'Ö*ümü doğrulandı ve *lüler sayıldı.');
  assert.equal(copy.caption, 'Yetkililer ö*üm sayısını açıkladı.');
  // Kaynak adlı ve "ölüm" içeren etiketler atıldı, liste havuzdan tam sayıya tamamlandı.
  assert.equal(copy.hashtags.length, hashtagCount);
  assert.equal(copy.hashtags[0], '#Ankara');
  assert.ok(!copy.hashtags.some((tag) => /hürriyet|ölüm/iu.test(tag)));
});

test('konu etiketleri korunur, eksik erişim etiketi havuzdan eklenir', () => {
  const copy = sanitizeGeneratedCopy({
    coverTitle: 'Ankara kararı',
    visualText: 'Karar açıklandı.',
    caption: 'Detay geldi.',
    hashtags: ['#Ankara', '#Ulaşım', '#Belediye', '#Karar', '#Metro'],
  }, 'Kaynak', 'news');

  assert.equal(copy.hashtags.length, hashtagCount);
  assert.ok(copy.hashtags.includes('#Ankara'));
  assert.ok(copy.hashtags.filter((tag) => reachHashtags('news').includes(tag))
    .length >= reachHashtagMinimum);
});
