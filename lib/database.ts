import type { Channel, ContentCandidate, DiscoveryResponse } from '@/lib/content';

type ProviderTask = 'analysis' | 'search' | 'copy' | 'upscale';

type SqliteStatement = {
  all: (...values: unknown[]) => unknown[];
  get: (...values: unknown[]) => unknown;
  run: (...values: unknown[]) => unknown;
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

type DatabaseBackend =
  | { kind: 'd1'; db: D1Database }
  | { kind: 'sqlite'; db: SqliteDatabase };

type StatementInput = { sql: string; values?: unknown[] };

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS deepbrief_candidates (
    channel TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    cluster_id TEXT,
    source_url TEXT NOT NULL,
    source_name TEXT NOT NULL,
    title TEXT NOT NULL,
    published_at TEXT,
    freshness_status TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel, candidate_id)
  )`,
  `CREATE INDEX IF NOT EXISTS deepbrief_candidates_recent_idx
    ON deepbrief_candidates (channel, last_seen_at DESC)`,
  `CREATE INDEX IF NOT EXISTS deepbrief_candidates_cluster_idx
    ON deepbrief_candidates (channel, cluster_id, last_seen_at DESC)`,
  `CREATE INDEX IF NOT EXISTS deepbrief_candidates_cleanup_idx
    ON deepbrief_candidates (last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS deepbrief_source_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_label TEXT NOT NULL,
    status TEXT NOT NULL,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    detail TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS deepbrief_source_checks_recent_idx
    ON deepbrief_source_checks (source_id, checked_at DESC)`,
  `CREATE INDEX IF NOT EXISTS deepbrief_source_checks_cleanup_idx
    ON deepbrief_source_checks (checked_at)`,
  `CREATE TABLE IF NOT EXISTS deepbrief_provider_usage (
    provider TEXT NOT NULL,
    task TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, task, usage_date)
  )`,
  `CREATE TABLE IF NOT EXISTS deepbrief_provider_cache (
    cache_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    task TEXT NOT NULL,
    model TEXT NOT NULL,
    payload TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS deepbrief_provider_cache_expiry_idx
    ON deepbrief_provider_cache (expires_at)`,
  `CREATE TABLE IF NOT EXISTS deepbrief_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
    password_hash TEXT NOT NULL,
    totp_secret_cipher TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    last_totp_step INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    last_login_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deepbrief_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES deepbrief_users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip_hash TEXT,
    user_agent TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS deepbrief_sessions_user_idx
    ON deepbrief_sessions (user_id, expires_at DESC)`,
  `CREATE TABLE IF NOT EXISTS deepbrief_auth_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES deepbrief_users(id) ON DELETE CASCADE,
    challenge_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS deepbrief_auth_challenges_expiry_idx
    ON deepbrief_auth_challenges (expires_at)`,
  `CREATE TABLE IF NOT EXISTS deepbrief_recovery_codes (
    user_id TEXT NOT NULL REFERENCES deepbrief_users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, code_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS deepbrief_auth_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    event_type TEXT NOT NULL,
    ip_hash TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS deepbrief_auth_audit_recent_idx
    ON deepbrief_auth_audit (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS deepbrief_jobs (
    job_name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_started_at INTEGER NOT NULL,
    last_completed_at INTEGER,
    detail TEXT
  )`,
];

let backendPromise: Promise<DatabaseBackend> | null = null;
let schemaPromise: Promise<void> | null = null;
let lastDatabaseError = '';

function sqlitePath(): string {
  return process.env.DEEPBRIEF_DB_PATH?.trim() || '.deepbrief/deepbrief.sqlite';
}

async function cloudflareDatabase(): Promise<D1Database | null> {
  try {
    const runtime = await import('cloudflare:workers');
    const database = (runtime.env as unknown as { DB?: D1Database }).DB;
    return database?.prepare ? database : null;
  } catch {
    return null;
  }
}

async function sqliteDatabase(): Promise<SqliteDatabase> {
  const [{ DatabaseSync }, pathModule, fsModule] = await Promise.all([
    import('node:sqlite'),
    import('node:path'),
    import('node:fs'),
  ]);
  const configuredPath = sqlitePath();
  const filename = configuredPath === ':memory:' ? configuredPath : pathModule.resolve(configuredPath);
  if (filename !== ':memory:') fsModule.mkdirSync(pathModule.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename) as unknown as SqliteDatabase;
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=FULL');
  database.exec('PRAGMA foreign_keys=ON');
  database.exec('PRAGMA busy_timeout=5000');
  return database;
}

async function backend(): Promise<DatabaseBackend> {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    const d1 = await cloudflareDatabase();
    if (d1) return { kind: 'd1' as const, db: d1 };
    return { kind: 'sqlite' as const, db: await sqliteDatabase() };
  })().catch((error) => {
    backendPromise = null;
    throw error;
  });
  return backendPromise;
}

async function run(statement: StatementInput): Promise<void> {
  const active = await backend();
  if (active.kind === 'd1') {
    await active.db.prepare(statement.sql).bind(...(statement.values || [])).run();
    return;
  }
  active.db.prepare(statement.sql).run(...(statement.values || []));
}

async function all<T>(statement: StatementInput): Promise<T[]> {
  const active = await backend();
  if (active.kind === 'd1') {
    const result = await active.db.prepare(statement.sql).bind(...(statement.values || [])).all<T>();
    return result.results || [];
  }
  return active.db.prepare(statement.sql).all(...(statement.values || [])) as T[];
}

async function first<T>(statement: StatementInput): Promise<T | null> {
  const active = await backend();
  if (active.kind === 'd1') {
    return await active.db.prepare(statement.sql).bind(...(statement.values || [])).first<T>();
  }
  return (active.db.prepare(statement.sql).get(...(statement.values || [])) as T | undefined) || null;
}

async function batch(statements: StatementInput[]): Promise<void> {
  if (!statements.length) return;
  const active = await backend();
  if (active.kind === 'd1') {
    await active.db.batch(statements.map((statement) => (
      active.db.prepare(statement.sql).bind(...(statement.values || []))
    )));
    return;
  }
  active.db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of statements) {
      active.db.prepare(statement.sql).run(...(statement.values || []));
    }
    active.db.exec('COMMIT');
  } catch (error) {
    active.db.exec('ROLLBACK');
    throw error;
  }
}

export function databaseConfigured(): boolean {
  return true;
}

export function databaseLastError(): string {
  return lastDatabaseError;
}

export async function databaseEngine(): Promise<'d1' | 'sqlite' | 'unavailable'> {
  try {
    return (await backend()).kind;
  } catch {
    return 'unavailable';
  }
}

export async function ensureDatabase(): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const active = await backend();
    if (active.kind === 'd1') {
      await active.db.batch(schemaStatements.map((statement) => active.db.prepare(statement)));
    } else {
      active.db.exec(schemaStatements.map((statement) => `${statement};`).join('\n'));
    }
    lastDatabaseError = '';
  })().catch((error) => {
    schemaPromise = null;
    lastDatabaseError = error instanceof Error ? error.message.slice(0, 240) : 'Database initialization failed';
    throw error;
  });
  return schemaPromise;
}

function validDateOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function persistDiscoverySnapshot(
  channel: Channel,
  payload: DiscoveryResponse,
): Promise<boolean> {
  try {
    await ensureDatabase();
    const candidateQueries: StatementInput[] = payload.candidates.map((candidate) => ({
      sql: `INSERT INTO deepbrief_candidates (
        channel, candidate_id, cluster_id, source_url, source_name, title,
        published_at, freshness_status, score, payload, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (channel, candidate_id) DO UPDATE SET
        cluster_id = excluded.cluster_id,
        source_url = excluded.source_url,
        source_name = excluded.source_name,
        title = excluded.title,
        published_at = excluded.published_at,
        freshness_status = excluded.freshness_status,
        score = excluded.score,
        payload = excluded.payload,
        last_seen_at = datetime('now')`,
      values: [
        channel,
        candidate.id,
        candidate.clusterId || null,
        candidate.sourceUrl,
        candidate.sourceName,
        candidate.title,
        validDateOrNull(candidate.publishedAt),
        candidate.freshnessStatus || 'unverified',
        candidate.score,
        JSON.stringify(candidate),
      ],
    }));
    const sourceQueries: StatementInput[] = payload.sourceStatus.map((source) => ({
      sql: `INSERT INTO deepbrief_source_checks (
        channel, source_id, source_label, status, candidate_count, latency_ms, detail, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      values: [
        channel,
        source.id,
        source.label,
        source.status,
        source.candidateCount || 0,
        source.latencyMs || null,
        source.detail || null,
      ],
    }));
    const queries = [...candidateQueries, ...sourceQueries];
    for (let offset = 0; offset < queries.length; offset += 40) {
      await batch(queries.slice(offset, offset + 40));
    }
    await batch([
      { sql: `DELETE FROM deepbrief_candidates WHERE last_seen_at < datetime('now', '-7 days')` },
      { sql: `DELETE FROM deepbrief_source_checks WHERE checked_at < datetime('now', '-30 days')` },
      { sql: `DELETE FROM deepbrief_provider_cache WHERE expires_at <= datetime('now')` },
      { sql: 'DELETE FROM deepbrief_sessions WHERE expires_at <= ?', values: [Date.now()] },
      { sql: 'DELETE FROM deepbrief_auth_challenges WHERE expires_at <= ?', values: [Date.now()] },
      { sql: 'DELETE FROM deepbrief_auth_audit WHERE created_at < ?', values: [Date.now() - 90 * 24 * 60 * 60_000] },
    ]);
    lastDatabaseError = '';
    return true;
  } catch (error) {
    lastDatabaseError = error instanceof Error ? error.message.slice(0, 240) : 'Discovery persistence failed';
    return false;
  }
}

export async function loadRecentCandidates(
  channel: Channel,
  maximum = 100,
): Promise<ContentCandidate[]> {
  try {
    await ensureDatabase();
    const rows = await all<{ payload: string }>({
      sql: `SELECT payload
        FROM deepbrief_candidates
        WHERE channel = ?
          AND last_seen_at >= datetime('now', '-36 hours')
        ORDER BY
          CASE freshness_status
            WHEN 'today' THEN 0
            WHEN 'updated-today' THEN 1
            WHEN 'unverified' THEN 2
            ELSE 3
          END,
          score DESC,
          last_seen_at DESC
        LIMIT ?`,
      values: [channel, Math.max(1, Math.min(250, maximum))],
    });
    lastDatabaseError = '';
    return rows.flatMap((row) => {
      try {
        const candidate = JSON.parse(row.payload) as ContentCandidate;
        return candidate?.id ? [candidate] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    lastDatabaseError = error instanceof Error ? error.message.slice(0, 240) : 'Candidate archive read failed';
    return [];
  }
}

export async function reserveProviderRequest(
  provider: 'groq' | 'openai',
  task: ProviderTask,
  date: string,
  limit: number,
): Promise<{ allowed: boolean; requests: number; durable: boolean }> {
  try {
    await ensureDatabase();
    const row = await first<{ requests: number }>({
      sql: `INSERT INTO deepbrief_provider_usage (provider, task, usage_date, requests, updated_at)
        VALUES (?, ?, ?, 1, datetime('now'))
        ON CONFLICT (provider, task, usage_date) DO UPDATE SET
          requests = deepbrief_provider_usage.requests + 1,
          updated_at = datetime('now')
        WHERE deepbrief_provider_usage.requests < ?
        RETURNING requests`,
      values: [provider, task, date, Math.max(1, limit)],
    });
    if (!row) {
      const current = await first<{ requests: number }>({
        sql: `SELECT requests FROM deepbrief_provider_usage
          WHERE provider = ? AND task = ? AND usage_date = ?`,
        values: [provider, task, date],
      });
      return { allowed: false, requests: Number(current?.requests || limit), durable: true };
    }
    lastDatabaseError = '';
    return { allowed: true, requests: Number(row.requests), durable: true };
  } catch (error) {
    lastDatabaseError = error instanceof Error ? error.message.slice(0, 240) : 'Provider usage reservation failed';
    return { allowed: true, requests: 0, durable: false };
  }
}

export async function recordProviderTokens(
  provider: 'groq' | 'openai',
  task: ProviderTask,
  date: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  if (!inputTokens && !outputTokens) return;
  try {
    await ensureDatabase();
    await run({
      sql: `INSERT INTO deepbrief_provider_usage (
        provider, task, usage_date, requests, input_tokens, output_tokens, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, datetime('now'))
      ON CONFLICT (provider, task, usage_date) DO UPDATE SET
        input_tokens = deepbrief_provider_usage.input_tokens + excluded.input_tokens,
        output_tokens = deepbrief_provider_usage.output_tokens + excluded.output_tokens,
        updated_at = datetime('now')`,
      values: [provider, task, date, Math.max(0, inputTokens), Math.max(0, outputTokens)],
    });
  } catch (error) {
    lastDatabaseError = error instanceof Error ? error.message.slice(0, 240) : 'Provider token recording failed';
  }
}

export async function getProviderUsage(
  provider: 'groq' | 'openai',
  task: ProviderTask,
  date: string,
): Promise<{ requests: number; inputTokens: number; outputTokens: number }> {
  try {
    await ensureDatabase();
    const row = await first<{ requests: number; input_tokens: number; output_tokens: number }>({
      sql: `SELECT requests, input_tokens, output_tokens FROM deepbrief_provider_usage
        WHERE provider = ? AND task = ? AND usage_date = ? LIMIT 1`,
      values: [provider, task, date],
    });
    return {
      requests: Number(row?.requests || 0),
      inputTokens: Number(row?.input_tokens || 0),
      outputTokens: Number(row?.output_tokens || 0),
    };
  } catch {
    return { requests: 0, inputTokens: 0, outputTokens: 0 };
  }
}

export async function readProviderCache<T>(cacheKey: string): Promise<T | null> {
  try {
    await ensureDatabase();
    const row = await first<{ payload: string }>({
      sql: `SELECT payload FROM deepbrief_provider_cache
        WHERE cache_key = ? AND expires_at > datetime('now') LIMIT 1`,
      values: [cacheKey],
    });
    return row ? JSON.parse(row.payload) as T : null;
  } catch (error) {
    lastDatabaseError = error instanceof Error ? error.message.slice(0, 240) : 'Provider cache read failed';
    return null;
  }
}

export async function writeProviderCache(
  cacheKey: string,
  provider: 'groq' | 'openai',
  task: ProviderTask,
  model: string,
  payload: unknown,
  ttlMs: number,
): Promise<void> {
  try {
    await ensureDatabase();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await run({
      sql: `INSERT INTO deepbrief_provider_cache (
        cache_key, provider, task, model, payload, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (cache_key) DO UPDATE SET
        provider = excluded.provider,
        task = excluded.task,
        model = excluded.model,
        payload = excluded.payload,
        expires_at = excluded.expires_at,
        created_at = datetime('now')`,
      values: [cacheKey, provider, task, model, JSON.stringify(payload), expiresAt],
    });
  } catch (error) {
    lastDatabaseError = error instanceof Error ? error.message.slice(0, 240) : 'Provider cache write failed';
  }
}

export type AuthRole = 'owner' | 'editor';

export type AuthUserRecord = {
  id: string;
  email: string;
  displayName: string;
  role: AuthRole;
  passwordHash: string;
  totpSecretCipher: string;
  totpEnabled: boolean;
  lastTotpStep: number;
  failedAttempts: number;
  lockedUntil: number;
  status: 'active' | 'disabled';
  lastLoginAt: number | null;
  createdAt: number;
};

type AuthUserRow = {
  id: string;
  email: string;
  display_name: string;
  role: AuthRole;
  password_hash: string;
  totp_secret_cipher: string | null;
  totp_enabled: number;
  last_totp_step: number;
  failed_attempts: number;
  locked_until: number;
  status: 'active' | 'disabled';
  last_login_at: number | null;
  created_at: number;
};

function authUserFromRow(row: AuthUserRow): AuthUserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    passwordHash: row.password_hash,
    totpSecretCipher: row.totp_secret_cipher || '',
    totpEnabled: Boolean(row.totp_enabled),
    lastTotpStep: Number(row.last_totp_step || 0),
    failedAttempts: Number(row.failed_attempts || 0),
    lockedUntil: Number(row.locked_until || 0),
    status: row.status,
    lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
    createdAt: Number(row.created_at),
  };
}

const authUserColumns = `id, email, display_name, role, password_hash,
  totp_secret_cipher, totp_enabled, last_totp_step, failed_attempts,
  locked_until, status, last_login_at, created_at`;

export async function authUserCount(): Promise<number> {
  await ensureDatabase();
  const row = await first<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM deepbrief_users' });
  return Number(row?.count || 0);
}

export async function findAuthUserByEmail(email: string): Promise<AuthUserRecord | null> {
  await ensureDatabase();
  const row = await first<AuthUserRow>({
    sql: `SELECT ${authUserColumns} FROM deepbrief_users WHERE email = ? COLLATE NOCASE LIMIT 1`,
    values: [email],
  });
  return row ? authUserFromRow(row) : null;
}

export async function findAuthUserById(id: string): Promise<AuthUserRecord | null> {
  await ensureDatabase();
  const row = await first<AuthUserRow>({
    sql: `SELECT ${authUserColumns} FROM deepbrief_users WHERE id = ? LIMIT 1`,
    values: [id],
  });
  return row ? authUserFromRow(row) : null;
}

export async function createAuthUser(input: {
  id: string;
  email: string;
  displayName: string;
  role: AuthRole;
  passwordHash: string;
}): Promise<void> {
  await ensureDatabase();
  const now = Date.now();
  await run({
    sql: `INSERT INTO deepbrief_users (
      id, email, display_name, role, password_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    values: [input.id, input.email, input.displayName, input.role, input.passwordHash, now, now],
  });
}

export async function listAuthUsers(): Promise<Array<Omit<AuthUserRecord, 'passwordHash' | 'totpSecretCipher'>>> {
  await ensureDatabase();
  const rows = await all<AuthUserRow>({
    sql: `SELECT ${authUserColumns} FROM deepbrief_users ORDER BY created_at ASC LIMIT 3`,
  });
  return rows.map((row) => {
    const user = authUserFromRow(row);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      totpEnabled: user.totpEnabled,
      lastTotpStep: user.lastTotpStep,
      failedAttempts: user.failedAttempts,
      lockedUntil: user.lockedUntil,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  });
}

export async function recordAuthFailure(userId: string): Promise<{ failures: number; lockedUntil: number }> {
  await ensureDatabase();
  const lockUntil = Date.now() + 15 * 60_000;
  const row = await first<{ failed_attempts: number; locked_until: number }>({
    sql: `UPDATE deepbrief_users SET
      failed_attempts = failed_attempts + 1,
      locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN ? ELSE locked_until END,
      updated_at = ?
      WHERE id = ?
      RETURNING failed_attempts, locked_until`,
    values: [lockUntil, Date.now(), userId],
  });
  return {
    failures: Number(row?.failed_attempts || 0),
    lockedUntil: Number(row?.locked_until || 0),
  };
}

export async function clearAuthFailures(userId: string): Promise<void> {
  await ensureDatabase();
  await run({
    sql: `UPDATE deepbrief_users SET failed_attempts = 0, locked_until = 0,
      last_login_at = ?, updated_at = ? WHERE id = ?`,
    values: [Date.now(), Date.now(), userId],
  });
}

export async function enableAuthTotp(
  userId: string,
  cipher: string,
  acceptedStep: number,
  recoveryCodeHashes: string[],
): Promise<void> {
  await ensureDatabase();
  const now = Date.now();
  await batch([
    {
      sql: `UPDATE deepbrief_users SET totp_secret_cipher = ?, totp_enabled = 1,
        last_totp_step = ?, failed_attempts = 0, locked_until = 0, updated_at = ?
        WHERE id = ?`,
      values: [cipher, acceptedStep, now, userId],
    },
    { sql: 'DELETE FROM deepbrief_recovery_codes WHERE user_id = ?', values: [userId] },
    ...recoveryCodeHashes.map((codeHash) => ({
      sql: `INSERT INTO deepbrief_recovery_codes (user_id, code_hash, created_at)
        VALUES (?, ?, ?)`,
      values: [userId, codeHash, now],
    })),
  ]);
}

export async function acceptAuthTotpStep(userId: string, step: number): Promise<boolean> {
  await ensureDatabase();
  const row = await first<{ id: string }>({
    sql: `UPDATE deepbrief_users SET last_totp_step = ?, updated_at = ?
      WHERE id = ? AND last_totp_step < ? RETURNING id`,
    values: [step, Date.now(), userId, step],
  });
  return Boolean(row?.id);
}

export async function consumeAuthRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
  await ensureDatabase();
  const row = await first<{ code_hash: string }>({
    sql: `UPDATE deepbrief_recovery_codes SET used_at = ?
      WHERE user_id = ? AND code_hash = ? AND used_at IS NULL RETURNING code_hash`,
    values: [Date.now(), userId, codeHash],
  });
  return Boolean(row?.code_hash);
}

export async function createAuthChallenge(input: {
  tokenHash: string;
  userId: string;
  type: 'totp-setup';
  payload: string;
  expiresAt: number;
}): Promise<void> {
  await ensureDatabase();
  await run({
    sql: `INSERT INTO deepbrief_auth_challenges (
      token_hash, user_id, challenge_type, payload, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    values: [input.tokenHash, input.userId, input.type, input.payload, Date.now(), input.expiresAt],
  });
}

export async function findAuthChallenge(
  tokenHash: string,
  type: 'totp-setup',
): Promise<{ userId: string; payload: string } | null> {
  await ensureDatabase();
  const row = await first<{ user_id: string; payload: string }>({
    sql: `SELECT user_id, payload FROM deepbrief_auth_challenges
      WHERE token_hash = ? AND challenge_type = ? AND expires_at > ? LIMIT 1`,
    values: [tokenHash, type, Date.now()],
  });
  return row ? { userId: row.user_id, payload: row.payload } : null;
}

export async function deleteAuthChallenge(tokenHash: string): Promise<void> {
  await ensureDatabase();
  await run({ sql: 'DELETE FROM deepbrief_auth_challenges WHERE token_hash = ?', values: [tokenHash] });
}

export async function createAuthSession(input: {
  tokenHash: string;
  userId: string;
  expiresAt: number;
  ipHash: string;
  userAgent: string;
}): Promise<void> {
  await ensureDatabase();
  const now = Date.now();
  await batch([
    {
      sql: `INSERT INTO deepbrief_sessions (
        token_hash, user_id, created_at, last_seen_at, expires_at, ip_hash, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      values: [input.tokenHash, input.userId, now, now, input.expiresAt, input.ipHash, input.userAgent],
    },
    {
      sql: 'DELETE FROM deepbrief_sessions WHERE expires_at <= ?',
      values: [now],
    },
    {
      sql: 'DELETE FROM deepbrief_auth_challenges WHERE expires_at <= ?',
      values: [now],
    },
  ]);
}

export type AuthSessionUser = Pick<
  AuthUserRecord,
  'id' | 'email' | 'displayName' | 'role' | 'totpEnabled' | 'status'
>;

export async function findAuthSession(
  tokenHash: string,
  idleCutoff: number,
): Promise<AuthSessionUser | null> {
  await ensureDatabase();
  const row = await first<{
    id: string;
    email: string;
    display_name: string;
    role: AuthRole;
    totp_enabled: number;
    status: 'active' | 'disabled';
  }>({
    sql: `SELECT u.id, u.email, u.display_name, u.role, u.totp_enabled, u.status
      FROM deepbrief_sessions s
      JOIN deepbrief_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_seen_at > ?
        AND u.status = 'active' LIMIT 1`,
    values: [tokenHash, Date.now(), idleCutoff],
  });
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    totpEnabled: Boolean(row.totp_enabled),
    status: row.status,
  };
}

export async function touchAuthSession(tokenHash: string): Promise<void> {
  await ensureDatabase();
  await run({
    sql: 'UPDATE deepbrief_sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?',
    values: [Date.now(), tokenHash, Date.now() - 5 * 60_000],
  });
}

export async function deleteAuthSession(tokenHash: string): Promise<void> {
  await ensureDatabase();
  await run({ sql: 'DELETE FROM deepbrief_sessions WHERE token_hash = ?', values: [tokenHash] });
}

export async function writeAuthAudit(input: {
  userId?: string;
  event: string;
  ipHash?: string;
  detail?: string;
}): Promise<void> {
  try {
    await ensureDatabase();
    await run({
      sql: `INSERT INTO deepbrief_auth_audit (user_id, event_type, ip_hash, detail, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      values: [input.userId || null, input.event, input.ipHash || null, input.detail?.slice(0, 240) || null, Date.now()],
    });
  } catch {
    // Audit failure must not turn a successful authentication into a lockout.
  }
}

export async function writeJobStatus(input: {
  jobName: string;
  status: 'running' | 'ok' | 'degraded';
  startedAt: number;
  completedAt?: number;
  detail?: string;
}): Promise<void> {
  await ensureDatabase();
  await run({
    sql: `INSERT INTO deepbrief_jobs (
      job_name, status, last_started_at, last_completed_at, detail
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (job_name) DO UPDATE SET
      status = excluded.status,
      last_started_at = excluded.last_started_at,
      last_completed_at = excluded.last_completed_at,
      detail = excluded.detail`,
    values: [
      input.jobName,
      input.status,
      input.startedAt,
      input.completedAt || null,
      input.detail?.slice(0, 500) || null,
    ],
  });
}

export async function readJobStatus(jobName: string): Promise<{
  status: string;
  lastStartedAt: number;
  lastCompletedAt: number | null;
  detail: string;
} | null> {
  try {
    await ensureDatabase();
    const row = await first<{
      status: string;
      last_started_at: number;
      last_completed_at: number | null;
      detail: string | null;
    }>({
      sql: `SELECT status, last_started_at, last_completed_at, detail
        FROM deepbrief_jobs WHERE job_name = ? LIMIT 1`,
      values: [jobName],
    });
    return row ? {
      status: row.status,
      lastStartedAt: Number(row.last_started_at),
      lastCompletedAt: row.last_completed_at === null ? null : Number(row.last_completed_at),
      detail: row.detail || '',
    } : null;
  } catch {
    return null;
  }
}

export async function databaseHealth(): Promise<{
  configured: boolean;
  available: boolean;
  engine: 'd1' | 'sqlite' | 'unavailable';
  error: string;
}> {
  try {
    await ensureDatabase();
    await first<{ ok: number }>({ sql: 'SELECT 1 AS ok' });
    lastDatabaseError = '';
    return { configured: true, available: true, engine: await databaseEngine(), error: '' };
  } catch (error) {
    lastDatabaseError = error instanceof Error ? error.message.slice(0, 240) : 'Database unavailable';
    return { configured: true, available: false, engine: 'unavailable', error: lastDatabaseError };
  }
}
