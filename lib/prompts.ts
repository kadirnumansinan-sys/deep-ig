import prompts from '@/config/ai-prompts.json';

/**
 * Yapay zeka talimatları config/ai-prompts.json dosyasında tutulur; metin değişikliği
 * için kod dosyalarına dokunmak gerekmez. Satırlar tek metne birleştirilir ve
 * {placeholder} adları çalışma anında doldurulur.
 */
export type PromptValues = Record<string, string | number>;

function fill(line: string, values: PromptValues): string {
  return line.replace(/\{(\w+)\}/gu, (match, key: string) => (
    key in values ? String(values[key]) : match
  ));
}

function joinLines(lines: readonly string[], values: PromptValues, extra: string[]): string {
  return [...lines.map((line) => fill(line, values)), ...extra]
    .filter(Boolean)
    .join('\n');
}

/** Aday haberleri puanlayan modele verilen talimat. */
export function candidateAnalysisPrompt(): string {
  return joinLines(prompts.candidateAnalysis.system, {}, []);
}

/** Eksik haber taraması yapan modele verilen talimat. */
export function gapScanPrompt(): string {
  return joinLines(prompts.gapScan.system, {}, []);
}

/** Kanala göre eksik haber taramasının odak cümlesi. */
export function gapScanFocus(channel: string): string {
  const focus = prompts.gapScan.focus as Record<string, string | undefined>;
  return focus[channel] || focus.news || '';
}

/** Metin yazan modele verilen talimat; kelime sınırları ve düzeltme notu eklenir. */
export function copyDeskPrompt(values: PromptValues, correction = '', channelExtra: readonly string[] = []): string {
  const extra = [...channelExtra.map((line) => fill(line, values))];
  if (correction) extra.push(correction);
  return joinLines(prompts.copyDesk.instructions, values, extra);
}

/** Kanala özgü ek copy desk talimatları (ör. history için tarih biçimi). */
export function historyVisualInstructions(): readonly string[] {
  return prompts.copyDesk.historyVisual;
}
