import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/lib/auth';
import type { Channel } from '@/lib/content';
import { hasSufficientSourceDetail, stripSourceAttribution } from '@/lib/copy-guard';
import {
  buildCopyInstructions,
  captionWithHashtags,
  copyFromWordArrays,
  copyJsonSchema,
  type GeneratedCopy,
  type GeneratedWordArrays,
  limitedText,
  sanitizeGeneratedCopy,
  validationIssue,
  wordCount,
} from '@/lib/copywriter';
import {
  generateCopyWithGroq,
  groqCopyModel,
  groqStatusWithDurableUsage,
  GroqUnavailableError,
} from '@/lib/groq';
import { getProviderUsage, recordProviderTokens, reserveProviderRequest } from '@/lib/database';
import { istanbulNowDate } from '@/lib/news-intelligence';

export const dynamic = 'force-dynamic';

const endpoint = 'https://api.openai.com/v1/responses';
const model = 'gpt-5.6-luna';
const channels = new Set<Channel>(['history', 'news', 'international', 'media']);

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { code?: string; message?: string; type?: string };
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function copyDailyLimit(): number {
  return positiveInteger(process.env.OPENAI_DAILY_COPY_LIMIT, 40);
}

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function extractOutputText(payload: OpenAIResponse): string {
  if (typeof payload.output_text === 'string') return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  return '';
}

function parseGeneratedCopy(payload: OpenAIResponse): GeneratedCopy | null {
  const output = extractOutputText(payload);
  if (!output) return null;
  try {
    return copyFromWordArrays(JSON.parse(output) as Partial<GeneratedWordArrays>);
  } catch {
    return null;
  }
}

function providerMessage(status: number, payload: OpenAIResponse): string {
  const detail = `${payload.error?.code || ''} ${payload.error?.message || ''}`.toLocaleLowerCase('en-US');
  if (status === 401) {
    return 'OpenAI API anahtarı reddedildi. OPENAI_API_KEY değerini kontrol et.';
  }
  if (status === 403) {
    return 'OpenAI metin modeline erişim reddedildi. Proje ve model yetkilerini kontrol et.';
  }
  if (status === 429 || detail.includes('quota') || detail.includes('rate limit')) {
    return 'OpenAI kullanım kotası veya istek sınırına ulaşıldı. Bakiye ve proje limitlerini kontrol et.';
  }
  return 'OpenAI metinleri üretemedi. Biraz sonra yeniden dene.';
}

async function generate(
  apiKey: string,
  channel: Channel,
  sourceTitle: string,
  sourceText: string,
  correction = '',
): Promise<GeneratedCopy> {
  const usageDate = istanbulNowDate();
  const reservation = await reserveProviderRequest('openai', 'copy', usageDate, copyDailyLimit());
  if (!reservation.allowed) throw new Error('OpenAI metin günlük güvenlik sınırına ulaştı.');
  const instructions = buildCopyInstructions(channel, correction);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions,
      input: JSON.stringify({
        SOURCE_DATA: {
          channel,
          title: sourceTitle,
          text: sourceText,
        },
      }),
      // Kelime dizisi JSON'unda 54 kelimelik caption 353 token yakıyor; 95 kelimelik
      // üst sınır 500'lük bütçeyi aşıp yanıtı kesiyor ve parse null dönüyordu.
      max_output_tokens: 1200,
      reasoning: { effort: 'none' },
      prompt_cache_key: 'deepbrief-copy-v3',
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'deepbrief_copy',
          strict: true,
          schema: copyJsonSchema,
        },
      },
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(45_000),
  });

  const payload = await response.json().catch(() => ({})) as OpenAIResponse;
  await recordProviderTokens(
    'openai',
    'copy',
    usageDate,
    Number(payload.usage?.input_tokens || 0),
    Number(payload.usage?.output_tokens || 0),
  );
  if (!response.ok) throw new Error(providerMessage(response.status, payload));
  const copy = parseGeneratedCopy(payload);
  if (!copy) throw new Error('OpenAI geçerli metin alanları döndürmedi. Yeniden dene.');
  return copy;
}

function correctionPrompt(issue: string): string {
  return `The previous response failed validation: ${issue}. Rewrite both fields and obey every factuality, non-repetition, source-exclusion, word-count, and language constraint exactly.`;
}

// Önce Groq (ücretsiz) denenir; doğrulama geçmezse veya Groq kullanılamazsa OpenAI'ye düşülür.
async function generateWithGroqFirst(
  channel: Channel,
  sourceTitle: string,
  sourceText: string,
  sourceName: string,
): Promise<{ copy: GeneratedCopy; provider: 'groq'; model: string } | null> {
  try {
    let copy = sanitizeGeneratedCopy(await generateCopyWithGroq(channel, sourceTitle, sourceText), sourceName);
    let issue = validationIssue(copy, channel, sourceName);
    if (issue) {
      copy = sanitizeGeneratedCopy(
        await generateCopyWithGroq(channel, sourceTitle, sourceText, correctionPrompt(issue)),
        sourceName,
      );
      issue = validationIssue(copy, channel, sourceName);
    }
    if (issue) {
      console.warn('[generate-copy] Groq doğrulamayı geçemedi, OpenAI yedeğine düşülüyor:', issue);
      return null;
    }
    return { copy, provider: 'groq', model: groqCopyModel() };
  } catch (error) {
    // Sessiz yutulan hata Groq yolunun neden hiç çalışmadığını gizliyordu; log kalsın.
    console.warn('[generate-copy] Groq hatası, OpenAI yedeğine düşülüyor:', (error as Error)?.message ?? error);
    return null;
  }
}

export async function GET(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const [usage, groq] = await Promise.all([
    getProviderUsage('openai', 'copy', istanbulNowDate()),
    groqStatusWithDurableUsage(),
  ]);
  return NextResponse.json({
    configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    provider: 'OpenAI Responses API',
    model,
    usage: { ...usage, limit: copyDailyLimit() },
    groq: {
      configured: groq.configured,
      model: groq.copyModel,
      // Ücretsiz havuzun gerçek deneme sırası; arayüz artık sabit "Groq" yazmıyor.
      providerOrder: groq.providerOrder,
      usage: {
        requests: groq.usage.copy,
        limit: groq.usage.copyLimit,
      },
    },
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  try {
    const input = await request.json() as Record<string, unknown>;
    const channel = limitedText(input.channel, 32) as Channel;
    const forcedProvider = limitedText(input.provider, 16);
    const rawSourceTitle = limitedText(input.sourceTitle, 300);
    const rawSourceText = limitedText(input.sourceText, 6_000);
    const sourceName = limitedText(input.sourceName, 160);
    const sourceTitle = stripSourceAttribution(rawSourceTitle, sourceName);
    const sourceText = stripSourceAttribution(rawSourceText, sourceName);

    if (!channels.has(channel)) return jsonError('Geçersiz yayın kanalı.', 400);
    if (!sourceTitle || sourceText.length < 12) {
      return jsonError('Metin üretmek için önce bugünün kaynaklarından bir içerik seç.', 400);
    }
    if (!hasSufficientSourceDetail(sourceTitle, sourceText)) {
      return jsonError('Seçilen kaynak yalnızca başlıktan oluşuyor veya yeterli ayrıntı vermiyor. Tekrarlı ya da uydurma metin üretmemek için daha ayrıntılı başka bir haber seç.', 422);
    }

    if (forcedProvider !== 'openai') {
      const groqResult = await generateWithGroqFirst(channel, sourceTitle, sourceText, sourceName);
      if (groqResult) {
        return NextResponse.json({
          ...groqResult.copy,
          // Etiketler açıklamanın sonunda gider; kelime sayısı yalnızca düz metni sayar.
          caption: captionWithHashtags(groqResult.copy),
          wordCounts: {
            coverTitle: wordCount(groqResult.copy.coverTitle),
            visualText: wordCount(groqResult.copy.visualText),
            caption: wordCount(groqResult.copy.caption),
          },
          provider: groqResult.provider,
          model: groqResult.model,
        }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
    }

    if (!apiKey) {
      return jsonError(
        forcedProvider === 'openai'
          ? 'OPENAI_API_KEY sunucuda ayarlı değil.'
          : 'Groq metin üretemedi ve OPENAI_API_KEY sunucuda ayarlı değil.',
        503,
      );
    }

    let copy = sanitizeGeneratedCopy(await generate(apiKey, channel, sourceTitle, sourceText), sourceName);
    let issue = validationIssue(copy, channel, sourceName);
    if (issue) {
      copy = sanitizeGeneratedCopy(
        await generate(apiKey, channel, sourceTitle, sourceText, correctionPrompt(issue)),
        sourceName,
      );
      issue = validationIssue(copy, channel, sourceName);
    }
    if (issue) {
      return jsonError('Üretilen metin kaynak adı, tekrar, dil veya kelime aralığı kalite kontrolünü geçemedi. Başka bir haber seç veya yeniden dene.', 502);
    }

    return NextResponse.json({
      ...copy,
      caption: captionWithHashtags(copy),
      wordCounts: {
        coverTitle: wordCount(copy.coverTitle),
        visualText: wordCount(copy.visualText),
        caption: wordCount(copy.caption),
      },
      provider: 'openai',
      model,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof GroqUnavailableError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof Error && error.message.includes('günlük güvenlik sınırına')) {
      return jsonError(error.message, 429);
    }
    if (error instanceof SyntaxError) return jsonError('Geçersiz istek.', 400);
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return jsonError('OpenAI metin üretme isteği zaman aşımına uğradı.', 504);
    }
    return jsonError(error instanceof Error ? error.message : 'Metinler üretilemedi.', 502);
  }
}
