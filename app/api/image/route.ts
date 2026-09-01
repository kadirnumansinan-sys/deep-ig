import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import { isSafeHttpsUrl, verifyUrlSignature } from '@/lib/url-signing';

export const dynamic = 'force-dynamic';

const allowedHosts = [
  'images.unsplash.com',
  'upload.wikimedia.org',
  'commons.wikimedia.org',
  'encrypted-tbn0.gstatic.com',
  'encrypted-tbn1.gstatic.com',
  'encrypted-tbn2.gstatic.com',
  'encrypted-tbn3.gstatic.com',
];

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const input = new URL(request.url).searchParams.get('url');
  const signature = new URL(request.url).searchParams.get('signature') ?? '';
  if (!input) return NextResponse.json({ error: 'Görsel adresi eksik.' }, { status: 400 });

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return NextResponse.json({ error: 'Geçersiz görsel adresi.' }, { status: 400 });
  }

  const isBuiltInSource = url.protocol === 'https:' && allowedHosts.includes(url.hostname);
  const isSignedSource = isSafeHttpsUrl(input) && verifyUrlSignature(input, signature, 'image');
  if (!isBuiltInSource && !isSignedSource) {
    return NextResponse.json({ error: 'Bu görsel kaynağına izin verilmiyor.' }, { status: 403 });
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DeepbriefContentStudio/1.0' },
      cache: 'no-store',
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.startsWith('image/')) {
      return NextResponse.json({ error: 'Görsel alınamadı.' }, { status: 502 });
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 20 * 1024 * 1024) {
      return NextResponse.json({ error: 'Görsel 20 MB sınırını aşıyor.' }, { status: 413 });
    }

    return new NextResponse(bytes, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('Image proxy failed', error);
    return NextResponse.json({ error: 'Görsel kaynağına ulaşılamadı.' }, { status: 502 });
  }
}
