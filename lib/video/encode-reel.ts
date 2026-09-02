import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { ReelAudio } from './audio';

export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const REEL_DURATION_SEC = 7;
export const REEL_FPS = 30;
/** Ken Burns bitiş yakınlaştırması. */
export const REEL_ZOOM = 1.06;
/**
 * Kare kaynağı 1080'in bu katında üretilir; en yakın anda bile büyütme olmaz,
 * kırpma her zaman küçültmeye denk gelir.
 */
export const REEL_SOURCE_SCALE = 1.1;

const VIDEO_BITRATE = 10_000_000;
const AUDIO_BITRATE = 128_000;
const AUDIO_CHUNK_FRAMES = 4800;
const MAX_QUEUE = 8;

/** High → Main → Baseline; ilk desteklenen seçilir. */
const VIDEO_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];

export type EncodeReelResult = {
  blob: Blob;
  hasAudio: boolean;
};

/** 1080 × 1920 çıktı koordinatlarında, yalnızca bu alan yakınlaştırılır. */
export type ReelZoomRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function videoExportSupported(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}

function audioEncodeSupported(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
}

async function pickVideoCodec(base: Omit<VideoEncoderConfig, 'codec'>): Promise<string> {
  for (const codec of VIDEO_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported({ ...base, codec });
      if (support.supported) return codec;
    } catch {
      // desteklenmiyorsa sıradakini dene
    }
  }
  throw new Error('Tarayıcı H.264 kodlamayı desteklemiyor. Chrome veya Edge kullan.');
}

async function drainQueue(encoder: { encodeQueueSize: number }): Promise<void> {
  while (encoder.encodeQueueSize > MAX_QUEUE) {
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}

/**
 * Tek bir kareden 7 saniyelik, hafif zoom'lu 1080 × 1920 MP4 üretir.
 * Ses verilmezse veya tarayıcı AAC kodlayamazsa video sessiz çıkar (`hasAudio: false`).
 *
 * `zoomRect` verilirse yakınlaştırma yalnızca o alana uygulanır: `image` sabit zemin olarak
 * çizilir, alan içindeki kırpma kare kare daralır (haber görseli büyür) ve `overlay` —
 * çubuk, rozet ve yazılar — en üste sabit çizilir.
 */
export async function encodeReel(options: {
  image: ImageBitmap;
  overlay?: ImageBitmap | null;
  zoomRect?: ReelZoomRect | null;
  audio?: ReelAudio | null;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}): Promise<EncodeReelResult> {
  if (!videoExportSupported()) {
    throw new Error('Tarayıcı video dışa aktarmayı desteklemiyor. Chrome veya Edge kullan.');
  }

  const { image, overlay = null, zoomRect = null, audio, onProgress, signal } = options;
  const useAudio = Boolean(audio && audio.channelData.length > 0 && audioEncodeSupported());
  let encoderError: Error | null = null;
  const fail = (error: DOMException | Error) => {
    encoderError = error instanceof Error ? error : new Error(String(error));
  };

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory',
    video: { codec: 'avc', width: REEL_WIDTH, height: REEL_HEIGHT, frameRate: REEL_FPS },
    ...(useAudio && audio
      ? {
          audio: {
            codec: 'aac',
            sampleRate: audio.sampleRate,
            numberOfChannels: audio.channelData.length,
          },
        }
      : {}),
  });

  const baseConfig = {
    width: REEL_WIDTH,
    height: REEL_HEIGHT,
    bitrate: VIDEO_BITRATE,
    framerate: REEL_FPS,
  };
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: fail,
  });
  videoEncoder.configure({ ...baseConfig, codec: await pickVideoCodec(baseConfig) });

  const canvas = new OffscreenCanvas(REEL_WIDTH, REEL_HEIGHT);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas 2D bağlamı açılamadı.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const totalFrames = Math.round(REEL_DURATION_SEC * REEL_FPS);
  const frameDurationUs = 1_000_000 / REEL_FPS;
  const keyFrameInterval = REEL_FPS * 2;

  try {
    for (let frame = 0; frame < totalFrames; frame += 1) {
      signal?.throwIfAborted();
      if (encoderError) throw encoderError;

      const progress = totalFrames > 1 ? frame / (totalFrames - 1) : 0;
      const scale = 1 + (REEL_ZOOM - 1) * progress;

      if (zoomRect) {
        // Zemin (arka plan dokusu + yakınlaştırmasız görsel) her karede aynı yerde durur.
        context.drawImage(image, 0, 0, REEL_WIDTH, REEL_HEIGHT);

        // Kaynak kare 1080'in `REEL_SOURCE_SCALE` katında üretiliyor; alan koordinatlarını çevir.
        const sourceScale = image.width / REEL_WIDTH;
        const sourceX = zoomRect.x * sourceScale;
        const sourceY = zoomRect.y * sourceScale;
        const sourceWidth = zoomRect.width * sourceScale;
        const sourceHeight = zoomRect.height * sourceScale;
        const cropWidth = sourceWidth / scale;
        const cropHeight = sourceHeight / scale;
        context.drawImage(
          image,
          sourceX + (sourceWidth - cropWidth) / 2,
          sourceY + (sourceHeight - cropHeight) / 2,
          cropWidth,
          cropHeight,
          zoomRect.x,
          zoomRect.y,
          zoomRect.width,
          zoomRect.height,
        );

        // Çubuk, rozetler ve yazılar sabit katman: yakınlaştırmadan sonra üste çizilir.
        if (overlay) {
          context.drawImage(overlay, zoomRect.x, zoomRect.y, zoomRect.width, zoomRect.height);
        }
      } else {
        const cropWidth = image.width / scale;
        const cropHeight = image.height / scale;
        context.drawImage(
          image,
          (image.width - cropWidth) / 2,
          (image.height - cropHeight) / 2,
          cropWidth,
          cropHeight,
          0,
          0,
          REEL_WIDTH,
          REEL_HEIGHT,
        );
        if (overlay) context.drawImage(overlay, 0, 0, REEL_WIDTH, REEL_HEIGHT);
      }

      const videoFrame = new VideoFrame(canvas, {
        timestamp: Math.round(frame * frameDurationUs),
        duration: Math.round(frameDurationUs),
      });
      videoEncoder.encode(videoFrame, { keyFrame: frame % keyFrameInterval === 0 });
      videoFrame.close();

      await drainQueue(videoEncoder);
      onProgress?.((frame + 1) / totalFrames * (useAudio ? 0.8 : 0.95));
    }

    if (useAudio && audio) {
      const numberOfChannels = audio.channelData.length;
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: fail,
      });
      audioEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: audio.sampleRate,
        numberOfChannels,
        bitrate: AUDIO_BITRATE,
      });

      const audioFrames = audio.channelData[0].length;
      for (let offset = 0; offset < audioFrames; offset += AUDIO_CHUNK_FRAMES) {
        signal?.throwIfAborted();
        if (encoderError) throw encoderError;

        const length = Math.min(AUDIO_CHUNK_FRAMES, audioFrames - offset);
        const planar = new Float32Array(length * numberOfChannels);
        for (let channel = 0; channel < numberOfChannels; channel += 1) {
          planar.set(audio.channelData[channel].subarray(offset, offset + length), channel * length);
        }
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: audio.sampleRate,
          numberOfFrames: length,
          numberOfChannels,
          timestamp: Math.round((offset / audio.sampleRate) * 1_000_000),
          data: planar,
        });
        audioEncoder.encode(data);
        data.close();

        await drainQueue(audioEncoder);
        onProgress?.(0.8 + ((offset + length) / audioFrames) * 0.15);
      }

      await audioEncoder.flush();
      audioEncoder.close();
    }

    await videoEncoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
    onProgress?.(1);
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), hasAudio: useAudio };
  } finally {
    if (videoEncoder.state !== 'closed') videoEncoder.close();
  }
}
