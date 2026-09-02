/** Kodlayıcıya verilmeye hazır, düzlemsel (planar) PCM ses. */
export type ReelAudio = {
  channelData: Float32Array[];
  sampleRate: number;
};

const TARGET_SAMPLE_RATE = 48000;
const DEFAULT_FADE_IN_SEC = 0.25;
const DEFAULT_FADE_OUT_SEC = 0.6;

export function audioDecodeSupported(): boolean {
  return typeof OfflineAudioContext !== 'undefined';
}

/**
 * mp3'ü indirir, `startSec`'ten itibaren `durationSec` kadar keser (parça kısaysa başa sarar),
 * kazancı uygular ve baş/son yumuşatmasını ekler. Kullanıcı hareketi gerektirmemesi için
 * AudioContext yerine OfflineAudioContext kullanılır.
 */
export async function loadReelAudio(options: {
  url: string;
  startSec: number;
  durationSec: number;
  gain?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  signal?: AbortSignal;
}): Promise<ReelAudio> {
  if (!audioDecodeSupported()) throw new Error('Tarayıcı ses çözmeyi desteklemiyor.');

  const response = await fetch(options.url, { signal: options.signal });
  if (!response.ok) throw new Error(`Müzik dosyası yüklenemedi (${response.status}).`);
  const encoded = await response.arrayBuffer();

  // decodeAudioData bağlamın örnekleme hızına yeniden örnekler.
  const context = new OfflineAudioContext(2, TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(encoded);
  if (decoded.length === 0) throw new Error('Müzik dosyası boş görünüyor.');

  const sampleRate = decoded.sampleRate;
  const channels = Math.min(2, decoded.numberOfChannels);
  const source: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    source.push(decoded.getChannelData(channel));
  }

  const totalFrames = Math.max(1, Math.round(options.durationSec * sampleRate));
  const startFrame = Math.max(0, Math.round(options.startSec * sampleRate)) % decoded.length;
  const output: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const target = new Float32Array(totalFrames);
    const input = source[channel];
    for (let frame = 0; frame < totalFrames; frame += 1) {
      target[frame] = input[(startFrame + frame) % decoded.length];
    }
    output.push(target);
  }

  const gain = options.gain ?? 0.6;
  const fadeIn = Math.min(Math.round((options.fadeInSec ?? DEFAULT_FADE_IN_SEC) * sampleRate), totalFrames);
  const fadeOut = Math.min(Math.round((options.fadeOutSec ?? DEFAULT_FADE_OUT_SEC) * sampleRate), totalFrames);
  for (let frame = 0; frame < totalFrames; frame += 1) {
    let envelope = gain;
    if (fadeIn > 0 && frame < fadeIn) envelope *= frame / fadeIn;
    const fromEnd = totalFrames - 1 - frame;
    if (fadeOut > 0 && fromEnd < fadeOut) envelope *= fromEnd / fadeOut;
    for (const channel of output) channel[frame] *= envelope;
  }

  return { channelData: output, sampleRate };
}
