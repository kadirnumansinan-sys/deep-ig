# Müzik kütüphanesi

7 saniyelik Reels videolarının arka plan müziği buradan gelir. Dosyalar bir kez indirilip
repoya konur; çalışma anında hiçbir dış servise istek atılmaz (API anahtarı yok, gecikme yok,
link çürümesi yok, ToS riski yok).

## Ekleme adımları

1. `.mp3` dosyasını bu klasöre koy. Ad: `kucuk-harf-tireli.mp3`, ASCII, boşluksuz.
2. `npm run music:scan` çalıştır — yeni dosyalar `lib/music/catalog.json` içine taslak
   kayıt olarak eklenir, silinmiş dosyalar uyarı verir.
3. Taslak kaydı doldur: `title`, `artist`, `license`, `sourceUrl`, `moods`, `startSec`, `gain`.
   `license` alanı `BELIRT` kaldığı sürece parça seçicide görünmez.

## Alanlar

| Alan | Anlamı |
| --- | --- |
| `id` | Sabit kimlik; taslakta değiştirme, seçim bunun üzerinden saklanır. |
| `file` | Bu klasördeki dosya adı. |
| `license` | Örn. `CC0`, `CC-BY-4.0`, `Pixabay Content License`, `YouTube Audio Library`. |
| `attributionRequired` | `true` ise ZIP içine `-muzik.txt` künyesi yazılır. |
| `moods` | `cinematic`, `tense`, `somber`, `documentary`, `neutral`, `uplifting`, `electronic`. |
| `startSec` | Parçanın kaçıncı saniyesinden 7 saniye alınacağı (varsayılan giriş noktası). |
| `gain` | 0–1 arası kazanç. Konuşma yok, sadece müzik: 0.5–0.7 iyi çalışır. |

## Boyut

Parça başına ~7 sn kullanılsa da mevcut kayıtlar ilk ~30 saniyelik kesit olarak
indirilmiştir (256 kbps mp3'te ~960 KB/parça); `lengthSec` alanı dosyada gerçekten
bulunan süreyi tutar, mp3 başlığındaki toplam süre yanıltıcı olabilir.

## Kaynak: Mixkit

Şu anki kütüphane [Mixkit](https://mixkit.co/free-stock-music/) Free License ile
indirildi: atıf gerekmez, ticari + sosyal medya kullanımı serbest, alt-lisanslama
izinli. Yasak olan tek şey: CD/DVD/video oyunu/TV-radyo yayınında kullanım, remix
etme veya parçayı kendi eseri gibi kaydettirme. Instagram Reels arka plan müziği bu
kapsamın tam içinde.

Her kategori sayfası (`https://mixkit.co/free-stock-music/tag/<etiket>/`) HTML'inde
schema.org `MusicRecording` JSON-LD gömülü — parça adı, sanatçı, süre ve doğrudan
mp3 URL'si (`https://assets.mixkit.co/music/<id>/<id>.mp3`) buradan okunur. Aynı
`<id>` altında `<id>-waveform.json` da mevcuttur; min/max genlik dizisinden en
yüksek enerjili 7 saniyelik pencere bulunup `startSec` buna göre ayarlanabilir.

Diğer kaynaklar (yedek, bu kütüphanede kullanılmadı):
- Pixabay Music — Cloudflare bot koruması scraping'i engelliyor, resmi müzik API'si yok
- Free Music Archive — parça başına CC lisansı değişir, kontrol gerekir
- YouTube Audio Library — atıf gerekliliği parça sayfasında yazar
- Kevin MacLeod / incompetech — CC-BY 4.0, atıf zorunlu (önceki kütüphane buradandı)
