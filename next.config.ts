import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';

function packageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string };
    return raw.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Vercel yüzeysel klon yaptığı için commit sayısı güvenilir değil; kısa SHA kullanıyoruz.
function commitSha(): string {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'nogit';
  }
}

// Her derlemede artan damga: YYAAGG.SSDD (İstanbul saati).
function buildStamp(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '00';
  return `${part('year')}${part('month')}${part('day')}.${part('hour')}${part('minute')}`;
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageVersion(),
    NEXT_PUBLIC_APP_BUILD: buildStamp(),
    NEXT_PUBLIC_APP_COMMIT: commitSha(),
  },
};

export default nextConfig;
