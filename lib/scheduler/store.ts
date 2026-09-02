import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Channel } from '@/lib/content';

// Vercel'de dosya sistemi kalıcı değil; yayın kuyruğu bu yüzden sqlite yerine Postgres'te tutulur.
// `lib/database.ts` (sqlite/D1) olduğu gibi kalır, bu modül ondan bağımsızdır.

export class SchedulerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerConfigError';
  }
}

export type PostStatus =
  | 'scheduled'
  | 'creating'
  | 'processing'
  | 'published'
  | 'failed'
  | 'canceled';

export type ScheduledPost = {
  id: string;
  channel: Channel;
  caption: string;
  videoUrl: string;
  coverUrl: string;
  scheduledAt: Date;
  status: PostStatus;
  containerId: string | null;
  containerAt: Date | null;
  mediaId: string | null;
  permalink: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredAccount = {
  channel: Channel;
  igUserId: string;
  host: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
};

type Row = Record<string, unknown>;

let client: NeonQueryFunction<false, false> | null = null;
let schemaReady: Promise<void> | null = null;

function connectionString(): string {
  const raw =
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL_UNPOOLED?.trim() ||
    '';
  if (!raw) {
    throw new SchedulerConfigError(
      'Yayın kuyruğu için Postgres bağlantısı yok. Vercel → Storage üzerinden Neon ekleyip DATABASE_URL tanımlayın.',
    );
  }
  return raw;
}

function db(): NeonQueryFunction<false, false> {
  if (!client) client = neon(connectionString());
  return client;
}

export async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS scheduled_posts (
          id text PRIMARY KEY,
          channel text NOT NULL,
          caption text NOT NULL DEFAULT '',
          video_url text NOT NULL,
          cover_url text NOT NULL DEFAULT '',
          scheduled_at timestamptz NOT NULL,
          status text NOT NULL DEFAULT 'scheduled',
          container_id text,
          container_at timestamptz,
          media_id text,
          permalink text,
          attempts integer NOT NULL DEFAULT 0,
          last_error text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS scheduled_posts_due_idx
        ON scheduled_posts (status, scheduled_at)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS ig_accounts (
          channel text PRIMARY KEY,
          ig_user_id text NOT NULL,
          host text NOT NULL,
          access_token text NOT NULL,
          token_expires_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function mapPost(row: Row): ScheduledPost {
  return {
    id: text(row.id),
    channel: text(row.channel) as Channel,
    caption: text(row.caption),
    videoUrl: text(row.video_url),
    coverUrl: text(row.cover_url),
    scheduledAt: toDate(row.scheduled_at) ?? new Date(0),
    status: text(row.status) as PostStatus,
    containerId: optionalText(row.container_id),
    containerAt: toDate(row.container_at),
    mediaId: optionalText(row.media_id),
    permalink: optionalText(row.permalink),
    attempts: typeof row.attempts === 'number' ? row.attempts : Number(row.attempts || 0),
    lastError: optionalText(row.last_error),
    createdAt: toDate(row.created_at) ?? new Date(0),
    updatedAt: toDate(row.updated_at) ?? new Date(0),
  };
}

export async function insertPost(input: {
  id: string;
  channel: Channel;
  caption: string;
  videoUrl: string;
  coverUrl: string;
  scheduledAt: Date;
}): Promise<ScheduledPost> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    INSERT INTO scheduled_posts (id, channel, caption, video_url, cover_url, scheduled_at, status)
    VALUES (${input.id}, ${input.channel}, ${input.caption}, ${input.videoUrl}, ${input.coverUrl},
            ${input.scheduledAt.toISOString()}, 'scheduled')
    RETURNING *
  `) as Row[];
  return mapPost(rows[0]);
}

export async function listPosts(limit = 50): Promise<ScheduledPost[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    SELECT * FROM scheduled_posts
    ORDER BY scheduled_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `) as Row[];
  return rows.map(mapPost);
}

export async function cancelPost(id: string): Promise<ScheduledPost | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    UPDATE scheduled_posts
    SET status = 'canceled', updated_at = now()
    WHERE id = ${id} AND status = 'scheduled'
    RETURNING *
  `) as Row[];
  return rows.length ? mapPost(rows[0]) : null;
}

// Aynı satırı iki eşzamanlı cron tetiklemesinin almaması için claim tek atomik UPDATE.
export async function claimDuePosts(now: Date, limit = 4): Promise<ScheduledPost[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    UPDATE scheduled_posts
    SET status = 'creating', attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM scheduled_posts
      WHERE status = 'scheduled' AND scheduled_at <= ${now.toISOString()}
      ORDER BY scheduled_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `) as Row[];
  return rows.map(mapPost);
}

// `creating` durumunda takılı kalmış satırlar (ör. çağrı zaman aşımına uğradı) 10 dakika sonra
// tekrar denenebilsin diye buraya dahil edilir.
export async function claimProcessingPosts(now: Date, limit = 8): Promise<ScheduledPost[]> {
  await ensureSchema();
  const sql = db();
  const stale = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const rows = (await sql`
    UPDATE scheduled_posts
    SET attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM scheduled_posts
      WHERE (status = 'processing' AND container_id IS NOT NULL)
         OR (status = 'creating' AND updated_at <= ${stale})
      ORDER BY scheduled_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `) as Row[];
  return rows.map(mapPost);
}

export async function markPost(
  id: string,
  patch: {
    status?: PostStatus;
    containerId?: string | null;
    containerAt?: Date | null;
    mediaId?: string | null;
    permalink?: string | null;
    lastError?: string | null;
  },
): Promise<void> {
  await ensureSchema();
  const sql = db();
  const sets: string[] = ['updated_at = now()'];
  const params: Array<string | null> = [];
  const push = (column: string, value: string | null, cast = '') => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.containerId !== undefined) push('container_id', patch.containerId);
  if (patch.containerAt !== undefined) {
    push('container_at', patch.containerAt ? patch.containerAt.toISOString() : null, '::timestamptz');
  }
  if (patch.mediaId !== undefined) push('media_id', patch.mediaId);
  if (patch.permalink !== undefined) push('permalink', patch.permalink);
  if (patch.lastError !== undefined) push('last_error', patch.lastError);
  params.push(id);
  await sql.query(
    `UPDATE scheduled_posts SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params,
  );
}

export async function readAccount(channel: Channel): Promise<StoredAccount | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    SELECT * FROM ig_accounts WHERE channel = ${channel} LIMIT 1
  `) as Row[];
  if (!rows.length) return null;
  const row = rows[0];
  return {
    channel: text(row.channel) as Channel,
    igUserId: text(row.ig_user_id),
    host: text(row.host),
    accessToken: text(row.access_token),
    tokenExpiresAt: toDate(row.token_expires_at),
  };
}

export async function writeAccount(account: StoredAccount): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    INSERT INTO ig_accounts (channel, ig_user_id, host, access_token, token_expires_at, updated_at)
    VALUES (${account.channel}, ${account.igUserId}, ${account.host}, ${account.accessToken},
            ${account.tokenExpiresAt ? account.tokenExpiresAt.toISOString() : null}, now())
    ON CONFLICT (channel) DO UPDATE SET
      ig_user_id = EXCLUDED.ig_user_id,
      host = EXCLUDED.host,
      access_token = EXCLUDED.access_token,
      token_expires_at = EXCLUDED.token_expires_at,
      updated_at = now()
  `;
}

export function isSchedulerConfigured(): boolean {
  return Boolean(
    process.env.DATABASE_URL?.trim() ||
      process.env.POSTGRES_URL?.trim() ||
      process.env.DATABASE_URL_UNPOOLED?.trim(),
  );
}
