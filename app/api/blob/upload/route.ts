import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { sessionFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Instagram, Reel videosunu herkese açık bir HTTPS adresinden çeker. Medya tarayıcıda üretildiği
// için önce Vercel Blob'a yüklenir. İstemci yüklemesi 4.5 MB'lık serverless gövde sınırını da aşar.
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return jsonError('Vercel Blob deposu tanımlı değil. BLOB_READ_WRITE_TOKEN ekleyin.', 503);
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return jsonError('Geçersiz istek.', 400);
  }

  try {
    const result = await handleUpload({
      request,
      body,
      // Yetkilendirme burada yapılmazsa uç nokta herkese açık bir yükleme kapısı olur.
      onBeforeGenerateToken: async (pathname) => {
        const session = await sessionFromRequest(request);
        if (!session) throw new Error('Oturum gerekli.');
        if (!pathname.startsWith('deepbrief/')) {
          throw new Error('Geçersiz yükleme yolu.');
        }
        return {
          allowedContentTypes: ['video/mp4', 'image/jpeg'],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
        };
      },
      // Kayıt /api/schedule üzerinden yapılıyor; bu callback yerelde zaten tetiklenmez.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Yükleme başlatılamadı.';
    return jsonError(message, message === 'Oturum gerekli.' ? 401 : 400);
  }
}
