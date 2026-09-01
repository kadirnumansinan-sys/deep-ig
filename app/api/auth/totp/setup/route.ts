import { NextResponse } from 'next/server';
import { completeTotpEnrollment, issueSession } from '@/lib/auth';
import { writeAuthAudit } from '@/lib/database';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { challenge?: unknown; code?: unknown };
    const challenge = typeof body.challenge === 'string' ? body.challenge.slice(0, 180) : '';
    const code = typeof body.code === 'string' ? body.code.trim().slice(0, 8) : '';
    if (!challenge || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Geçerli altı haneli kod gerekli.' }, { status: 400 });
    }
    const completed = await completeTotpEnrollment(challenge, code);
    if (!completed) {
      return NextResponse.json({ error: 'Kod geçersiz veya kurulum süresi doldu.' }, { status: 401 });
    }
    await writeAuthAudit({ userId: completed.user.id, event: 'totp-enabled' });
    const response = NextResponse.json({
      ok: true,
      recoveryCodes: completed.recoveryCodes,
      user: {
        id: completed.user.id,
        email: completed.user.email,
        displayName: completed.user.displayName,
        role: completed.user.role,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
    response.headers.set('Set-Cookie', await issueSession(completed.user, request));
    return response;
  } catch {
    return NextResponse.json({ error: 'İki aşamalı doğrulama kurulamadı.' }, { status: 500 });
  }
}
