# Deepbrief Content Studio

Deepbrief History, News, International ve Media için günlük haber adaylarını bulan, doğrulayan ve 1080 × 1920 Reels paketleri hazırlayan editör uygulaması.

Sistem haber seçimini tek bir yapay zekâ kararına bırakmaz. Doğrudan yayıncı akışları, haber toplayıcıları ve ilgi sinyalleri birlikte okunur; benzer haberler olay kümelerine alınır, tarih ve konum yalnızca kanıt bulunduğunda işaretlenir. Groq yalnızca üst sıradaki yeni adayları analiz eder ve kaçabilecek gelişmeleri düşük frekanslı bir boşluk taramasıyla destekler. Hiçbir haberi otomatik olarak silme veya bastırma yetkisi yoktur.

## Kanal kapsamı

- **Deepbrief News:** Türkiye’deki siyasi, resmî, kurumsal, ekonomik ve geniş kamu ilgisi taşıyan gelişmeler.
- **Deepbrief Media:** Türkiye’deki yerel ve dar ilgi alanlı kamu yararı haberleri; kaza, belediye, ulaşım, eğitim, kültür, çevre, mahkeme ve sıra dışı yerel gelişmeler bunun yalnızca bir bölümüdür.
- **Deepbrief International:** Türkiye odaklı İngilizce akış değil; dünyada geniş ilgi ve etki oluşturabilecek İngilizce haberler.
- **Deepbrief History:** İçinde bulunulan ay ve günde geçmişte gerçekleşen önemli olaylar.

## Haber ve kalite katmanı

- Kaynak listesi kodda değil, [`config/news-sources.json`](config/news-sources.json) dosyasındadır: Türkiye ve dünya için 38 yayıncı akışı. Yeni bir kaynak eklemek için bu dosyaya ad, RSS adresi, kanal ve güven puanı yazmak yeterlidir.
- Her kaynağın 0–100 arası bir güven puanı vardır; resmî kurum ve ajanslar en yüksek, toplayıcılar en düşük ağırlığı alır. Aynı haber birden çok kaynaktan geldiğinde metin ve görsel, güveni yüksek kaynaktan seçilir.
- Google News, Google Trends, GDELT ve isteğe bağlı NewsAPI destek kaynakları.
- `Europe/Istanbul` gün sınırı; yayıncı RSS tarihi doğrudan doğrulanır, toplayıcı tarihi yayın sayfası okunana kadar “tarih kontrol edilecek” kalır.
- Olay kümeleme, bağımsız kaynak sayısı, açıklanabilir önem puanı, şehir/ülke çıkarımı ve kaynak sağlık görünümü.
- **Çapraz kontrol:** Aynı olayı anlatan kaynaklar can kaybı, yaralı, gözaltı, deprem büyüklüğü, oran ve ülke bilgisi bakımından karşılaştırılır. İki farklı kaynak uyuşmayan değer verdiğinde aday kartı kırmızı “Kaynaklar çelişiyor” uyarısı ve hangi kaynağın ne dediğini gösteren satırlarla işaretlenir; listede yalnızca çelişkili haberleri gösteren bir filtre vardır. Kişi adları bilerek karşılaştırılmaz, yanlış alarm ürettiği için.
- Yapay zekâya verilen talimat metinleri [`config/ai-prompts.json`](config/ai-prompts.json) dosyasındadır; ifade değiştirmek için kod dosyalarına dokunmak gerekmez.
- Haber sayfasından Open Graph, Twitter, JSON-LD, `srcset` ve yüksek çözünürlüklü görsel adaylarını bulma. Düşük kaliteli görseller engellenmez.
- Kaynak adını yayın metninden çıkaran, tekrarı ve kaynakta olmayan bilgiyi reddeden metin kalite kontrolü.
- Görsel içi metin 18–30, Instagram caption metni 50–95 kelime.
- Şablona özgü 9:16 kapak ve 3:4 gönderi, bağımsız kırpma kontrolleri ve ZIP dışa aktarma.

## Maliyet koruması

- İki Groq anahtarı desteklenir; aynı organizasyon kotasını paylaşıyor kabul edilir ve 429 durumunda ikinci anahtar körlemesine tüketilmez.
- Aday analizi tek tek 12 saat, boşluk taraması kanal başına 6 saat önbelleğe alınır.
- Varsayılan Groq sert sınırları: günlük 40 analiz isteği ve 16 arama isteği. Kaynak tabanlı kurallı sıralama Groq olmadan da çalışır.
- OpenAI metin üretimi varsayılan günlük 40 sağlayıcı isteğiyle sınırlıdır; gerçek giriş/çıkış tokenları kaydedilir.
- GPT Image 2 yalnızca kullanıcı düğmeye bastığında çalışır; `medium` kalite, en fazla 1920px/2.073.600 piksel ve varsayılan günlük 6 işlem sınırı kullanır.
- Kota rezervasyonları kalıcı veri tabanında atomiktir; üç kullanıcı aynı anda işlem yapsa da sınır aşılmaz.

OpenAI Responses API kullanım alanları ve GPT Image 2 özellikleri için [resmî OpenAI Responses belgeleri](https://developers.openai.com/api/reference/resources/responses/methods/create) ile [GPT Image 2 model sayfasına](https://developers.openai.com/api/docs/models/gpt-image-2) bakılabilir.

## Kalıcı veri ve güvenlik

- Docker/VPS çalışmasında SQLite WAL dosyası adlandırılmış Docker volume’ünde tutulur; yeniden oluşturma ve sunucu yeniden başlatmalarında aday hafızası, kaynak sağlığı, kota ve kullanıcılar korunur.
- Desteklenen barındırma ortamında aynı veri katmanı D1 kullanır.
- En fazla üç hesap, herkese açık kayıt kapalı, Argon2id parola, zorunlu TOTP, tek kullanımlık kurtarma kodları, 15 dakikalık hesap kilidi, 8 saat boşta/24 saat mutlak oturum süresi.
- Oturum çerezi `HttpOnly`, `SameSite=Strict` ve HTTPS’te `Secure` olarak verilir.
- API anahtarları yalnızca sunucu ortamında okunur; tarayıcıya gönderilmez.

Kimlik doğrulama `AUTH_REQUIRED=true` yapıldığında etkinleşir. İlk sahibi oluşturmak için `.env` içinde `AUTH_SECRET` (en az 32 rastgele karakter), `AUTH_BOOTSTRAP_EMAIL`, `AUTH_BOOTSTRAP_PASSWORD` (en az 12 karakter) ve isteğe bağlı `AUTH_BOOTSTRAP_NAME` girilir. İlk girişte TOTP kurulumu zorunludur; sahibi panel içinden iki ek editör hesabı açabilir.

## Planlı Instagram yayını

Studio’daki **Planlı Instagram yayını** panelinden bir saat seçilir; medya tarayıcıda üretilir, Vercel Blob’a yüklenir ve kuyruğa yazılır. Yayını `/api/internal/publish` uç noktası yapar: zamanı gelen kayıt için Reels konteyneri oluşturur, sonraki tetiklemede konteyner hazır olduğunda yayınlar. Kanal → hesap eşleşmesi birebirdir (`news`, `media`, `international`, `history`).

Aynı paneldeki **Şimdi paylaş** düğmesi saat sormaz: kayıt anında kuyruğa yazılır ve yayın aynı istekte başlatılır. Konteyner hazır olursa gönderi hemen yayınlanır; Instagram videoyu işlemeye devam ediyorsa kayıt `İşleniyor` durumunda kalır ve yayını cron tamamlar. Her iki yolda da gönderilen içerik aynıdır: MP4 video, kapak görseli videonun küçük resmi (`cover_url`) olarak, açıklama alanı ve seçilen müzik videonun içinde.

Kurulum (Vercel):

1. **Storage → Blob store** oluştur (**Public**). `BLOB_READ_WRITE_TOKEN` otomatik eklenir.
2. **Storage → Neon Postgres** ekle. `DATABASE_URL` otomatik eklenir; tablolar ilk çalıştırmada oluşturulur.
3. Dört hesap için `IG_<KANAL>_USER_ID` ve `IG_<KANAL>_TOKEN` değişkenlerini gir. `IG_<KANAL>_HOST` boşsa `graph.instagram.com` (Instagram Login) varsayılır; Facebook Login / Sayfa token’ı kullanıyorsan `graph.facebook.com` yaz.
4. `DEEPBRIEF_CRON_TOKEN` için uzun ve rastgele bir değer gir.
5. **Harici cron** (Hobby planında zorunlu): cron-job.org veya GitHub Actions ile `*/5 * * * *`

   ```
   https://<site>/api/internal/publish?token=<DEEPBRIEF_CRON_TOKEN>
   ```

   Token `x-deepbrief-internal` başlığıyla da gönderilebilir. Hobby planında Vercel cron günde yalnızca bir kez çalışır; `vercel.json`’daki günlük giriş sadece emniyet ağıdır. Pro’ya geçilirse `vercel.json`’da `*/5 * * * *` yeterlidir.

Notlar:

- Instagram sınırı 24 saatte 100 API gönderisidir. Reel 9:16 ve 5–90 saniye olmalıdır; buradaki 7 saniyelik 1080×1920 çıktı uygundur.
- Instagram Login token’ı 60 gün geçerlidir; cron, süre dolmasına 7 günden az kalınca otomatik yeniler ve yeni token’ı veritabanına yazar. Facebook Sayfa token’larında yenileme gerekmez.
- Video dışa aktarma WebCodecs kullanır; planlama için Chrome veya Edge gerekir.

## Docker / VPS

Gereksinimler: Docker Engine ve Docker Compose.

```bash
docker compose up -d --build
```

Uygulama varsayılan olarak `http://localhost:3000` adresindedir. `deepbrief` servisi web uygulamasını, `scheduler` servisi 10 dakikalık arka plan taramasını, `publisher` servisi de 5 dakikalık Instagram yayın turunu çalıştırır (Vercel’deki harici cron’un karşılığı; süresi `PUBLISH_INTERVAL_SECONDS` ile değişir). Veriler `deepbrief-content-studio-data` volume’ünde saklanır.

Instagram yayını Docker’da da aynı kurulumu ister: `DATABASE_URL` (Postgres kuyruğu), `BLOB_READ_WRITE_TOKEN` (herkese açık medya deposu) ve dört hesabın `IG_*` değişkenleri `.env` dosyasına girilir. Kuyruk SQLite volume’ünde tutulmaz, çünkü Instagram medyayı herkese açık bir HTTPS adresinden çeker. Bu değişkenler boşken `publisher` servisi çalışmaya devam eder ama bir şey yayınlamaz.

`.env.example` dosyasını `.env` olarak kopyalayıp Groq/OpenAI anahtarlarını ve üretim sırlarını girin. Değişiklikten sonra:

```bash
docker compose up -d --build
docker compose ps
```

Sağlık kontrolü:

```bash
curl http://127.0.0.1:3000/api/health
```

VPS’te 3000 portunu doğrudan internete açmak yerine Caddy veya Nginx üzerinden HTTPS ile yayınlayın ve `X-Forwarded-Proto` başlığını iletin.

## Yerel geliştirme

Node.js 22.13 veya daha yeni bir sürüm gerekir.

```bash
npm ci
npm run dev
npm test
npm run typecheck
```

Tarayıcı taslakları IndexedDB’de, sunucu haber hafızası varsayılan olarak `.deepbrief/deepbrief.sqlite` dosyasında tutulur. Görsel sisteminin ölçü ve renk analizi [`docs/design-analysis.md`](docs/design-analysis.md) içindedir.
