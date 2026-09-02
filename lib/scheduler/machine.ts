import type { ContainerStatusCode } from '@/lib/instagram/client';

// Reels konteyneri işlenmesi 30 sn ile birkaç dakika sürebildiği için yayın akışı tek bir
// serverless çağrısında tamamlanamaz. Karar burada saf bir fonksiyona ayrılır; cron her
// tetiklemede satırın bulunduğu adımı bu fonksiyona sorar.

export const MAX_ATTEMPTS = 8;
export const CONTAINER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type DecisionStep = 'create' | 'wait' | 'publish' | 'done' | 'fail';

export type Decision = { next: DecisionStep; reason: string };

export type DecisionInput = {
  attempts: number;
  containerId: string | null;
  containerAt: Date | null;
};

export function decide(
  row: DecisionInput,
  statusCode: ContainerStatusCode | null,
  now: Date,
): Decision {
  if (row.attempts > MAX_ATTEMPTS) {
    return { next: 'fail', reason: `Deneme sınırı aşıldı (${MAX_ATTEMPTS}).` };
  }
  if (!row.containerId) {
    return { next: 'create', reason: 'Konteyner henüz oluşturulmadı.' };
  }
  if (row.containerAt && now.getTime() - row.containerAt.getTime() > CONTAINER_MAX_AGE_MS) {
    return { next: 'fail', reason: 'Konteyner 24 saatten eski, süresi doldu.' };
  }
  switch (statusCode) {
    case 'FINISHED':
      return { next: 'publish', reason: 'Konteyner hazır.' };
    case 'PUBLISHED':
      return { next: 'done', reason: 'Konteyner zaten yayınlanmış.' };
    case 'IN_PROGRESS':
      return { next: 'wait', reason: 'Instagram videoyu hâlâ işliyor.' };
    case 'ERROR':
      return { next: 'fail', reason: 'Instagram konteyneri hata ile sonuçlandı.' };
    case 'EXPIRED':
      return { next: 'fail', reason: 'Konteyner yayınlanmadan süresi doldu.' };
    default:
      return { next: 'wait', reason: 'Konteyner durumu okunamadı, tekrar denenecek.' };
  }
}

// Instagram Login token'ı 60 gün geçerli. Süre dolmadan 7 gün önce yenileriz.
export const TOKEN_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldRefreshToken(expiresAt: Date | null, now: Date): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - now.getTime() <= TOKEN_REFRESH_WINDOW_MS;
}
