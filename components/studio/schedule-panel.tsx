'use client';

import { CalendarClock, ExternalLink, Send, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Channel } from '@/lib/content';

const TIME_ZONE = 'Europe/Istanbul';

const inputFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const listFormatter = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

type ScheduleStatus = 'scheduled' | 'creating' | 'processing' | 'published' | 'failed' | 'canceled';

type QueuePost = {
  id: string;
  channel: Channel;
  caption: string;
  scheduledAt: string;
  status: ScheduleStatus;
  permalink: string | null;
  attempts: number;
  lastError: string | null;
};

type QueueResponse = {
  configured: boolean;
  blobConfigured: boolean;
  accounts: Record<Channel, boolean>;
  posts: QueuePost[];
  error?: string;
};

const statusLabels: Record<ScheduleStatus, string> = {
  scheduled: 'Planlandı',
  creating: 'Hazırlanıyor',
  processing: 'İşleniyor',
  published: 'Yayınlandı',
  failed: 'Hata',
  canceled: 'İptal',
};

function parts(date: Date): Record<string, string> {
  return Object.fromEntries(inputFormatter.formatToParts(date).map((part) => [part.type, part.value]));
}

// `datetime-local` girdisi kullanıcının tarayıcı saatine göre çalışır; yayın saati her zaman
// İstanbul saati olsun diye dönüşümler bu iki yardımcıdan geçer.
function toInputValue(date: Date): string {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function zoneOffsetMs(date: Date): number {
  const p = parts(date);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

function fromInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const guess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const candidate = new Date(guess - zoneOffsetMs(new Date(guess)));
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function defaultValue(): string {
  return toInputValue(new Date(Date.now() + 60 * 60 * 1000));
}

type Props = {
  busy: boolean;
  channel: Channel;
  progress: number;
  onPublishNow: () => Promise<void>;
  onSchedule: (scheduledAt: Date) => Promise<void>;
};

export function SchedulePanel({ busy, channel, progress, onPublishNow, onSchedule }: Props) {
  const [when, setWhen] = useState(defaultValue);
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/schedule', { cache: 'no-store' });
      const payload = (await response.json()) as QueueResponse;
      if (!response.ok) {
        setError(payload.error || 'Yayın kuyruğu okunamadı.');
        return;
      }
      setQueue(payload);
      setError(null);
    } catch {
      setError('Yayın kuyruğu okunamadı.');
    }
  }, []);

  useEffect(() => {
    // Durum harici kaynaktan (yayın kuyruğu) geliyor; setState yalnızca fetch çözüldükten sonra çalışır.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const accountReady = queue?.accounts?.[channel] ?? false;
  const storageReady = Boolean(queue?.configured && queue?.blobConfigured);

  async function handleSchedule() {
    const scheduledAt = fromInputValue(when);
    if (!scheduledAt) {
      setError('Yayın saati geçersiz.');
      return;
    }
    if (scheduledAt.getTime() < Date.now() - 60_000) {
      setError('Yayın saati geçmişte olamaz.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSchedule(scheduledAt);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Yayın planlanamadı.');
    } finally {
      setPending(false);
    }
  }

  // "Şimdi paylaş" saat sormaz; kayıt oluşturulur ve yayın aynı istekte başlatılır.
  async function handlePublishNow() {
    setPending(true);
    setError(null);
    try {
      await onPublishNow();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Yayın gönderilemedi.');
    } finally {
      setPending(false);
    }
  }

  async function handleCancel(id: string) {
    try {
      const response = await fetch(`/api/schedule?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error || 'Kayıt iptal edilemedi.');
        return;
      }
      await refresh();
    } catch {
      setError('Kayıt iptal edilemedi.');
    }
  }

  const working = busy || pending;

  return (
    <div className="schedule-panel">
      <div className="schedule-head">
        <CalendarClock size={16} />
        <span>
          <strong>Planlı Instagram yayını</strong>
          <small>
            Seçilen saatte {channel} hesabına Reel olarak gönderilir · saat dilimi Europe/Istanbul
          </small>
        </span>
      </div>

      <div className="schedule-row">
        <input
          aria-label="Yayın saati"
          disabled={working}
          onChange={(event) => setWhen(event.target.value)}
          type="datetime-local"
          value={when}
        />
        <button disabled={working || !accountReady || !storageReady} onClick={() => void handleSchedule()} type="button">
          {working ? (progress > 0 ? `Video %${Math.round(progress * 100)}` : 'Hazırlanıyor…') : 'Planla'}
        </button>
        <button
          className="schedule-now"
          disabled={working || !accountReady || !storageReady}
          onClick={() => void handlePublishNow()}
          type="button"
        >
          <Send size={11} />
          Şimdi paylaş
        </button>
      </div>

      {queue && !queue.configured && (
        <p className="schedule-warning">Yayın kuyruğu için Postgres bağlantısı yok (DATABASE_URL).</p>
      )}
      {queue && queue.configured && !queue.blobConfigured && (
        <p className="schedule-warning">Medya yüklemesi için Vercel Blob deposu yok (BLOB_READ_WRITE_TOKEN).</p>
      )}
      {queue && !accountReady && (
        <p className="schedule-warning">
          {channel} kanalı için Instagram hesabı tanımlı değil (IG_{channel.toUpperCase()}_USER_ID ve
          IG_{channel.toUpperCase()}_TOKEN).
        </p>
      )}
      {error && <p className="schedule-warning">{error}</p>}

      {queue && queue.posts.length > 0 && (
        <ul className="schedule-queue">
          {queue.posts.map((post) => (
            <li key={post.id}>
              <span className={`schedule-badge status-${post.status}`}>{statusLabels[post.status]}</span>
              <span className="schedule-when">{listFormatter.format(new Date(post.scheduledAt))}</span>
              <span className="schedule-channel">{post.channel}</span>
              <span className="schedule-caption">{post.caption.split('\n')[0] || '—'}</span>
              {post.permalink && (
                <a href={post.permalink} rel="noreferrer" target="_blank" title="Instagram'da aç">
                  <ExternalLink size={11} />
                </a>
              )}
              {post.status === 'scheduled' && (
                <button
                  aria-label="Planı iptal et"
                  onClick={() => void handleCancel(post.id)}
                  type="button"
                >
                  <X size={11} />
                </button>
              )}
              {post.lastError && <small className="schedule-error">{post.lastError}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
