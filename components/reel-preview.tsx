import type { CSSProperties, RefObject } from 'react';
import type { Channel } from '@/lib/content';

export type CropSettings = {
  zoom: number;
  x: number;
  y: number;
};

export type DraftContent = {
  title: string;
  body: string;
  location: string;
  image: string;
  coverCrop: CropSettings;
  detailCrop: CropSettings;
};

type PreviewProps = {
  channel: Channel;
  draft: DraftContent;
  coverRef: RefObject<HTMLDivElement | null>;
  detailRef: RefObject<HTMLDivElement | null>;
};

const labels: Record<Channel, string> = {
  history: 'History',
  news: 'News',
  international: 'International',
  media: 'Media',
};

const coverLockups: Partial<Record<Channel, string>> = {
  history: '/assets/deepbrief/brand/deepbrief-history-lockup.png',
  news: '/assets/deepbrief/brand/deepbrief-news-lockup.png',
  media: '/assets/deepbrief/brand/deepbrief-media-lockup.png',
};

const coverOverlays: Record<Channel, string> = {
  history: '/assets/deepbrief/overlays/history-cover-gradient-hd.png',
  news: '/assets/deepbrief/overlays/news-red-gradient.png',
  international: '/assets/deepbrief/overlays/news-red-gradient.png',
  media: '/assets/deepbrief/overlays/history-cover-gradient-hd.png',
};

const detailOverlays: Record<Channel, string> = {
  history: '/assets/deepbrief/overlays/history-detail-gradient-hd.png',
  news: '/assets/deepbrief/overlays/news-red-gradient.png',
  international: '/assets/deepbrief/overlays/news-red-gradient.png',
  media: '/assets/deepbrief/overlays/history-detail-gradient-hd.png',
};

const railArtwork: Record<Channel, string> = {
  history: '/assets/deepbrief/rails/deepbrief-detail-rail.png',
  news: '/assets/deepbrief/rails/deepbrief-news-detail-rail.png',
  international: '/assets/deepbrief/rails/deepbrief-news-detail-rail.png',
  media: '/assets/deepbrief/rails/deepbrief-detail-rail.png',
};

const railAvatars: Partial<Record<Channel, string>> = {
  history: '/assets/deepbrief/brand/deepbrief-history-avatar.jpg',
  news: '/assets/deepbrief/brand/deepbrief-news-avatar.jpg',
  international: '/assets/deepbrief/brand/deepbrief-news-avatar.jpg',
  media: '/assets/deepbrief/brand/deepbrief-media-avatar.jpg',
};

function imageStyle(crop: CropSettings): CSSProperties {
  return {
    objectPosition: `${crop.x}% ${crop.y}%`,
    transform: `scale(${crop.zoom})`,
  };
}

function Artwork({ className, src }: { className: string; src: string }) {
  return (
    // Native img lets html-to-image preserve the supplied transparent PNG exactly.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" aria-hidden="true" className={className} crossOrigin="anonymous" draggable="false" src={src} />
  );
}

function ImageLayer({ image, crop, label }: { image: string; crop: CropSettings; label: string }) {
  if (!image) {
    return (
      <div className="canvas-empty">
        <span>GÖRSEL</span>
        <small>{label}</small>
      </div>
    );
  }

  // Native img is required so html-to-image can clone the exact export surface.
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={label} className="canvas-photo" crossOrigin="anonymous" src={image} style={imageStyle(crop)} />;
}

export function ReelPreview({ channel, draft, coverRef, detailRef }: PreviewProps) {
  const copyClass = draft.body.length > 255
    ? 'detail-copy copy-dense'
    : draft.body.length > 205
      ? 'detail-copy copy-compact'
      : 'detail-copy';
  const titleClass = draft.title.length > 110
    ? 'cover-title title-tight'
    : draft.title.length > 80
      ? 'cover-title title-dense'
      : draft.title.length > 55
        ? 'cover-title title-compact'
        : 'cover-title';

  return (
    <div className="preview-grid">
      <article className="asset-block">
        <div className="asset-label">
          <span>01 · THUMBNAIL</span>
          <small>1080 × 1920 · 9:16</small>
        </div>
        <div className={`reel-canvas cover-canvas theme-${channel}`} ref={coverRef}>
          <ImageLayer image={draft.image} crop={draft.coverCrop} label="Kapak görseli" />
          <Artwork className="cover-overlay-art" src={coverOverlays[channel]} />
          {coverLockups[channel]
            ? <Artwork className="cover-brand-art" src={coverLockups[channel]} />
            : (
              <div className="cover-brand">
                <strong>Deepbrief</strong>
                <em>{labels[channel]}</em>
              </div>
            )}
          <h3 className={titleClass}>{draft.title || 'KISA KONU BAŞLIĞI'}</h3>
        </div>
        <p className="asset-note">Koyu renk katmanı · Reels kapak görünümü</p>
      </article>

      <article className="asset-block">
        <div className="asset-label">
          <span>02 · GÖNDERİ</span>
          <small>1080 × 1920 · 3:4 kart</small>
        </div>
        <div className={`reel-canvas detail-canvas theme-${channel}`} ref={detailRef}>
          <div className="detail-card">
            <ImageLayer image={draft.image} crop={draft.detailCrop} label="Gönderi görseli" />
            <Artwork className="detail-overlay-art" src={detailOverlays[channel]} />
            {channel === 'history' && (
              <Artwork className="today-lockup-art" src="/assets/deepbrief/brand/tarihte-bugun-lockup.png" />
            )}
            <Artwork className="rail-artwork" src={railArtwork[channel]} />
            <svg className="rail-icon rail-icon-chat" viewBox="0 0 26 22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
              <path d="M2 20.5V6a4 4 0 0 1 4-4h14a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H7.5L2 20.5Z" />
              <path d="M7.5 7.5h11M7.5 11.5h7" />
            </svg>
            {railAvatars[channel] && <Artwork className="rail-channel-avatar" src={railAvatars[channel]} />}
            <span className="rail-location-art">{draft.location || 'KONUM GİRİLMEDİ'}</span>
            <span className="rail-wordmark-art">Deepbrief</span>
            <p className={copyClass}>{draft.body || 'Kaynağından aldığın gönderi metnini buraya yaz.'}</p>
          </div>
        </div>
        <p className="asset-note">Daha açık renk katmanı · siyah 9:16 zemin üzerinde 3:4 kart</p>
      </article>
    </div>
  );
}
