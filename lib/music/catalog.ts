import type { Channel } from '@/lib/content';
import rawCatalog from './catalog.json';

export type Mood =
  | 'cinematic'
  | 'tense'
  | 'somber'
  | 'documentary'
  | 'neutral'
  | 'uplifting'
  | 'electronic';

export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  /** public/music altındaki dosya adı. */
  file: string;
  /** Örn. CC0, CC-BY-4.0. `BELIRT` ise parça yayına hazır değildir. */
  license: string;
  sourceUrl: string;
  attributionRequired: boolean;
  moods: Mood[];
  bpm?: number;
  /**
   * Dosyada gerçekten bulunan ses süresi (saniye). Parçalar tam uzunlukta değil,
   * ilk ~1 MB'lık kesit olarak indirildiği için mp3 başlığındaki süre yanıltıcı olabilir.
   */
  lengthSec?: number;
  /** Varsayılan giriş noktası (saniye). */
  startSec: number;
  /** 0–1 arası kazanç. */
  gain: number;
};

/** Lisansı doldurulmamış taslak kayıtlar seçicide görünmez. */
const PLACEHOLDER_LICENSE = 'BELIRT';

export const musicTracks: MusicTrack[] = (rawCatalog as unknown as MusicTrack[]).filter(
  (track) => track.license !== PLACEHOLDER_LICENSE,
);

/** Kanal başına tercih sırası; baştaki ruh hali en yüksek puanı alır. */
export const channelMoods: Record<Channel, Mood[]> = {
  news: ['tense', 'documentary', 'neutral'],
  history: ['cinematic', 'somber', 'documentary'],
  international: ['cinematic', 'tense', 'neutral'],
  media: ['uplifting', 'electronic', 'neutral'],
};

function score(track: MusicTrack, channel: Channel): number {
  const preferred = channelMoods[channel];
  let best = 0;
  for (const mood of track.moods) {
    const index = preferred.indexOf(mood);
    if (index >= 0) best = Math.max(best, preferred.length - index);
  }
  return best;
}

export function trackUrl(track: MusicTrack): string {
  return `/music/${track.file}`;
}

export function trackById(id: string): MusicTrack | null {
  return musicTracks.find((track) => track.id === id) ?? null;
}

/** Kanala uygunluğa göre sıralı liste; eşit puanlılar başlığa göre sıralanır. */
export function suggestTracks(channel: Channel): MusicTrack[] {
  return [...musicTracks].sort((a, b) => {
    const diff = score(b, channel) - score(a, channel);
    return diff !== 0 ? diff : a.title.localeCompare(b.title, 'tr');
  });
}

/** En uygun parçalardan birini rastgele seçer; `excludeId` ile arka arkaya tekrar önlenir. */
export function suggestTrack(channel: Channel, excludeId?: string): MusicTrack | null {
  const ranked = suggestTracks(channel);
  if (ranked.length === 0) return null;
  const top = score(ranked[0], channel);
  const pool = ranked.filter((track) => score(track, channel) === top);
  const choices = pool.length > 1 ? pool.filter((track) => track.id !== excludeId) : pool;
  const list = choices.length > 0 ? choices : pool;
  return list[Math.floor(Math.random() * list.length)];
}

export function musicCredit(track: MusicTrack): string {
  return [
    `Parça: ${track.title}`,
    `Sanatçı: ${track.artist || '-'}`,
    `Lisans: ${track.license}`,
    `Kaynak: ${track.sourceUrl || '-'}`,
    track.attributionRequired
      ? 'Not: Bu lisans atıf zorunlu kılıyor, künyeyi gönderi açıklamasına ekle.'
      : 'Not: Atıf zorunlu değil.',
  ].join('\n');
}
