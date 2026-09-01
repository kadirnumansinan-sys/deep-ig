import { NextResponse } from 'next/server';
import {
  authRequired,
  beginTotpEnrollment,
  checkLoginRate,
  ensureBootstrapOwner,
  issueSession,
  normalizeEmail,
  verifyLoginPassword,
  verifySecondFactor,
} from '@/lib/auth';
import { recordAuthFailure, writeAuthAudit } from '@/lib/database';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!authRequired()) {
    return NextResponse.json({ ok: true, authDisabled: true });
  }
  try {
    if (!await ensureBootstrapOwner()) {
      return NextResponse.json({ error: 'İlk yönetici hesabı yapılandırılmadı.' }, { status: 503 });
    }
    const body = await request.json() as { email?: unknown; password?: unknown; code?: unknown };
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password.slice(0, 128) : '';
    const code = typeof body.code === 'string' ? body.code.trim().slice(0, 32) : '';
    if (!email || !password) {
      return NextResponse.json({ error: 'E-posta ve parola gerekli.' }, { status: 400 });
    }
    if (!await checkLoginRate(request, email)) {
      return NextResponse.json({ error: 'Çok fazla deneme yapıldı. 15 dakika sonra tekrar dene.' }, { status: 429 });
    }
    const result = await verifyLoginPassword(email, password);
    if (!result.valid || !result.user) {
      const locked = result.lockedUntil > Date.now() && result.lockedUntil < Number.MAX_SAFE_INTEGER;
      return NextResponse.json({
        error: locked
          ? 'Hesap geçici olarak kilitlendi. 15 dakika sonra tekrar dene.'
          : 'E-posta, parola veya doğrulama kodu hatalı.',
      }, { status: locked ? 429 : 401 });
    }
    if (!result.user.totpEnabled) {
      const enrollment = await beginTotpEnrollment(result.user);
      return NextResponse.json({ ok: false, enrollmentRequired: true, ...enrollment }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (!code) {
      return NextResponse.json({ ok: false, totpRequired: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (!await verifySecondFactor(result.user, code)) {
      await recordAuthFailure(result.user.id);
      await writeAuthAudit({ userId: result.user.id, event: 'login-second-factor-failed' });
      return NextResponse.json({ error: 'E-posta, parola veya doğrulama kodu hatalı.' }, { status: 401 });
    }
    const response = NextResponse.json({
      ok: true,
      user: {
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.displayName,
        role: result.user.role,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
    response.headers.set('Set-Cookie', await issueSession(result.user, request));
    return response;
  } catch {
    return NextResponse.json({ error: 'Giriş işlemi tamamlanamadı.' }, { status: 500 });
  }
}
