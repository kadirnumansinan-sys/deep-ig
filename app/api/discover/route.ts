import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import { getDiscoveryPayload, validChannel } from '@/lib/discovery/discover';

export const dynamic = 'force-dynamic';

// Tarama mantığı `lib/discovery/*` altında; bu dosya yalnızca HTTP katmanı.
export { getDiscoveryPayload };

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const channel = validChannel(url.searchParams.get('channel'));
  const force = url.searchParams.get('refresh') === '1';
  try {
    const payload = await getDiscoveryPayload(channel, force);
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'private, max-age=30',
        'X-Deepbrief-Cache': force ? 'REFRESHED' : 'READY',
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Kaynaklar okunamadı.',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
