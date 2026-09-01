import { argon2id, argon2Verify } from 'hash-wasm';
import { NextResponse } from 'next/server';
import {
  acceptAuthTotpStep,
  authUserCount,
  clearAuthFailures,
  consumeAuthRecoveryCode,
  createAuthChallenge,
  createAuthSession,
  createAuthUser,
  deleteAuthChallenge,
  deleteAuthSession,
  enableAuthTotp,
  findAuthChallenge,
  findAuthSession,
  findAuthUserByEmail,
  findAuthUserById,
  recordAuthFailure,
  touchAuthSession,
  writeAuthAudit,
  type AuthRole,
  type AuthSessionUser,
  type AuthUserRecord,
} from '@/lib/database';

const sessionCookieName = 'deepbrief_session';
const sessionAbsoluteMs = 24 * 60 * 60_000;
const sessionIdleMs = 8 * 60 * 60_000;
const challengeLifetimeMs = 10 * 60_000;
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

type LoginRateEntry = { attempts: number; resetAt: number };
const loginRate = new Map<string, LoginRateEntry>();
let bootstrapPromise: Promise<boolean> | null = null;

export type PublicAuthUser = Pick<AuthSessionUser, 'id' | 'email' | 'displayName' | 'role'>;

export function authRequired(): boolean {
  const explicit = process.env.AUTH_REQUIRED?.trim().toLowerCase();
  if (explicit === 'false' || explicit === '0') return false;
  if (explicit === 'true' || explicit === '1') return true;
  return Boolean(process.env.AUTH_BOOTSTRAP_EMAIL?.trim() || process.env.AUTH_BOOTSTRAP_PASSWORD?.trim());
}

function authSecret(): string {
  const value = process.env.AUTH_SECRET?.trim() || '';
  if (value.length < 32) throw new Error('AUTH_SECRET en az 32 karakter olmalı.');
  return value;
}

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US').slice(0, 180) : '';
}

export function validateNewPassword(value: unknown): string {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 12 || password.length > 128) {
    throw new Error('Parola 12–128 karakter arasında olmalı.');
  }
  return password;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32ToBytes(value: string): Uint8Array {
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of value.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(bytes))));
}

async function encryptionKey(): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authSecret()));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptSecret(secret: string): Promise<string> {
  const iv = randomBytes(12);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv) },
    await encryptionKey(),
    asArrayBuffer(new TextEncoder().encode(secret)),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function decryptSecret(cipher: string): Promise<string> {
  const [version, ivValue, encryptedValue] = cipher.split('.');
  if (version !== 'v1' || !ivValue || !encryptedValue) throw new Error('TOTP anahtarı okunamadı.');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(base64UrlToBytes(ivValue)) },
    await encryptionKey(),
    asArrayBuffer(base64UrlToBytes(encryptedValue)),
  );
  return new TextDecoder().decode(decrypted);
}

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 2,
    memorySize: 19_456,
    hashLength: 32,
    outputType: 'encoded',
  });
}

async function burnPasswordTiming(password: string): Promise<void> {
  await argon2id({
    password: password.slice(0, 128),
    salt: new TextEncoder().encode('deepbrief-login'),
    parallelism: 1,
    iterations: 2,
    memorySize: 19_456,
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function ensureBootstrapOwner(): Promise<boolean> {
  if (!authRequired()) return true;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    authSecret();
    if (await authUserCount() > 0) return true;
    const email = normalizeEmail(process.env.AUTH_BOOTSTRAP_EMAIL);
    const password = process.env.AUTH_BOOTSTRAP_PASSWORD || '';
    const displayName = process.env.AUTH_BOOTSTRAP_NAME?.trim().slice(0, 80) || 'Deepbrief Owner';
    if (!email || !email.includes('@') || password.length < 12) return false;
    try {
      await createAuthUser({
        id: crypto.randomUUID(),
        email,
        displayName,
        role: 'owner',
        passwordHash: await hashPassword(password),
      });
      return true;
    } catch (error) {
      if (await authUserCount() > 0) return true;
      throw error;
    }
  })().catch((error) => {
    bootstrapPromise = null;
    throw error;
  });
  return bootstrapPromise;
}

function requestIp(request: Request): string {
  return (request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]
    || 'local').trim().slice(0, 80);
}

async function requestIpHash(request: Request): Promise<string> {
  return sha256(`${authSecret()}:${requestIp(request)}`);
}

export async function checkLoginRate(request: Request, email: string): Promise<boolean> {
  const key = `${await requestIpHash(request)}:${email}`;
  const now = Date.now();
  const current = loginRate.get(key);
  if (!current || current.resetAt <= now) {
    loginRate.set(key, { attempts: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  current.attempts += 1;
  if (loginRate.size > 500) {
    for (const [entryKey, entry] of loginRate) {
      if (entry.resetAt <= now) loginRate.delete(entryKey);
    }
  }
  return current.attempts <= 12;
}

async function totpAt(secret: string, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let remaining = BigInt(step);
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = Number(remaining & BigInt(255));
    remaining >>= BigInt(8);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(base32ToBytes(secret)),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = digest[digest.length - 1] & 15;
  const number = (
    ((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255)
  ) % 1_000_000;
  return number.toString().padStart(6, '0');
}

async function matchingTotpStep(secret: string, code: string): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(Date.now() / 30_000);
  for (const delta of [0, -1, 1]) {
    const step = current + delta;
    if (await totpAt(secret, step) === code) return step;
  }
  return null;
}

function recoveryCode(): string {
  const raw = bytesToBase32(randomBytes(10)).slice(0, 16);
  return raw.match(/.{1,4}/g)?.join('-') || raw;
}

async function recoveryCodeHash(code: string): Promise<string> {
  return sha256(`${authSecret()}:recovery:${code.toUpperCase().replace(/[^A-Z2-7]/g, '')}`);
}

export async function verifySecondFactor(user: AuthUserRecord, value: string): Promise<boolean> {
  const clean = value.trim();
  if (/^\d{6}$/.test(clean)) {
    const secret = await decryptSecret(user.totpSecretCipher);
    const step = await matchingTotpStep(secret, clean);
    return step !== null && step > user.lastTotpStep && await acceptAuthTotpStep(user.id, step);
  }
  if (!/^[A-Z2-7-]{16,24}$/i.test(clean)) return false;
  return consumeAuthRecoveryCode(user.id, await recoveryCodeHash(clean));
}

export async function verifyLoginPassword(
  email: string,
  password: string,
): Promise<{ user: AuthUserRecord | null; valid: boolean; lockedUntil: number }> {
  const user = await findAuthUserByEmail(email);
  if (!user) {
    await burnPasswordTiming(password);
    return { user: null, valid: false, lockedUntil: 0 };
  }
  if (user.status !== 'active') return { user, valid: false, lockedUntil: Number.MAX_SAFE_INTEGER };
  if (user.lockedUntil > Date.now()) return { user, valid: false, lockedUntil: user.lockedUntil };
  const valid = await argon2Verify({ password, hash: user.passwordHash });
  if (!valid) {
    const failure = await recordAuthFailure(user.id);
    return { user, valid: false, lockedUntil: failure.lockedUntil };
  }
  return { user, valid: true, lockedUntil: 0 };
}

export async function beginTotpEnrollment(user: AuthUserRecord): Promise<{
  challenge: string;
  secret: string;
  uri: string;
}> {
  const secret = bytesToBase32(randomBytes(20));
  const challenge = bytesToBase64Url(randomBytes(32));
  await createAuthChallenge({
    tokenHash: await sha256(challenge),
    userId: user.id,
    type: 'totp-setup',
    payload: await encryptSecret(secret),
    expiresAt: Date.now() + challengeLifetimeMs,
  });
  const label = encodeURIComponent(`Deepbrief:${user.email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=Deepbrief&algorithm=SHA1&digits=6&period=30`;
  return { challenge, secret, uri };
}

export async function completeTotpEnrollment(
  challenge: string,
  code: string,
): Promise<{ user: AuthUserRecord; recoveryCodes: string[] } | null> {
  const tokenHash = await sha256(challenge);
  const record = await findAuthChallenge(tokenHash, 'totp-setup');
  if (!record) return null;
  const user = await findAuthUserById(record.userId);
  if (!user || user.status !== 'active') return null;
  const secret = await decryptSecret(record.payload);
  const step = await matchingTotpStep(secret, code.trim());
  if (step === null) return null;
  const recoveryCodes = Array.from({ length: 8 }, recoveryCode);
  const hashes = await Promise.all(recoveryCodes.map(recoveryCodeHash));
  await enableAuthTotp(user.id, record.payload, step, hashes);
  await deleteAuthChallenge(tokenHash);
  const updated = await findAuthUserById(user.id);
  return updated ? { user: updated, recoveryCodes } : null;
}

function cookieValue(request: Request): string {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === sessionCookieName) return decodeURIComponent(value.join('='));
  }
  return '';
}

function secureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
    || request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
}

function sessionCookie(token: string, request: Request, maxAge = sessionAbsoluteMs / 1_000): string {
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    ...(secureRequest(request) ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookie(request: Request): string {
  return sessionCookie('', request, 0);
}

export async function issueSession(user: AuthUserRecord, request: Request): Promise<string> {
  const token = bytesToBase64Url(randomBytes(32));
  const ipHash = await requestIpHash(request);
  await createAuthSession({
    tokenHash: await sha256(token),
    userId: user.id,
    expiresAt: Date.now() + sessionAbsoluteMs,
    ipHash,
    userAgent: (request.headers.get('user-agent') || '').slice(0, 240),
  });
  await clearAuthFailures(user.id);
  await writeAuthAudit({ userId: user.id, event: 'login-success', ipHash });
  return sessionCookie(token, request);
}

export async function sessionFromRequest(request: Request): Promise<PublicAuthUser | null> {
  if (!authRequired()) {
    return { id: 'local', email: 'local@deepbrief', displayName: 'Deepbrief', role: 'owner' };
  }
  if (!await ensureBootstrapOwner()) return null;
  const token = cookieValue(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const user = await findAuthSession(tokenHash, Date.now() - sessionIdleMs);
  if (!user) return null;
  await touchAuthSession(tokenHash);
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}

export async function logoutSession(request: Request): Promise<void> {
  const token = cookieValue(request);
  if (token) await deleteAuthSession(await sha256(token));
}

export async function requireApiAuth(request: Request): Promise<NextResponse | null> {
  if (!authRequired()) return null;
  try {
    if (!await ensureBootstrapOwner()) {
      return NextResponse.json({ error: 'Kimlik doğrulama yapılandırması tamamlanmadı.' }, { status: 503 });
    }
    if (!await sessionFromRequest(request)) {
      return NextResponse.json({ error: 'Oturum gerekli.' }, { status: 401 });
    }
    return null;
  } catch {
    return NextResponse.json({ error: 'Kimlik doğrulama geçici olarak kullanılamıyor.' }, { status: 503 });
  }
}

export async function createManagedUser(input: {
  email: string;
  displayName: string;
  password: string;
  role?: AuthRole;
}): Promise<void> {
  if (await authUserCount() >= 3) throw new Error('En fazla üç hesap oluşturulabilir.');
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) throw new Error('Geçerli bir e-posta adresi gir.');
  const displayName = input.displayName.trim().slice(0, 80);
  if (displayName.length < 2) throw new Error('Kullanıcı adı en az iki karakter olmalı.');
  await createAuthUser({
    id: crypto.randomUUID(),
    email,
    displayName,
    role: input.role === 'owner' ? 'owner' : 'editor',
    passwordHash: await hashPassword(validateNewPassword(input.password)),
  });
}
