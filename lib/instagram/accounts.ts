import type { Channel } from '@/lib/content';
import { FACEBOOK_HOST, INSTAGRAM_HOST, type IgAccount } from '@/lib/instagram/client';
import { isSchedulerConfigured, readAccount, writeAccount } from '@/lib/scheduler/store';

export class InstagramConfigError extends Error {
  readonly channel: Channel;

  constructor(channel: Channel, message: string) {
    super(message);
    this.name = 'InstagramConfigError';
    this.channel = channel;
  }
}

function envPrefix(channel: Channel): string {
  return `IG_${channel.toUpperCase()}`;
}

function normalizeHost(raw: string | undefined): string {
  const value = (raw || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!value) return INSTAGRAM_HOST;
  if (value === FACEBOOK_HOST || value === INSTAGRAM_HOST) return value;
  // Yanlış yazılmış host'ta sessizce Instagram Login'e düşmek yerine açık hata daha iyi.
  throw new Error(`Desteklenmeyen Instagram host'u: ${value}`);
}

// Env'den okunan ham yapılandırma. Eksik alan varsa null döner; hata mesajını çağıran üretir.
export function envAccount(channel: Channel): IgAccount | null {
  const prefix = envPrefix(channel);
  const igUserId = process.env[`${prefix}_USER_ID`]?.trim() || '';
  const accessToken = process.env[`${prefix}_TOKEN`]?.trim() || '';
  if (!igUserId || !accessToken) return null;
  return {
    channel,
    igUserId,
    host: normalizeHost(process.env[`${prefix}_HOST`]),
    accessToken,
    tokenExpiresAt: null,
  };
}

export function isAccountConfigured(channel: Channel): boolean {
  const prefix = envPrefix(channel);
  return Boolean(
    process.env[`${prefix}_USER_ID`]?.trim() && process.env[`${prefix}_TOKEN`]?.trim(),
  );
}

/**
 * Kanalın Instagram hesabını çözer. Önce Postgres'teki `ig_accounts` (cron token'ı yenilediğinde
 * güncel değer orada olur), yoksa env değişkenleri kullanılır ve ilk kullanımda tabloya yazılır.
 */
export async function resolveAccount(channel: Channel): Promise<IgAccount> {
  const fromEnv = envAccount(channel);

  if (isSchedulerConfigured()) {
    let stored = null;
    try {
      stored = await readAccount(channel);
    } catch {
      // Veritabanı geçici olarak okunamıyorsa env değeriyle devam etmek yayını kurtarır.
      stored = null;
    }
    if (stored && stored.igUserId && stored.accessToken) {
      return {
        channel,
        igUserId: stored.igUserId,
        host: normalizeHost(stored.host),
        accessToken: stored.accessToken,
        tokenExpiresAt: stored.tokenExpiresAt,
      };
    }
    if (fromEnv) {
      try {
        await writeAccount(fromEnv);
      } catch {
        // Seed başarısızsa da yayın env değeriyle sürebilir.
      }
    }
  }

  if (!fromEnv) {
    const prefix = envPrefix(channel);
    throw new InstagramConfigError(
      channel,
      `${channel} kanalı için Instagram hesabı tanımlı değil. ${prefix}_USER_ID ve ${prefix}_TOKEN değişkenlerini ekleyin.`,
    );
  }
  return fromEnv;
}

export async function persistAccount(account: IgAccount): Promise<void> {
  if (!isSchedulerConfigured()) return;
  await writeAccount({
    channel: account.channel,
    igUserId: account.igUserId,
    host: account.host,
    accessToken: account.accessToken,
    tokenExpiresAt: account.tokenExpiresAt,
  });
}
