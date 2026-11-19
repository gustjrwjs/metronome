// exe에 넣을 웹 파일만 app-dist/ 로 복사 (src-tauri·node_modules 제외)
import { cpSync, mkdirSync, rmSync } from 'node:fs';
const FILES = ['index.html', 'metronome.js', 'themes.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
rmSync('app-dist', { recursive: true, force: true });
mkdirSync('app-dist');
for (const f of FILES) cpSync(f, `app-dist/${f}`);
console.log('copied', FILES.length, 'files to app-dist/');
