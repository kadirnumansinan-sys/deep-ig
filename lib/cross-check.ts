import type { CandidateConflict, ContentCandidate } from '@/lib/content';

/**
 * Aynı olayı anlatan kaynaklar arasındaki çelişkileri bulur.
 * Karşılaştırılan iddialar sayısal ve doğrulanabilir olanlardır: can kaybı, yaralı,
 * gözaltı sayısı, deprem büyüklüğü, oran ve olayın geçtiği ülke. Kişi adlarında
 * karşılaştırma yapılmaz; farklı yazımlar gerçek çelişki olmadan alarm üretirdi.
 */
type ClaimPattern = { key: string; label: string; patterns: RegExp[] };

const CLAIM_PATTERNS: ClaimPattern[] = [
  {
    key: 'toll',
    label: 'Can kaybı',
    patterns: [
      /(\d[\d.,]*)\s*(?:kişi\s+)?(?:ölü|öldü|öld(?:ü|u)ğ\p{L}*|can kayb\p{L}*|hayatını kaybet\p{L}*|yaşamını yitir\p{L}*)/giu,
      /(\d[\d.,]*)\s*(?:people\s+|persons\s+)?(?:killed|dead|deaths|died)/giu,
      /death toll[^\d]{0,24}(\d[\d.,]*)/giu,
    ],
  },
  {
    key: 'injured',
    label: 'Yaralı sayısı',
    patterns: [
      /(\d[\d.,]*)\s*(?:kişi\s+)?(?:yaralı|yaralan\p{L}*)/giu,
      /(\d[\d.,]*)\s*(?:people\s+)?(?:injured|wounded|hurt)/giu,
    ],
  },
  {
    key: 'detained',
    label: 'Gözaltı/tutuklama',
    patterns: [
      /(\d[\d.,]*)\s*(?:kişi\s+)?(?:gözaltı\p{L}*|gözaltına alın\p{L}*|tutukland\p{L}*|tutukla\p{L}*)/giu,
      /(\d[\d.,]*)\s*(?:people\s+)?(?:detained|arrested)/giu,
    ],
  },
  {
    key: 'magnitude',
    label: 'Deprem büyüklüğü',
    patterns: [
      /(\d(?:[.,]\d)?)\s*büyüklüğünde/giu,
      /magnitude[^\d]{0,12}(\d(?:\.\d)?)/giu,
    ],
  },
  {
    key: 'percent',
    label: 'Oran',
    patterns: [
      /%\s?(\d[\d.,]*)/giu,
      /yüzde\s+(\d[\d.,]*)/giu,
      /(\d[\d.,]*)\s?(?:percent|per cent)/giu,
    ],
  },
];

/** "1.250" ve "12,5" gibi yazımları tek sayıya indirger. */
function parseNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/\.(?=\d{3}(?:\D|$))/gu, '').replace(',', '.');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function claimValues(evidence: string, claim: ClaimPattern): number[] {
  const values = new Set<number>();
  for (const pattern of claim.patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(evidence);
    while (match) {
      const value = parseNumber(match[1] || '');
      if (value !== null) values.add(value);
      match = pattern.exec(evidence);
    }
  }
  return Array.from(values).sort((left, right) => left - right);
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toLocaleString('tr-TR');
}

/**
 * Bir olay kümesindeki adayları karşılaştırır. Aynı iddiayı en az iki kaynak
 * veriyor ve ortak bir değerde buluşmuyorlarsa çelişki kaydı üretilir.
 */
export function findConflicts(cluster: ContentCandidate[]): CandidateConflict[] {
  if (cluster.length < 2) return [];
  const conflicts: CandidateConflict[] = [];

  for (const claim of CLAIM_PATTERNS) {
    const reported = new Map<string, number[]>();
    for (const candidate of cluster) {
      if (!candidate.sourceName || reported.has(candidate.sourceName)) continue;
      const values = claimValues(`${candidate.title} ${candidate.summary}`, claim);
      if (values.length > 0) reported.set(candidate.sourceName, values);
    }
    if (reported.size < 2) continue;
    // Bir kaynak "en az 10", diğeri "10-12" diyorsa ortak değer vardır; çelişki sayılmaz.
    const sets = Array.from(reported.values());
    const shared = sets[0].filter((value) => sets.every((set) => set.includes(value)));
    if (shared.length > 0) continue;
    conflicts.push({
      key: claim.key,
      label: claim.label,
      values: Array.from(reported.entries()).map(([sourceName, values]) => ({
        sourceName,
        value: values.map(formatValue).join(' / '),
      })),
    });
  }

  const byCountry = new Map<string, string>();
  for (const candidate of cluster) {
    const country = candidate.location?.country?.trim();
    if (country && candidate.sourceName && !byCountry.has(country)) {
      byCountry.set(country, candidate.sourceName);
    }
  }
  if (byCountry.size >= 2) {
    conflicts.push({
      key: 'location',
      label: 'Olayın geçtiği yer',
      values: Array.from(byCountry.entries()).map(([country, sourceName]) => ({ sourceName, value: country })),
    });
  }

  return conflicts;
}

/** Çelişki kaydını tek satırlık uyarı metnine çevirir. */
export function conflictNote(conflict: CandidateConflict): string {
  const detail = conflict.values.map((item) => `${item.sourceName}: ${item.value}`).join(' · ');
  return `${conflict.label} kaynaklara göre farklı — ${detail}`;
}
