import type { Channel } from '@/lib/content';
import type { CropSettings, Draft } from '@/components/studio/types';
import { proxied } from '@/components/studio/utils';

export const channels: Array<{ id: Channel; label: string; language: string }> = [
  { id: 'history', label: 'History', language: 'TR' },
  { id: 'news', label: 'News', language: 'TR' },
  { id: 'international', label: 'International', language: 'EN' },
  { id: 'media', label: 'Media', language: 'TR' },
];

export const defaultCrop: CropSettings = { zoom: 1, x: 50, y: 50 };

const newsDemo = proxied(
  'https://images.unsplash.com/photo-1561731216-c3a4d99437d5?auto=format&fit=crop&w=1600&q=88',
);
const historyDemo = proxied(
  'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1600&q=88',
);

/** Uygulama ilk açıldığında ekranda duran örnek içerikler. */
export const initialDrafts: Record<Channel, Draft> = {
  history: {
    title: '113 KİŞİ HAYATINI KAYBETTİ',
    body: "25 Temmuz 2000’de Air France’a ait Concorde, Paris’ten kalkışından kısa süre sonra Gonesse’ye düştü. Kazada uçaktaki 109 kişi ile yerdeki 4 kişi hayatını kaybetti.",
    location: 'Gonesse, Paris Yakınları, Fransa',
    image: historyDemo,
    coverCrop: { zoom: 1.08, x: 50, y: 48 },
    detailCrop: { zoom: 1, x: 50, y: 48 },
    caption: '',
    sourceName: 'Örnek içerik',
    sourceUrl: '',
    sourceToken: '',
    sourceTitle: '',
    sourceSummary: '',
    imageWidth: 1600,
    imageOptions: [],
    imageHeight: 1067,
    sourceFreshnessStatus: 'today',
  },
  news: {
    title: '30 ASLAN VE KAPLAN ÖZGÜRLÜĞE TAŞINIYOR',
    body: 'Yıllarca kapalı ve kötü koşullardaki kafeslerde yaşayan 30 aslan ve kaplan için büyük bir kurtarma operasyonu başladı. Hayvanlar, Güney Afrika ve ABD’deki koruma alanlarına taşınacak.',
    location: 'Luján, Arjantin',
    image: newsDemo,
    coverCrop: { zoom: 1.12, x: 50, y: 49 },
    detailCrop: { zoom: 1, x: 50, y: 48 },
    caption: '',
    sourceName: 'Örnek içerik',
    sourceUrl: '',
    sourceToken: '',
    sourceTitle: '',
    sourceSummary: '',
    imageWidth: 1600,
    imageOptions: [],
    imageHeight: 1067,
    sourceFreshnessStatus: 'today',
  },
  international: {
    title: '30 LIONS AND TIGERS ARE MOVING TO FREEDOM',
    body: 'A major rescue operation has begun for 30 lions and tigers kept for years in cramped, poor conditions. The animals will be moved to sanctuaries in South Africa and the United States.',
    location: 'Luján, Argentina',
    image: newsDemo,
    coverCrop: { zoom: 1.12, x: 50, y: 49 },
    detailCrop: { zoom: 1, x: 50, y: 48 },
    caption: '',
    sourceName: 'Sample content',
    sourceUrl: '',
    sourceToken: '',
    sourceTitle: '',
    sourceSummary: '',
    imageWidth: 1600,
    imageOptions: [],
    imageHeight: 1067,
    sourceFreshnessStatus: 'today',
  },
  media: {
    title: 'MEDYA GÜNDEMİNDE BUGÜN',
    body: 'Deepbrief Media için günün öne çıkan gelişmesini kaynak metnini kontrol ederek burada düzenleyebilirsin.',
    location: 'İstanbul, Türkiye',
    image: newsDemo,
    coverCrop: { zoom: 1.12, x: 50, y: 49 },
    detailCrop: { zoom: 1, x: 50, y: 48 },
    caption: '',
    sourceName: 'Örnek içerik',
    sourceUrl: '',
    sourceToken: '',
    sourceTitle: '',
    sourceSummary: '',
    imageWidth: 1600,
    imageOptions: [],
    imageHeight: 1067,
    sourceFreshnessStatus: 'today',
  },
};
