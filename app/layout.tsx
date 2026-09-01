import type { Metadata } from 'next';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/roboto-slab/900.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Deepbrief Content Studio',
  description: 'Deepbrief History, News ve International içerik üretim paneli.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
