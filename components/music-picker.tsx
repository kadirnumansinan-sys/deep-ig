'use client';

import { Music, Pause, Play, Shuffle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel } from '@/lib/content';
import { suggestTrack, suggestTracks, trackById, trackUrl } from '@/lib/music/catalog';
import { REEL_DURATION_SEC } from '@/lib/video/encode-reel';

export type MusicSelection = { id: string; startSec: number };

export function MusicPicker({
  channel,
  disabled,
  onChange,
  selection,
}: {
  channel: Channel;
  disabled?: boolean;
  onChange: (selection: MusicSelection | null) => void;
  selection: MusicSelection | null;
}) {
  const ranked = useMemo(() => suggestTracks(channel), [channel]);
  const track = selection ? trackById(selection.id) : null;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);

  // Parça veya giriş noktası değişince önizlemeyi durdur.
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    element.pause();
    setPlaying(false);
  }, [selection?.id, selection?.startSec]);

  useEffect(() => {
    if (!playing) return;
    const element = audioRef.current;
    if (!element) return;
    const stopAt = (selection?.startSec ?? 0) + REEL_DURATION_SEC;
    const onTimeUpdate = () => {
      if (element.currentTime >= stopAt) {
        element.pause();
        setPlaying(false);
      }
    };
    element.addEventListener('timeupdate', onTimeUpdate);
    return () => element.removeEventListener('timeupdate', onTimeUpdate);
  }, [playing, selection?.startSec]);

  if (ranked.length === 0) {
    return (
      <div className="music-panel music-panel-empty">
        <Music size={16} />
        <span>
          <strong>Müzik kütüphanesi boş</strong>
          <small>
            mp3 dosyalarını <code>public/music/</code> içine koy, <code>npm run music:scan</code> çalıştır,
            lisans alanını doldur. Müziksiz video yine üretilir.
          </small>
        </span>
      </div>
    );
  }

  // Dosyalar kesit olarak indirildiği için mp3 başlığındaki süre gerçekten çözülebilen
  // sesten uzun olabilir; katalogdaki ölçülen değer varsa o kazanır.
  const usableSec = track?.lengthSec
    ? Math.min(track.lengthSec, duration || track.lengthSec)
    : duration;
  const maxStart = Math.max(0, Math.floor(usableSec - REEL_DURATION_SEC));

  function togglePreview() {
    const element = audioRef.current;
    if (!element || !selection) return;
    if (playing) {
      element.pause();
      setPlaying(false);
      return;
    }
    element.currentTime = selection.startSec;
    void element.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }

  return (
    <div className="music-panel">
      <div className="music-panel-head">
        <Music size={16} />
        <span>
          <strong>Video müziği</strong>
          <small>7 saniyelik MP4&apos;ün arka planı · kapak görseli sessiz JPG kalır</small>
        </span>
      </div>

      <div className="music-panel-row">
        <select
          aria-label="Müzik parçası"
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) {
              onChange(null);
              return;
            }
            const next = trackById(value);
            onChange(next ? { id: next.id, startSec: next.startSec } : null);
          }}
          value={selection?.id ?? ''}
        >
          <option value="">Müziksiz (sessiz video)</option>
          {ranked.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
              {item.artist ? ` — ${item.artist}` : ''}
            </option>
          ))}
        </select>

        <button
          aria-label="Kanala uygun başka parça öner"
          disabled={disabled}
          onClick={() => {
            const next = suggestTrack(channel, selection?.id);
            onChange(next ? { id: next.id, startSec: next.startSec } : null);
          }}
          title="Kanala uygun başka parça öner"
          type="button"
        >
          <Shuffle size={13} />
        </button>

        <button
          aria-label={playing ? 'Önizlemeyi durdur' : 'Önizlemeyi çal'}
          disabled={disabled || !track}
          onClick={togglePreview}
          type="button"
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
      </div>

      {track ? (
        <>
          <label className="music-panel-range">
            <span>Giriş noktası</span>
            <input
              disabled={disabled || maxStart === 0}
              max={maxStart}
              min={0}
              onChange={(event) => onChange({ id: track.id, startSec: Number(event.target.value) })}
              step={1}
              type="range"
              value={Math.min(selection?.startSec ?? 0, maxStart)}
            />
            <span className="music-panel-time">
              {selection?.startSec ?? 0}–{(selection?.startSec ?? 0) + REEL_DURATION_SEC} sn
            </span>
          </label>
          <small className="music-panel-license">
            {track.license}
            {track.attributionRequired ? ' · atıf zorunlu, künye ZIP içinde' : ' · atıf zorunlu değil'}
          </small>
          <audio
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            preload="metadata"
            ref={audioRef}
            src={trackUrl(track)}
          />
        </>
      ) : null}
    </div>
  );
}
