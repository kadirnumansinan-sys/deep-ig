import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import { groqStatusWithDurableUsage } from '@/lib/groq';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  return NextResponse.json(await groqStatusWithDurableUsage(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
