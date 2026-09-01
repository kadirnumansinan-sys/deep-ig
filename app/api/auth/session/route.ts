import { NextResponse } from 'next/server';
import { authRequired, ensureBootstrapOwner, sessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const required = authRequired();
    const configured = !required || await ensureBootstrapOwner();
    const user = configured ? await sessionFromRequest(request) : null;
    return NextResponse.json({ required, configured, authenticated: Boolean(user), user }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({
      required: true,
      configured: false,
      authenticated: false,
      user: null,
      error: 'Kimlik doğrulama yapılandırması kullanılamıyor.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
