// css/style.css, js/app.js, 정적 에셋 WebP를 index.html 안에 합쳐 단일 HTML 파일을 만듭니다.
// 사용법: node scripts/build-single.mjs   (Node.js 18 이상, 별도 패키지 설치 불필요)
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const cssTag = '<link rel="stylesheet" href="css/style.css?v=1.6.2">';
const jsTag = '<script src="js/app.js?v=1.6.2"></script>';
let html = read('index.html');
for (const tag of [cssTag, jsTag]) {
  if (!html.includes(tag)) { console.error(`index.html 에서 다음 태그를 찾지 못했습니다. ${tag}`); process.exit(1); }
}
const thumbDir = join(root, 'assets/thumbs');
const thumbData = {};
for (const file of readdirSync(thumbDir).filter(f => f.endsWith('.webp')).sort()) {
  const type = basename(file, '.webp');
  const b64 = readFileSync(join(thumbDir, file)).toString('base64');
  thumbData[type] = `data:image/webp;base64,${b64}`;
}
html = html.replace(cssTag, () => `<style>\n${read('css/style.css')}</style>`);
html = html.replace(jsTag, () => `<script>\nwindow.__PB_PROP_THUMBS__=${JSON.stringify(thumbData)};\n${read('js/app.js')}</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/poseblock-single.html'), html);
console.log(`dist/poseblock-single.html 생성 완료 (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB, 정적 썸네일 ${Object.keys(thumbData).length}개 포함)`);
