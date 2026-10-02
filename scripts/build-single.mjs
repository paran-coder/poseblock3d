// css/style.css 와 js/app.js 를 index.html 안에 합쳐 확인용 단일 HTML 파일(dist/poseblock-single.html)을 만드는 스크립트
// 사용법: node scripts/build-single.mjs   (Node.js 18 이상, 별도 패키지 설치 불필요)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const cssTag = '<link rel="stylesheet" href="css/style.css?v=1.3.0">';
const jsTag = '<script src="js/app.js?v=1.3.0"></script>';
let html = read('index.html');
for (const tag of [cssTag, jsTag]) {
  if (!html.includes(tag)) { console.error(`index.html 에서 다음 태그를 찾지 못했습니다. ${tag}`); process.exit(1); }
}
// 치환 문자열에 들어 있는 $ 기호가 특수 패턴으로 해석되지 않도록 함수로 넘깁니다.
html = html.replace(cssTag, () => `<style>\n${read('css/style.css')}</style>`);
html = html.replace(jsTag, () => `<script>\n${read('js/app.js')}</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/poseblock-single.html'), html);
console.log(`dist/poseblock-single.html 생성 완료 (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
