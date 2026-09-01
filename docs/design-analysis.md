# Deepbrief görsel sistem analizi

Bu belge, sağlanan dört Canva çıktısının ölçü ve yerleşim ilişkilerini web şablonuna aktarmak için hazırlanmıştır.

## Kaynak ölçüleri

| Referans | Piksel | Yaklaşık oran | İşlev |
| --- | ---: | ---: | --- |
| History thumbnail | 424 × 758 | 9:16 | Reels kapak görseli |
| History gönderi | 423 × 754 | 9:16 | Siyah tuval içinde 3:4 bilgi kartı |
| News thumbnail | 423 × 754 | 9:16 | Reels kapak görseli |
| News gönderi | 424 × 756 | 9:16 | Siyah tuval içinde 3:4 bilgi kartı |

Üretim çıktısı her iki tasarım için de standartlaştırılarak **1080 × 1920 px** alınır.

## Thumbnail yapısı

- Fotoğraf 9:16 tuvali tamamen kaplar.
- Marka kilidi yatay merkezde, tuval yüksekliğinin yaklaşık `%45.5` noktasındadır.
- Kısa başlık sol kenardan yaklaşık `%12`, üstten `%58` konumunda başlar; genişliği yaklaşık `%77` ile sınırlıdır.
- Başlık yaklaşık `-5.8°` döndürülür, büyük harf ve çok kalın slab-serif karakter kullanır.
- History ve News referanslarında ana hiyerarşi aynı konumdadır; kanal yalnızca alt marka adı ve renk sistemiyle değişir.
- Renk katmanı orta bölümde hafif başlar, son üçte birlik alanda hızla güçlenir.
- Thumbnail katmanı gönderi katmanından belirgin biçimde daha koyudur. Fotoğrafın alt bölümünde History için lacivert, News/International için bordo ton neredeyse opak hâle gelir.

## Gönderi yapısı

- Ana tuval 9:16 ve siyahtır.
- Fotoğraflı bilgi kartı tam genişlikte `3:4` oranındadır. Böylece üst ve altta tuval yüksekliğinin yaklaşık `%12.5` kadarı siyah kalır.
- Renk geçişi kart yüksekliğinin yaklaşık `%45` noktasına kadar şeffaftır; alt bölümde kanal rengine geçer.
- Gönderi renk katmanı thumbnail katmanına göre daha açıktır; üst yarıda fotoğrafın ayrıntıları korunur.
- Açıklama soldan `%16.5`, alttan yaklaşık `%9.5` boşlukla yerleşir ve kart genişliğinin yaklaşık `%76.5` alanını kullanır.
- Metin beyaz, kalın sans-serif ve yaklaşık `1.4` satır yüksekliğindedir. Uzunluk arttıkça yalnızca punto kademeli küçülür; şablonun diğer geometrisi değişmez.

## Sol beyaz çubuk

- Kartın solundan yaklaşık `%5.3` içeride bulunur.
- Kartın üst ve altından yaklaşık `%6.5` boşluk bırakır.
- Genişliği kartın yaklaşık `%7` kadarıdır ve iki ucu tam yuvarlaktır.
- Kanal logosu üst uca taşarak oturur.
- Logo, Deepbrief adı ve sosyal ikon alanı sabittir.
- Yalnızca dikey konum metni içerikten içeriğe değişir.
- Referanstaki okuma yönü korunarak içerik `-90°` döndürülür.

## Kanal renkleri

- **History:** Koyu kapakta lacivert (`#062a6b` çevresi), gönderide daha canlı mavi (`#00589c` çevresi).
- **News / International:** Koyu kapakta bordo (`#78000d` çevresi), gönderide daha açık kırmızı (`#b42c1f` çevresi).
- International, News ile aynı geometri ve kırmızı tema sistemini kullanır; yayın dili İngilizcedir.

## Uygulama kuralları

- Aynı kaynak fotoğraf için kapak ve gönderi kırpması ayrı ayrı ayarlanabilir; çünkü hedef oranlar farklıdır.
- Metin ve görseller AI tarafından üretilmez.
- Kaynak başlığı ve açıklaması yalnızca editöre aktarılır; yayın öncesi kullanıcı tarafından düzenlenir.
- Dışa aktarma iki adet 1080 × 1920 JPG ve kaynak bağlantısını içeren bir not dosyası üretir.
