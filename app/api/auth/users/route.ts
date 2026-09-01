import { NextResponse } from 'next/server';
import { authRequired, createManagedUser, sessionFromRequest } from '@/lib/auth';
import { listAuthUsers, writeAuthAudit } from '@/lib/database';

export const dynamic = 'force-dynamic';

async function owner(request: Request) {
  if (!authRequired()) return null;
  const user = await sessionFromRequest(request);
  return user?.role === 'owner' ? user : null;
}

export async function GET(request: Request) {
  if (!await owner(request)) return NextResponse.json({ error: 'Yetki gerekli.' }, { status: 403 });
  return NextResponse.json({ users: await listAuthUsers(), maximum: 3 }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  const current = await owner(request);
  if (!current) return NextResponse.json({ error: 'Yetki gerekli.' }, { status: 403 });
  try {
    const body = await request.json() as {
      email?: unknown;
      displayName?: unknown;
      password?: unknown;
      role?: unknown;
    };
    await createManagedUser({
      email: typeof body.email === 'string' ? body.email : '',
      displayName: typeof body.displayName === 'string' ? body.displayName : '',
      password: typeof body.password === 'string' ? body.password : '',
      role: 'editor',
    });
    await writeAuthAudit({ userId: current.id, event: 'user-created', detail: String(body.email || '') });
    return NextResponse.json({ ok: true, users: await listAuthUsers() }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kullanıcı oluşturulamadı.';
    const conflict = /UNIQUE|zaten|three|üç/i.test(message);
    return NextResponse.json({ error: conflict ? 'Bu e-posta zaten kayıtlı veya üç hesap sınırı dolu.' : message }, {
      status: conflict ? 409 : 400,
    });
  }
}
