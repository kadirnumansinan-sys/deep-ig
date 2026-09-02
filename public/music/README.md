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

Parça başına ~7 sn kullanılsa da tam dosya indirilir. 128 kbps mono/stereo mp3'te
2 dakikalık bir parça ~2 MB. 40 parçalık kütüphane ~5–20 MB; Vercel için sorun değil.
Dosyaları 128 kbps'e düşürmek istersen:

```
ffmpeg -i giris.mp3 -codec:a libmp3lame -b:a 128k -ac 2 cikis.mp3
```

## Kaynak önerileri (telifsiz / atıf ile)

- Pixabay Music — Pixabay Content License, atıf zorunlu değil
- Free Music Archive — parça başına CC lisansı değişir, kontrol et
- YouTube Audio Library — atıf gerekliliği parça sayfasında yazar
- Kevin MacLeod / incompetech — CC-BY 4.0, atıf zorunlu
