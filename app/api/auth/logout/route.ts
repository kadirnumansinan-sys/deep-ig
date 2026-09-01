import { NextResponse } from 'next/server';
import { clearSessionCookie, logoutSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  await logoutSession(request);
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  response.headers.set('Set-Cookie', clearSessionCookie(request));
  return response;
}
