import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import { getProviderUsage, reserveProviderRequest } from '@/lib/database';
import { istanbulNowDate } from '@/lib/news-intelligence';

export const dynamic = 'force-dynamic';

const endpoint = 'https://api.openai.com/v1/images/edits';
const model = 'gpt-image-2';
const maximumFileSize = 12 * 1024 * 1024;
const minimumOutputPixels = 655_360;
// Cost guard: Instagram exports do not need 2K/4K GPT Image output.
const maximumOutputPixels = 2_073_600;
const maximumOutputEdge = 1_920;
const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const preservationPrompt = [
  'Enhance and upscale this factual source photograph only.',
  'Preserve the exact composition, crop, aspect ratio, people, faces, bodies, objects, text, logos, background, colors, lighting, and every factual detail.',
  'Improve only resolution, sharpness, fine detail, and compression artifacts.',
  'Do not add, remove, replace, invent, stylize, retouch, beautify, reframe, crop, or alter any element.',
  'Return the same photograph at higher resolution.',
].join(' ');

function upscaleDailyLimit(): number {
  const parsed = Number.parseInt(process.env.OPENAI_DAILY_UPSCALE_LIMIT || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
}

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string }>;
  error?: { code?: string; message?: string; type?: string };
};

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function getApiKey() {
  // STABILITY_API_KEY fallback keeps existing local .env files working while they are renamed.
  return process.env.OPENAI_API_KEY?.trim() || process.env.STABILITY_API_KEY?.trim();
}

function providerMessage(status: number, payload?: OpenAIImageResponse): string {
  const detail = `${payload?.error?.code || ''} ${payload?.error?.message || ''}`.toLocaleLowerCase('en-US');

  if (detail.includes('organization verification') || detail.includes('verify your organization')) {
    return 'OpenAI hesabında GPT Image erişimi için kuruluş doğrulaması gerekiyor.';
  }
  if (status === 401) {
    return 'OpenAI API anahtarı reddedildi. OPENAI_API_KEY değerini ve anahtarın etkin olduğunu kontrol et.';
  }
  if (status === 403) {
    return 'OpenAI GPT Image erişimi reddedildi. Proje yetkilerini ve kuruluş doğrulamasını kontrol et.';
  }
  if (status === 429) {
    return 'OpenAI kullanım kotası veya istek sınırına ulaşıldı. API bakiyesini ve proje limitlerini kontrol et.';
  }
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return 'Görsel OpenAI işleme sınırlarına uymuyor. JPG, PNG veya WEBP dosyasıyla yeniden dene.';
  }
  return 'OpenAI görseli işleyemedi. Biraz sonra yeniden dene.';
}

function parseDimension(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function outputSize(width: number, height: number): string | null {
  const aspectRatio = Math.max(width, height) / Math.min(width, height);
  if (aspectRatio > 3) return null;

  const sourcePixels = width * height;
  const minimumScale = Math.sqrt(minimumOutputPixels / sourcePixels);
  const maximumScale = Math.min(
    maximumOutputEdge / width,
    maximumOutputEdge / height,
    Math.sqrt(maximumOutputPixels / sourcePixels),
  );
  const longEdge = Math.max(width, height);
  const targetScale = Math.max(minimumScale, Math.min(4, maximumOutputEdge / longEdge));
  const scale = Math.min(targetScale, maximumScale);

  let targetWidth = Math.max(16, Math.floor((width * scale) / 16) * 16);
  let targetHeight = Math.max(16, Math.floor((height * scale) / 16) * 16);

  if (targetWidth * targetHeight < minimumOutputPixels) {
    targetWidth = Math.ceil((width * minimumScale) / 16) * 16;
    targetHeight = Math.ceil((height * minimumScale) / 16) * 16;
  }

  if (
    targetWidth > maximumOutputEdge
    || targetHeight > maximumOutputEdge
    || targetWidth * targetHeight > maximumOutputPixels
  ) {
    targetWidth = Math.max(16, Math.floor((width * maximumScale) / 16) * 16);
    targetHeight = Math.max(16, Math.floor((height * maximumScale) / 16) * 16);
  }

  return `${targetWidth}x${targetHeight}`;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const usage = await getProviderUsage('openai', 'upscale', istanbulNowDate());
  return NextResponse.json({
    configured: Boolean(getApiKey()),
    provider: 'OpenAI GPT Image 2',
    model,
    quality: 'medium',
    usage: { ...usage, limit: upscaleDailyLimit() },
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const apiKey = getApiKey();
  if (!apiKey) {
    return jsonError('OPENAI_API_KEY sunucuda ayarlı değil.', 503);
  }

  try {
    const requestForm = await request.formData();
    const image = requestForm.get('image');
    const width = parseDimension(requestForm.get('width'));
    const height = parseDimension(requestForm.get('height'));

    if (!(image instanceof File)) {
      return jsonError('Kalite artırma için bir görsel gönderilmedi.', 400);
    }
    if (!supportedTypes.has(image.type)) {
      return jsonError('Yalnızca JPG, PNG veya WEBP görseller desteklenir.', 415);
    }
    if (image.size > maximumFileSize) {
      return jsonError('Görsel 12 MB sınırını aşıyor.', 413);
    }
    if (!width || !height) {
      return jsonError('Kaynak görsel boyutları okunamadı.', 400);
    }

    const size = outputSize(width, height);
    if (!size) {
      return jsonError('Görsel oranı 3:1 sınırını aştığı için kırpılmadan işlenemiyor.', 422);
    }

    const reservation = await reserveProviderRequest(
      'openai',
      'upscale',
      istanbulNowDate(),
      upscaleDailyLimit(),
    );
    if (!reservation.allowed) {
      return jsonError('Günlük görsel kalite artırma güvenlik sınırına ulaşıldı.', 429);
    }

    const providerForm = new FormData();
    providerForm.append('model', model);
    providerForm.append('image[]', image, image.name || 'deepbrief-source.webp');
    providerForm.append('prompt', preservationPrompt);
    providerForm.append('quality', 'medium');
    providerForm.append('size', size);
    providerForm.append('output_format', 'webp');
    providerForm.append('output_compression', '95');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: providerForm,
      cache: 'no-store',
      signal: AbortSignal.timeout(180_000),
    });

    const payload = await response.json().catch(() => ({})) as OpenAIImageResponse;
    if (!response.ok) {
      return jsonError(providerMessage(response.status, payload), response.status);
    }

    const imageBase64 = payload.data?.[0]?.b64_json;
    if (!imageBase64) {
      return jsonError('OpenAI geçerli bir görsel döndürmedi.', 502);
    }

    return new NextResponse(decodeBase64(imageBase64), {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'image/webp',
        'X-Upscale-Provider': 'openai-gpt-image-2',
        'X-Upscale-Size': size,
      },
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return jsonError('OpenAI görsel kalite artırma isteği zaman aşımına uğradı.', 504);
    }
    return jsonError('OpenAI görsel kalite artırma servisine ulaşılamadı.', 502);
  }
}
