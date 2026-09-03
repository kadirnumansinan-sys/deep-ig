import type { Channel } from '@/lib/content';

// Instagram içerik yayınlama API'si iki host üzerinden konuşulur:
//   graph.instagram.com  → Instagram Login (Meta panelinde "Instagram business" API kurulumu)
//   graph.facebook.com   → Facebook Login for Business (Sayfa'ya bağlı IG hesabı)
// İstek gövdeleri iki host'ta da aynı; fark yalnızca token yenilemede.
export const INSTAGRAM_HOST = 'graph.instagram.com';
export const FACEBOOK_HOST = 'graph.facebook.com';

export type IgAccount = {
  channel: Channel;
  igUserId: string;
  host: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
};

export type ContainerStatusCode = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

const REQUEST_TIMEOUT_MS = 20_000;

export class InstagramApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly subcode: number | null;

  constructor(message: string, status: number, code: number | null, subcode: number | null) {
    super(message);
    this.name = 'InstagramApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}

export function graphVersion(): string {
  const raw = process.env.IG_GRAPH_VERSION?.trim() || 'v25.0';
  return raw.startsWith('v') ? raw : `v${raw}`;
}

function graphUrl(host: string, path: string, params: Record<string, string>): string {
  const url = new URL(`https://${host}/${graphVersion()}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

type GraphErrorBody = {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
};

async function callGraph<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'bilinmeyen hata';
    throw new InstagramApiError(`Instagram API'sine ulaşılamadı: ${detail}`, 0, null, null);
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || (payload as GraphErrorBody)?.error) {
    const graphError = (payload as GraphErrorBody)?.error;
    const message = graphError?.message?.trim() || text.slice(0, 200) || 'Bilinmeyen Instagram hatası';
    const code = typeof graphError?.code === 'number' ? graphError.code : null;
    const subcode = typeof graphError?.error_subcode === 'number' ? graphError.error_subcode : null;
    const suffix = code === null ? '' : ` (kod ${code}${subcode === null ? '' : `/${subcode}`})`;
    throw new InstagramApiError(`${message}${suffix}`, response.status, code, subcode);
  }

  return (payload ?? {}) as T;
}

function postForm(fields: Record<string, string>): RequestInit {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value) body.set(key, value);
  }
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  };
}

export async function createReelContainer(options: {
  account: IgAccount;
  videoUrl: string;
  coverUrl?: string;
  caption?: string;
  audioName?: string | null;
  trialReel?: boolean;
}): Promise<string> {
  const { account, videoUrl, coverUrl, caption, audioName, trialReel } = options;
  const payload = await callGraph<{ id?: string }>(
    graphUrl(account.host, `${account.igUserId}/media`, {}),
    postForm({
      media_type: 'REELS',
      video_url: videoUrl,
      cover_url: coverUrl || '',
      caption: caption || '',
      share_to_feed: 'true',
      audio_name: audioName || '',
      // Deneme reel'i: önce sadece takipçi olmayanlara gösterilir, iyi performans gösterirse
      // otomatik tüm kitleye "mezun olur". Düşük performanslı içeriğin mevcut takipçiyi
      // yormasını engelleyen, Meta'nın kendi önerdiği bir mekanizma.
      ...(trialReel ? { trial_params: JSON.stringify({ graduation_strategy: 'SS_PERFORMANCE' }) } : {}),
      access_token: account.accessToken,
    }),
  );
  if (!payload.id) {
    throw new InstagramApiError('Instagram konteyner kimliği dönmedi.', 502, null, null);
  }
  return payload.id;
}

export async function getContainerStatus(options: {
  account: IgAccount;
  containerId: string;
}): Promise<{ statusCode: ContainerStatusCode; detail: string }> {
  const { account, containerId } = options;
  const payload = await callGraph<{ status_code?: string; status?: string }>(
    graphUrl(account.host, containerId, {
      fields: 'status_code,status',
      access_token: account.accessToken,
    }),
    { method: 'GET' },
  );
  const raw = (payload.status_code || '').toUpperCase();
  const known: ContainerStatusCode[] = ['EXPIRED', 'ERROR', 'FINISHED', 'IN_PROGRESS', 'PUBLISHED'];
  const statusCode = (known as string[]).includes(raw)
    ? (raw as ContainerStatusCode)
    : 'IN_PROGRESS';
  return { statusCode, detail: (payload.status || '').slice(0, 200) };
}

export async function publishContainer(options: {
  account: IgAccount;
  containerId: string;
}): Promise<string> {
  const { account, containerId } = options;
  const payload = await callGraph<{ id?: string }>(
    graphUrl(account.host, `${account.igUserId}/media_publish`, {}),
    postForm({ creation_id: containerId, access_token: account.accessToken }),
  );
  if (!payload.id) {
    throw new InstagramApiError('Instagram gönderi kimliği dönmedi.', 502, null, null);
  }
  return payload.id;
}

export async function getPermalink(options: {
  account: IgAccount;
  mediaId: string;
}): Promise<string | null> {
  try {
    const payload = await callGraph<{ permalink?: string }>(
      graphUrl(options.account.host, options.mediaId, {
        fields: 'permalink',
        access_token: options.account.accessToken,
      }),
      { method: 'GET' },
    );
    return payload.permalink || null;
  } catch {
    // Bağlantı bilgisi kozmetik; yayının başarılı sayılmasını engellememeli.
    return null;
  }
}

export async function getPublishingLimit(account: IgAccount): Promise<{ used: number; cap: number }> {
  const payload = await callGraph<{
    data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
  }>(
    graphUrl(account.host, `${account.igUserId}/content_publishing_limit`, {
      fields: 'config,quota_usage',
      access_token: account.accessToken,
    }),
    { method: 'GET' },
  );
  const entry = payload.data?.[0];
  return {
    used: typeof entry?.quota_usage === 'number' ? entry.quota_usage : 0,
    cap: typeof entry?.config?.quota_total === 'number' ? entry.config.quota_total : 100,
  };
}

// Instagram Login uzun ömürlü token'ı 60 gün geçerlidir ve süresi dolmadan yenilenmelidir.
// Facebook Login (Sayfa) token'larında böyle bir uç nokta yoktur; orada no-op döner.
export async function refreshAccessToken(
  account: IgAccount,
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  if (account.host !== INSTAGRAM_HOST) return null;
  const url = new URL(`https://${INSTAGRAM_HOST}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', account.accessToken);
  const payload = await callGraph<{ access_token?: string; expires_in?: number }>(
    url.toString(),
    { method: 'GET' },
  );
  if (!payload.access_token) return null;
  const seconds = typeof payload.expires_in === 'number' ? payload.expires_in : 60 * 24 * 3600;
  return {
    accessToken: payload.access_token,
    expiresAt: new Date(Date.now() + seconds * 1000),
  };
}
