import { createHmac, timingSafeEqual } from 'node:crypto';

const fallbackSecret = 'deepbrief-local-development-signing-key';

function secret(): string {
  return process.env.IMAGE_PROXY_SECRET?.trim() || fallbackSecret;
}

export function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || /^127\./.test(hostname)
      || /^10\./.test(hostname)
      || /^192\.168\./.test(hostname)
      || /^169\.254\./.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

export function signUrl(value: string, purpose: 'image' | 'source'): string {
  return createHmac('sha256', secret()).update(`${purpose}\0${value}`).digest('hex');
}

export function verifyUrlSignature(
  value: string,
  signature: string,
  purpose: 'image' | 'source',
): boolean {
  if (!signature || !isSafeHttpsUrl(value)) return false;
  const expected = Buffer.from(signUrl(value, purpose));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
