#!/usr/bin/env node
// public/music içindeki mp3'leri lib/music/catalog.json ile eşitler.
// Yeni dosyalar taslak kayıt olarak eklenir, eksik dosyalar uyarı verir. Mevcut kayıtlar korunur.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const musicDir = join(process.cwd(), 'public', 'music');
const catalogPath = join(process.cwd(), 'lib', 'music', 'catalog.json');

const files = readdirSync(musicDir)
  .filter((name) => name.toLowerCase().endsWith('.mp3'))
  .sort();

let catalog = [];
try {
  catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog)) throw new Error('catalog.json bir dizi olmalı.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const known = new Set(catalog.map((track) => track.file));
const present = new Set(files);

function toId(file) {
  return file
    .replace(/\.mp3$/i, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function toTitle(file) {
  return file
    .replace(/\.mp3$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const added = [];
for (const file of files) {
  if (known.has(file)) continue;
  catalog.push({
    id: toId(file),
    title: toTitle(file),
    artist: '',
    file,
    license: 'BELIRT',
    sourceUrl: '',
    attributionRequired: false,
    moods: ['neutral'],
    startSec: 0,
    gain: 0.6,
  });
  added.push(file);
}

const missing = catalog.filter((track) => !present.has(track.file)).map((track) => track.file);
const drafts = catalog.filter((track) => track.license === 'BELIRT').map((track) => track.file);

catalog.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

console.log(`Katalog: ${catalog.length} kayıt, ${files.length} mp3 dosyası.`);
if (added.length) console.log(`Eklendi: ${added.join(', ')}`);
if (missing.length) console.warn(`UYARI - dosyası olmayan kayıt: ${missing.join(', ')}`);
if (drafts.length) console.warn(`UYARI - lisansı doldurulmamış (seçicide görünmez): ${drafts.join(', ')}`);
