// PoseBlock 3D 앱 전체 로직 (Three.js 장면, 24관절 캐릭터, 소품, 카메라, 캡처, 저장, 공유)
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r5 = v => Math.round(v * 1e5) / 1e5;
const uid = () => Math.random().toString(36).slice(2, 9);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const finite = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;

const fatal = msg => { const f = $('#fatal'); f.textContent = msg; f.hidden = false; };
if (!window.THREE) { fatal('Three.js를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요.'); return; }
const THREE = window.THREE;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------
// 상수 및 24개 관절 정의
// ------------------------------------------------------------
const D2R = Math.PI / 180;
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180;
const modes = { work: 'orbit', cam: 'look' }; // 뷰마다 기본 드래그 회전 방식
const HEIGHT_BASE = 1.75;
const MAX_CHARS = 5;
const PALETTE = ['#e5484d', '#3e63dd', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e93d82', '#7c6a52'];
const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '2.39:1': 2.39 };
const ELEV = { low: -0.35, eye: 0.03, high: 0.6, bird: 1.4 };
const OUT_LONG_EDGE = 1920;
const K_AUTO = 'poseblock3d:autosave', K_POSES = 'poseblock3d:poses', K_SCENES = 'poseblock3d:scenes';

const DEFS = [];
const defAdd = (name, parent, off, label, mode, r) => DEFS.push({ name, parent, off, label, mode, r });
defAdd('pelvis', null, [0, 0.95, 0], '골반', 'move', 0);
defAdd('spineLow', 'pelvis', [0, 0.10, 0], '하부 척추', 'swing', 0.085);
defAdd('spineMid', 'spineLow', [0, 0.12, 0], '중부 척추', 'swing', 0.095);
defAdd('spineUp', 'spineMid', [0, 0.14, 0], '상부 척추', 'swing', 0.105);
defAdd('neck', 'spineUp', [0, 0.15, 0], '목', 'swing', 0.032);
defAdd('head', 'neck', [0, 0.10, 0], '머리', 'swing', 0.028);
for (const [s, k, lab] of [['L', 1, '왼쪽 '], ['R', -1, '오른쪽 ']]) {
  defAdd('clavicle' + s, 'spineUp', [0.04 * k, 0.08, 0], lab + '쇄골', 'select', 0.03);
  defAdd('shoulder' + s, 'clavicle' + s, [0.14 * k, 0, 0], lab + '어깨', 'swing', 0.034);
  defAdd('elbow' + s, 'shoulder' + s, [0, -0.28, 0], lab + '팔꿈치', 'swing', 0.032);
  defAdd('wrist' + s, 'elbow' + s, [0, -0.25, 0], lab + '손목', 'ik', 0.026);
  defAdd('handTip' + s, 'wrist' + s, [0, -0.09, 0], lab + '손끝', 'swing', 0.02);
  defAdd('hip' + s, 'pelvis', [0.09 * k, -0.04, 0], lab + '엉덩이', 'select', 0.045);
  defAdd('knee' + s, 'hip' + s, [0, -0.42, 0], lab + '무릎', 'swing', 0.048);
  defAdd('ankle' + s, 'knee' + s, [0, -0.40, 0], lab + '발목', 'ik', 0.036);
  defAdd('toe' + s, 'ankle' + s, [0, -0.07, 0.15], lab + '발끝', 'swing', 0.028);
}
const JN = DEFS.map(d => d.name);
const DEF = Object.fromEntries(DEFS.map(d => [d.name, d]));
const IK_CHAIN = {
  wristL: ['shoulderL', 'elbowL', 'wristL', -1], wristR: ['shoulderR', 'elbowR', 'wristR', -1],
  ankleL: ['hipL', 'kneeL', 'ankleL', 1], ankleR: ['hipR', 'kneeR', 'ankleR', 1],
};
const MODE_HINT = {
  swing: '잡고 끌면 부모 관절이 회전해 따라옵니다. 색 링으로 정밀 회전할 수 있습니다.',
  ik: 'IK 관절입니다. 끌면 팔(다리) 전체가 따라옵니다. 색 링으로 회전도 가능합니다.',
  move: '끌면 캐릭터가 이동합니다 (Shift는 위아래). 색 링으로 몸 전체를 회전합니다.',
  select: '색 링으로 회전합니다.',
};

// ------------------------------------------------------------
// 저장소 (localStorage 실패 시 메모리로 대체)
// ------------------------------------------------------------
const store = (() => {
  const mem = {}; let warned = false;
  return {
    get(k) {
      if (k in mem) return mem[k];
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); delete mem[k]; }
      catch (e) {
        mem[k] = v;
        if (!warned) { warned = true; toast('브라우저 저장소를 쓸 수 없어 이번 접속 동안만 저장됩니다. JSON으로 내보내 두세요.', 4800); }
      }
    },
  };
})();

// ------------------------------------------------------------
// Three.js 기본 세팅
// ------------------------------------------------------------
const stage = $('#stage'), canvas = $('#gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (e) { fatal('WebGL을 사용할 수 없는 환경입니다. 다른 브라우저로 열어 주세요.'); return; }
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9ecf0');
scene.add(new THREE.AmbientLight(0xffffff, 0.78));
const sun = new THREE.DirectionalLight(0xffffff, 0.65); sun.position.set(3, 6, 4); scene.add(sun);
const grid = new THREE.GridHelper(24, 48, 0x9aa3ad, 0xc8cfd7); grid.position.y = -0.002; scene.add(grid);

const workCam = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
const outCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 200);

class Rig {
  constructor(az, el_, dist, target) { this.az = az; this.el = el_; this.dist = dist; this.target = target.clone(); }
  apply(cam) {
    const ce = Math.cos(this.el);
    cam.position.set(
      this.target.x + this.dist * ce * Math.sin(this.az),
      this.target.y + this.dist * Math.sin(this.el),
      this.target.z + this.dist * ce * Math.cos(this.az));
    cam.lookAt(this.target);
    cam.updateMatrixWorld(true);
  }
  orbit(dx, dy) { this.az -= dx * 0.0065; this.el = clamp(this.el + dy * 0.0065, -1.45, 1.45); }
  pan(dx, dy, cam, viewH) {
    const k = 2 * this.dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / Math.max(viewH, 1);
    const right = V3().setFromMatrixColumn(cam.matrixWorld, 0), up = V3().setFromMatrixColumn(cam.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  }
  dolly(f) { this.dist = clamp(this.dist * f, 0.6, 40); }
}
const dirVec = (az, el) => V3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)); // 대상에서 카메라로 향하는 단위 벡터
const workRig = new Rig(0.75, 0.32, 4.6, V3(0, 0.95, 0));
const outRig = new Rig(0.45, 0.1, 5.2, V3(0, 0.95, 0));
const out = { fov: 40, aspect: '16:9', roll: 0 };
const aspectVal = () => ASPECTS[out.aspect] || 16 / 9;

function sphereGeo0() { return new THREE.SphereGeometry(1, 12, 8); }
// 출력 카메라 시각화 (작업 뷰에서만 보임)
const camViz = new THREE.Group(); scene.add(camViz);
const frGeo = new THREE.BufferGeometry();
frGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18 * 3), 3));
const frLines = new THREE.LineSegments(frGeo, new THREE.LineBasicMaterial({ color: 0xe8590c }));
frLines.frustumCulled = false;
const camBody = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), new THREE.MeshBasicMaterial({ color: 0xe8590c }));
const camHit = new THREE.Mesh(sphereGeo0(), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
camHit.scale.setScalar(0.15);
const aimBall = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffb347, depthTest: false, transparent: true, opacity: 0.95 }));
aimBall.renderOrder = 5;
const aimHit = new THREE.Mesh(sphereGeo0(), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
aimHit.scale.setScalar(0.14);
camViz.add(frLines, camBody, camHit, aimBall, aimHit);
function updateCamViz() {
  const d = clamp(outRig.dist * 0.16, 0.5, 1.1);
  const hh = d * Math.tan(THREE.MathUtils.degToRad(out.fov / 2)), hw = hh * aspectVal();
  const o = V3().setFromMatrixPosition(outCam.matrixWorld);
  const c = [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].map(([x, y]) => V3(x, y, -d).applyMatrix4(outCam.matrixWorld));
  const cc = V3(0, 0, -d).applyMatrix4(outCam.matrixWorld); // 프레임 중앙 = 조준점
  const pts = [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0], o, cc];
  const arr = frGeo.attributes.position.array;
  pts.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
  frGeo.attributes.position.needsUpdate = true;
  camBody.position.copy(o); camHit.position.copy(o); aimBall.position.copy(cc); aimHit.position.copy(cc);
}

// ------------------------------------------------------------
// 캐릭터
// ------------------------------------------------------------
const sphereGeo = new THREE.SphereGeometry(1, 16, 12);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);
const coneGeo = new THREE.ConeGeometry(1, 1, 10);
const hitMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
let chars = [];
const sel = { c: null, j: null, p: null };
let props = [];
const MAX_PROPS = 30;
const view = { mode: 'work' };
const disp = { grid: true, body: true, joints: true, capGrid: false, ghost: false };
const selChar = () => chars.find(c => c.id === sel.c) || null;

function createCharacter(data) {
  const c = {
    id: data.id || uid(), name: data.name || 'A', color: data.color || PALETTE[0],
    height: clamp(finite(data.height, 175), 100, 220), yaw: finite(data.yaw, 0),
    root: new THREE.Group(), joints: {}, hits: [], flesh: [], balls: [], mats: [], aids: new THREE.Group(),
  };
  const col = new THREE.Color(c.color);
  const boneMat = new THREE.MeshBasicMaterial({ color: col });
  const ballMat = new THREE.MeshBasicMaterial({ color: col });
  const fleshMat = new THREE.MeshLambertMaterial({ color: col, transparent: true, opacity: 0.3, depthWrite: false });
  const headMat = new THREE.MeshLambertMaterial({ color: col });
  const noseMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  c.mats.push(boneMat, ballMat, fleshMat, headMat, noseMat);

  for (const d of DEFS) {
    const o = new THREE.Object3D();
    o.position.set(...d.off); o.userData.joint = d.name;
    (d.parent ? c.joints[d.parent] : c.root).add(o);
    c.joints[d.name] = o;

    const ball = new THREE.Mesh(sphereGeo, ballMat); ball.scale.setScalar(0.03); o.add(ball); c.balls.push(ball);
    if (d.name !== 'head') {
      const hit = new THREE.Mesh(sphereGeo, hitMat); hit.scale.setScalar(0.055);
      hit.userData = { char: c, joint: d.name }; o.add(hit); c.hits.push(hit);
    }
    if (d.parent) {
      const off = V3(...d.off), len = off.length(), dir = off.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), dir);
      const bone = new THREE.Mesh(cylGeo, boneMat);
      bone.position.copy(off).multiplyScalar(0.5); bone.quaternion.copy(q); bone.scale.set(0.011, len, 0.011);
      c.joints[d.parent].add(bone);
      if (d.r > 0) {
        const fl = new THREE.Mesh(cylGeo, fleshMat);
        fl.position.copy(bone.position); fl.quaternion.copy(q); fl.scale.set(d.r, len, d.r);
        fl.userData = { char: c, body: true };
        c.joints[d.parent].add(fl); c.flesh.push(fl);
      }
    }
  }
  // 머리 (얼굴 방향을 알 수 있도록 코 표시)
  const hd = c.joints.head;
  const headBall = new THREE.Mesh(sphereGeo, headMat); headBall.scale.setScalar(0.1); headBall.position.set(0, 0.1, 0); hd.add(headBall);
  const nose = new THREE.Mesh(coneGeo, noseMat); nose.scale.set(0.022, 0.06, 0.022);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.1, 0.105); hd.add(nose);
  const headHit = new THREE.Mesh(sphereGeo, hitMat); headHit.scale.setScalar(0.105); headHit.position.set(0, 0.1, 0);
  headHit.userData = { char: c, joint: 'head' }; hd.add(headHit); c.hits.push(headHit);

  // 바닥 원 (이동용 핸들, 캡처에서는 숨겨짐)
  const ringGeo = new THREE.RingGeometry(0.33, 0.37, 48).rotateX(-Math.PI / 2);
  c.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
  c.disc = new THREE.Mesh(new THREE.CircleGeometry(0.34, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  c.disc.userData = { char: c, base: true };
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 3).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: col }));
  arrow.position.set(0, 0.002, 0.5);
  c.arrowHit = new THREE.Mesh(sphereGeo, hitMat); c.arrowHit.scale.setScalar(0.17); c.arrowHit.position.set(0, 0.02, 0.5);
  c.arrowHit.userData = { char: c, arrow: true };
  c.ring.position.y = c.disc.position.y = 0.002;
  c.aids.add(c.ring, c.disc, arrow, c.arrowHit);
  c.mats.push(c.ring.material, c.disc.material, arrow.material);

  // 이름표
  c.label = el('div', 'lab'); c.label.innerHTML = '<i></i><span></span>';
  c.label.firstChild.style.background = c.color;
  c.label.lastChild.textContent = c.name;
  c.label.addEventListener('pointerdown', e => e.stopPropagation());
  c.label.addEventListener('click', () => selectChar(c));
  $('#labels').append(c.label);

  // 저장된 값 복원
  const p = Array.isArray(data.pos) ? data.pos : [0, 0, 0];
  c.root.position.set(finite(p[0], 0), clamp(finite(p[1], 0), -1.2, 3), finite(p[2], 0));
  if (data.q && typeof data.q === 'object') applyQuats(c, data.q);
  scene.add(c.root, c.aids);
  applyChar(c); applyDisplay(c);
  return c;
}
function applyQuats(c, q) {
  for (const n of JN) {
    const a = q[n];
    if (Array.isArray(a) && a.length === 4 && a.every(v => typeof v === 'number' && isFinite(v))) {
      c.joints[n].quaternion.set(a[0], a[1], a[2], a[3]).normalize();
    }
  }
  c.root.updateMatrixWorld(true);
}
function applyChar(c) {
  c.root.rotation.y = c.yaw;
  c.root.scale.setScalar(c.height / 100 / HEIGHT_BASE);
  c.aids.position.set(c.root.position.x, 0, c.root.position.z);
  c.aids.rotation.y = c.yaw;
  const on = c.id === sel.c;
  c.ring.material.opacity = on ? 1 : 0.45;
  c.disc.material.opacity = on ? 0.2 : 0.1;
  c.root.updateMatrixWorld(true);
  mark();
}
function applyDisplay(c) {
  c.flesh.forEach(m => { m.visible = disp.body; });
  c.balls.forEach(m => { m.visible = disp.joints; });
}
function applyDisplayAll() { grid.visible = disp.grid; chars.forEach(applyDisplay); props.forEach(applyProp); mark(); }
function disposeChar(c) {
  scene.remove(c.root, c.aids); c.mats.forEach(m => m.dispose()); c.label.remove();
}
function serializeChar(c) {
  const q = {}; for (const n of JN) q[n] = c.joints[n].quaternion.toArray().map(r5);
  return { id: c.id, name: c.name, color: c.color, pos: c.root.position.toArray().map(r5), yaw: r5(c.yaw), height: c.height, q };
}
function sanitizeChars(arr) {
  if (!Array.isArray(arr)) return null;
  const list = arr.filter(x => x && typeof x === 'object').slice(0, MAX_CHARS).map((x, i) => ({
    id: typeof x.id === 'string' ? x.id.slice(0, 16) : uid(),
    name: typeof x.name === 'string' ? x.name.slice(0, 12) : String.fromCharCode(65 + i),
    color: /^#[0-9a-fA-F]{6}$/.test(x.color) ? x.color : PALETTE[i % PALETTE.length],
    pos: x.pos, yaw: x.yaw, height: x.height, q: x.q,
  }));
  return list.length ? list : null;
}
function setChars(list) {
  chars.forEach(disposeChar);
  chars = list.map(createCharacter);
  if (!chars.find(c => c.id === sel.c)) { sel.c = chars[0] ? chars[0].id : null; sel.j = null; }
  if (sel.j && !selChar()) sel.j = null;
  chars.forEach(applyChar);
  syncPanel(); mark();
}
function defaultChar(i = 0, used = []) {
  const color = PALETTE.find(p => !used.includes(p)) || PALETTE[i % PALETTE.length];
  const usedNames = chars.map(c => c.name);
  let name = 'A'; for (let k = 0; k < 26; k++) { name = String.fromCharCode(65 + k); if (!usedNames.includes(name)) break; }
  const xs = [0, 0.95, -0.95, 1.9, -1.9];
  const x = xs.find(v => !chars.some(c => Math.abs(c.root.position.x - v) < 0.5)) ?? 0;
  return { name, color, pos: [x, 0, 0], height: 175 };
}

// ------------------------------------------------------------
// 소품 (원점은 바닥 중앙, 앞면은 +Z)
// ------------------------------------------------------------
const PROP_COLORS = ['#b08968', '#8d99ae', '#adb5bd', '#f1f3f5', '#e9c46a', '#2a9d8f', '#e76f51', '#6d597a', '#264653'];
const bxM = (m, w, h, d, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); return o; };
const cyM = (m, r, h, x, y, z, rz = 0) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), m); o.position.set(x, y, z); o.rotation.z = rz; return o; };
const spM = (m, r, x, y, z, sx = 1, sy = 1, sz = 1) => { const o = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); return o; };
const coneM = (m, r, h, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(new THREE.ConeGeometry(r, h, 16), m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); return o; };
const torM = (m, r, tube, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 28), m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); return o; };
const rodM = (m, r, a, b) => {
  const av = V3(a[0], a[1], a[2]), bv = V3(b[0], b[1], b[2]), v = bv.clone().sub(av), h = v.length();
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), m); o.position.copy(av.add(bv).multiplyScalar(0.5));
  if (h > 1e-6) o.quaternion.setFromUnitVectors(V3(0, 1, 0), v.normalize());
  return o;
};
const PROP_TYPES = {
  box: { name: '박스', color: '#adb5bd', build: m => [bxM(m, 0.6, 0.6, 0.6, 0, 0.3, 0)] },
  chair: { name: '의자', color: '#b08968', build: m => {
    const a = [bxM(m, 0.44, 0.05, 0.44, 0, 0.43, 0), bxM(m, 0.44, 0.42, 0.04, 0, 0.665, -0.2)];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) a.push(bxM(m, 0.04, 0.405, 0.04, sx * 0.19, 0.2025, sz * 0.19));
    return a; } },
  table: { name: '테이블', color: '#b08968', build: m => {
    const a = [bxM(m, 1.2, 0.05, 0.7, 0, 0.725, 0)];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) a.push(bxM(m, 0.06, 0.7, 0.06, sx * 0.55, 0.35, sz * 0.3));
    return a; } },
  sofa: { name: '소파', color: '#8d99ae', build: m => [bxM(m, 1.8, 0.38, 0.85, 0, 0.19, 0), bxM(m, 1.4, 0.12, 0.7, 0, 0.44, 0.05),
    bxM(m, 1.8, 0.45, 0.2, 0, 0.6, -0.325), bxM(m, 0.2, 0.3, 0.85, -0.8, 0.53, 0), bxM(m, 0.2, 0.3, 0.85, 0.8, 0.53, 0)] },
  bed: { name: '침대', color: '#e9c46a', build: m => [bxM(m, 1.4, 0.28, 2.0, 0, 0.14, 0), bxM(m, 1.3, 0.18, 1.9, 0, 0.37, 0), bxM(m, 0.5, 0.1, 0.3, 0, 0.51, -0.75)] },
  stairs: { name: '계단', color: '#adb5bd', build: m => { const a = []; for (let i = 0; i < 5; i++) { const h = 0.18 * (i + 1); a.push(bxM(m, 1.0, h, 0.28, 0, h / 2, 0.42 - i * 0.28)); } return a; } },
  wall: { name: '벽', color: '#f1f3f5', build: m => [bxM(m, 3, 2.5, 0.12, 0, 1.25, 0)] },
  pillar: { name: '기둥', color: '#adb5bd', build: m => [cyM(m, 0.15, 2.5, 0, 1.25, 0)] },
  ball: { name: '공', color: '#e76f51', build: m => { const o = new THREE.Mesh(new THREE.SphereGeometry(0.25, 24, 16), m); o.position.y = 0.25; return [o]; } },
  car: { name: '자동차', color: '#e76f51', build: (m, d) => {
    const a = [bxM(m, 1.8, 0.5, 4.2, 0, 0.55, 0), bxM(m, 1.55, 0.5, 2.0, 0, 1.05, -0.2)];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) a.push(cyM(d, 0.33, 0.22, sx * 0.9, 0.33, sz * 1.3, Math.PI / 2));
    return a; } },
  dog: { name: '개', color: '#b08968', build: (m, d) => {
    // 튼튼한 직사각 몸통 + 긴 주둥이 + 아래로 처지는 귀/꼬리로 고양이와 실루엣 분리
    const a = [bxM(m, 0.68, 0.48, 1.2, 0, 0.58, 0), spM(m, 0.31, 0, 0.82, 0.67, 1.05, 0.9, 1), bxM(m, 0.32, 0.22, 0.42, 0, 0.76, 0.98), spM(d, 0.055, 0, 0.79, 1.22, 1.1, 0.8, 1)];
    for (const x of [-0.25, 0.25]) for (const z of [-0.38, 0.38]) a.push(rodM(m, 0.065, [x, 0.48, z], [x, 0.08, z]));
    const le = bxM(m, 0.12, 0.3, 0.08, -0.25, 0.82, 0.64), re = bxM(m, 0.12, 0.3, 0.08, 0.25, 0.82, 0.64); le.rotation.z = 0.22; re.rotation.z = -0.22; a.push(le, re);
    a.push(rodM(m, 0.06, [0, 0.68, -0.58], [0.05, 0.5, -0.95]), rodM(m, 0.05, [0.05, 0.5, -0.95], [0.08, 0.34, -1.1])); return a; } },
  cat: { name: '고양이', color: '#8d99ae', build: (m, d) => {
    // 낮고 가는 몸 + 둥근 얼굴 + 큰 삼각 귀 + 위로 치켜든 긴 꼬리
    const a = [spM(m, 0.34, 0, 0.46, -0.05, 0.9, 0.62, 1.55), spM(m, 0.27, 0, 0.69, 0.48, 1, 1, 0.95), spM(d, 0.04, 0, 0.66, 0.73)];
    for (const x of [-0.19, 0.19]) for (const z of [-0.25, 0.25]) a.push(rodM(m, 0.04, [x, 0.38, z], [x, 0.055, z]));
    a.push(coneM(m, 0.12, 0.28, -0.14, 0.99, 0.45, 0, 0, -0.05), coneM(m, 0.12, 0.28, 0.14, 0.99, 0.45, 0, 0, 0.05));
    a.push(rodM(m, 0.038, [0, 0.5, -0.5], [0.2, 0.78, -0.77]), rodM(m, 0.035, [0.2, 0.78, -0.77], [0.12, 1.13, -0.82]), rodM(m, 0.03, [0.12, 1.13, -0.82], [-0.03, 1.3, -0.72])); return a; } },
  horse: { name: '말', color: '#b08968', build: (m, d) => {
    const a = [spM(m, 0.48, 0, 0.95, 0, 1.05, 0.78, 1.65), rodM(m, 0.2, [0, 1.05, 0.55], [0, 1.55, 0.85]), spM(m, 0.3, 0, 1.62, 1.02, 0.9, 0.85, 1.2)];
    for (const x of [-0.32, 0.32]) for (const z of [-0.48, 0.48]) { a.push(rodM(m, 0.065, [x, 0.72, z], [x, 0.12, z])); a.push(bxM(d, 0.16, 0.09, 0.24, x, 0.045, z + 0.04)); }
    a.push(coneM(m, 0.08, 0.2, -0.15, 1.92, 1.0, 0, 0, -0.1), coneM(m, 0.08, 0.2, 0.15, 1.92, 1.0, 0, 0, 0.1));
    a.push(rodM(d, 0.05, [0, 1.0, -0.72], [0, 0.55, -1.15])); return a; } },
  bird: { name: '새', color: '#e9c46a', build: (m, d) => {
    const a = [spM(m, 0.28, 0, 0.38, 0, 1, 0.8, 1.35), spM(m, 0.19, 0, 0.58, 0.36), coneM(d, 0.08, 0.28, 0, 0.56, 0.63, Math.PI / 2)];
    const wl = bxM(m, 0.55, 0.05, 0.3, -0.31, 0.42, -0.02); wl.rotation.z = 0.24; const wr = bxM(m, 0.55, 0.05, 0.3, 0.31, 0.42, -0.02); wr.rotation.z = -0.24; a.push(wl, wr);
    a.push(rodM(d, 0.025, [-0.09, 0.2, 0.08], [-0.11, 0.02, 0.13]), rodM(d, 0.025, [0.09, 0.2, 0.08], [0.11, 0.02, 0.13])); return a; } },
  tiger: { name: '호랑이', color: '#e9a23b', build: (m, d) => {
    const a = [spM(m, 0.5, 0, 0.72, 0, 1.05, 0.72, 1.65), spM(m, 0.34, 0, 0.88, 0.82, 1.05, 0.95, 1), bxM(m, 0.34, 0.2, 0.32, 0, 0.81, 1.08)];
    for (const x of [-0.3, 0.3]) for (const z of [-0.42, 0.42]) a.push(rodM(m, 0.065, [x, 0.58, z], [x, 0.08, z]));
    a.push(coneM(m, 0.1, 0.22, -0.18, 1.17, 0.8, 0, 0, -0.08), coneM(m, 0.1, 0.22, 0.18, 1.17, 0.8, 0, 0, 0.08));
    for (const z of [-0.52,-0.18,0.18,0.52]) a.push(bxM(d, 0.9, 0.055, 0.09, 0, 1.01, z));
    a.push(rodM(m, 0.055, [0, 0.76, -0.7], [0.18, 0.82, -1.08]), rodM(m, 0.05, [0.18, 0.82, -1.08], [-0.04, 0.7, -1.42])); return a; } },
  dragon: { name: '용', color: '#2a9d8f', build: (m, d) => {
    // 동양식: 길고 굽이치는 몸통, 큰 머리, 뿔, 수염, 네 다리. 날개는 사용하지 않음.
    const pts = [[0,0.42,-1.65],[-0.2,0.58,-1.22],[0.16,0.72,-0.78],[-0.12,0.88,-0.28],[0.18,1.0,0.2],[-0.06,1.08,0.7],[0,1.12,1.16]];
    const a = [];
    for (let i=0;i<pts.length-1;i++) a.push(rodM(m, 0.14 - i*0.007, pts[i], pts[i+1]));
    for (let i=1;i<pts.length-1;i++) a.push(spM(m, 0.145 - i*0.006, ...pts[i]));
    a.push(spM(m, 0.28, 0, 1.2, 1.42, 1.05, 0.82, 1.05), bxM(m, 0.34, 0.2, 0.42, 0, 1.12, 1.72));
    a.push(coneM(d, 0.055, 0.42, -0.16, 1.5, 1.34, -0.32, 0, -0.16), coneM(d, 0.055, 0.42, 0.16, 1.5, 1.34, -0.32, 0, 0.16));
    a.push(rodM(d, 0.018, [-0.18,1.15,1.72],[-0.72,1.0,1.9]), rodM(d, 0.018, [0.18,1.15,1.72],[0.72,1.0,1.9]));
    for (const [x,z] of [[-0.14,-0.62],[0.14,-0.05],[-0.14,0.42],[0.14,0.86]]) {
      const sx = x < 0 ? -1 : 1; a.push(rodM(m, 0.045, [x,0.84 + (z+0.6)*0.18,z], [sx*0.42,0.48,z+0.04]), rodM(m, 0.035, [sx*0.42,0.48,z+0.04], [sx*0.55,0.28,z+0.18]));
    }
    a.push(coneM(m,0.08,0.34,0,0.52,-1.82,-Math.PI/2)); return a; } },
  turtle: { name: '거북이', color: '#6a994e', build: (m, d) => {
    const a = [spM(m, 0.55, 0, 0.34, 0, 1.2, 0.48, 1.45), spM(d, 0.44, 0, 0.36, 0, 1.2, 0.32, 1.45), spM(m, 0.2, 0, 0.3, 0.75, 1.1, 0.9, 1)];
    for (const [x,z,rz] of [[-0.48,0.35,0.55],[0.48,0.35,-0.55],[-0.48,-0.35,-0.55],[0.48,-0.35,0.55]]) { const leg=bxM(m,0.34,0.09,0.22,x,0.13,z); leg.rotation.y=rz; a.push(leg); }
    a.push(coneM(m,0.08,0.24,0,0.25,-0.78,-Math.PI/2)); return a; } },
  snake: { name: '구렁이', color: '#718355', build: (m, d) => {
    // 바닥을 따라 S자로 이어지는 굵은 몸통과 넓은 머리. 용과 달리 다리/뿔 없이 낮게 배치한다.
    const pts = [[-0.9,0.16,-0.72],[-0.48,0.18,-0.92],[0.02,0.2,-0.78],[0.42,0.22,-0.42],[0.22,0.24,0.02],[-0.2,0.25,0.26],[-0.45,0.27,0.62],[-0.18,0.3,0.92],[0.18,0.32,1.12]];
    const a = [];
    for (let i=0;i<pts.length-1;i++) a.push(rodM(m, Math.max(0.055, 0.12 - i*0.007), pts[i], pts[i+1]));
    for (let i=1;i<pts.length-1;i++) a.push(spM(m, Math.max(0.06, 0.125 - i*0.007), ...pts[i], 1.15, 0.9, 1.15));
    a.push(spM(m, 0.17, 0.18, 0.34, 1.28, 1.25, 0.82, 1.05), spM(d, 0.025, 0.13, 0.39, 1.42), spM(d, 0.025, 0.23, 0.39, 1.42));
    return a; } },
  bicycle: { name: '자전거', color: '#2a9d8f', build: (m, d) => {
    const a = [torM(d, 0.42, 0.045, 0, 0.47, -0.75, 0, Math.PI / 2), torM(d, 0.42, 0.045, 0, 0.47, 0.75, 0, Math.PI / 2)];
    const rear=[0,0.47,-0.75], front=[0,0.47,0.75], crank=[0,0.5,-0.05], seat=[0,0.92,-0.28], bar=[0,1.0,0.6];
    a.push(rodM(m,0.035,rear,crank),rodM(m,0.035,crank,front),rodM(m,0.035,rear,seat),rodM(m,0.035,seat,crank),rodM(m,0.035,seat,front),rodM(m,0.035,front,bar));
    a.push(bxM(d,0.34,0.06,0.18,0,0.98,-0.31), bxM(m,0.65,0.035,0.035,0,1.0,0.6)); return a; } },
  motorcycle: { name: '오토바이', color: '#e76f51', build: (m, d) => {
    const a = [torM(d, 0.42, 0.08, 0, 0.5, -0.9, 0, Math.PI / 2), torM(d, 0.42, 0.08, 0, 0.5, 0.9, 0, Math.PI / 2), bxM(m, 0.48, 0.42, 1.0, 0, 0.68, 0.05), bxM(d, 0.48, 0.12, 0.6, 0, 0.96, -0.25)];
    a.push(rodM(m,0.055,[0,0.55,-0.7],[0,0.8,0]),rodM(m,0.055,[0,0.5,0.9],[0,1.08,0.58]),bxM(m,0.7,0.04,0.04,0,1.08,0.58)); return a; } },
  bus: { name: '버스', color: '#e9c46a', build: (m, d) => {
    // 하나로 이어진 긴 승객실, 반복 창문, 앞유리/출입문으로 버스 실루엣 강조
    const a = [bxM(m, 1.9, 1.65, 5.2, 0, 1.08, 0), bxM(d, 1.55, 0.58, 0.06, 0, 1.48, 2.63), bxM(d, 0.06, 0.92, 0.62, 0.965, 1.22, 1.72)];
    for (const sx of [-1, 1]) for (const z of [-1.65, 1.65]) a.push(cyM(d, 0.35, 0.24, sx * 0.97, 0.35, z, Math.PI / 2));
    for (const sx of [-1, 1]) for (const z of [-1.72,-0.82,0.08,0.98]) a.push(bxM(d, 0.045, 0.52, 0.66, sx * 0.968, 1.48, z));
    return a; } },
  truck: { name: '트럭', color: '#8d99ae', build: (m, d) => {
    // 앞쪽 운전석과 뒤쪽 열린 적재함을 분리한 픽업/화물 트럭형 실루엣
    const a = [bxM(m, 1.85, 1.35, 1.55, 0, 0.98, 1.25), bxM(m, 1.95, 0.22, 2.45, 0, 0.58, -0.72), bxM(m, 0.13, 0.72, 2.45, -0.91, 0.89, -0.72), bxM(m, 0.13, 0.72, 2.45, 0.91, 0.89, -0.72), bxM(m, 1.95, 0.72, 0.13, 0, 0.89, -1.9), bxM(d, 1.42, 0.42, 0.055, 0, 1.2, 2.04)];
    for (const sx of [-1, 1]) for (const z of [-1.28, 1.28]) a.push(cyM(d, 0.37, 0.25, sx * 0.98, 0.37, z, Math.PI / 2));
    return a; } },
  boat: { name: '보트', color: '#2a9d8f', build: (m, d) => {
    const hull = bxM(m, 1.25, 0.38, 2.5, 0, 0.19, -0.2), bow = coneM(m, 0.72, 1.25, 0, 0.33, 1.55, Math.PI / 2); bow.scale.set(0.9, 0.45, 1);
    const a = [hull, bow, bxM(m, 0.95, 0.5, 0.95, 0, 0.63, -0.35), bxM(d, 0.72, 0.24, 0.05, 0, 0.69, 0.13)]; return a; } },
  airplane: { name: '비행기', color: '#adb5bd', build: (m, d) => {
    const a = [rodM(m, 0.22, [0,0.62,-1.45], [0,0.62,1.35]), coneM(m, 0.24, 0.65, 0, 0.62, 1.67, Math.PI / 2), bxM(m, 3.0, 0.08, 0.62, 0, 0.58, -0.05), bxM(m, 1.35, 0.06, 0.4, 0, 0.68, -1.22), bxM(m, 0.08, 0.72, 0.45, 0, 0.94, -1.25), bxM(d, 0.34, 0.18, 0.05, 0, 0.79, 1.31)]; return a; } },
};
const PROP_CATEGORIES = {
  basic: ['box','chair','table','sofa','bed','stairs','wall','pillar','ball'],
  animal: ['dog','cat','horse','bird','tiger','dragon','turtle','snake'],
  vehicle: ['car','bicycle','motorcycle','bus','truck','boat','airplane'],
};
let propCategory = 'basic';
const propSc = v => Array.isArray(v) && v.length === 3 ? v.map(x => clamp(finite(x, 1), 0.2, 4)) : [1, 1, 1];
function createProp(data) {
  const T = PROP_TYPES[data.type]; if (!T) return null;
  const same = props.filter(q => q.type === data.type).length + 1;
  const p = { id: data.id || uid(), type: data.type, name: typeof data.name === 'string' && data.name ? data.name.slice(0, 14) : `${T.name} ${same}`,
    color: /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : T.color, yaw: finite(data.yaw, 0), sc: propSc(data.sc), root: new THREE.Group(), meshes: [], mats: [] };
  p.mat = new THREE.MeshLambertMaterial({ color: p.color }); p.dark = new THREE.MeshLambertMaterial({ color: 0x343a40 }); p.mats.push(p.mat, p.dark);
  T.build(p.mat, p.dark).forEach(o => { o.userData.prop = p; p.root.add(o); p.meshes.push(o); });
  p.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(p.root), size = box.getSize(V3()), ctr = box.getCenter(V3());
  p.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)), new THREE.LineBasicMaterial({ color: 0x3e63dd, depthTest: false, transparent: true }));
  p.outline.position.copy(ctr); p.outline.renderOrder = 998; p.outline.visible = false; p.root.add(p.outline); p.mats.push(p.outline.material);
  const q = Array.isArray(data.pos) ? data.pos : [0, 0, 0];
  p.root.position.set(finite(q[0], 0), clamp(finite(q[1], 0), 0, 4), finite(q[2], 0));
  scene.add(p.root); applyProp(p);
  return p;
}
function applyProp(p) {
  p.root.rotation.y = p.yaw; p.root.scale.set(...p.sc);
  p.mats.forEach(m => { if (m.isLineBasicMaterial) return; m.transparent = disp.ghost; m.opacity = disp.ghost ? 0.35 : 1; m.depthWrite = !disp.ghost; m.needsUpdate = true; });
  p.mat.color.set(p.color); p.root.updateMatrixWorld(true); mark();
}
function disposeProp(p) {
  scene.remove(p.root); p.root.traverse(o => { if (o.geometry) o.geometry.dispose(); }); p.mats.forEach(m => m.dispose());
}
const serializeProp = p => ({ id: p.id, type: p.type, name: p.name, color: p.color, pos: p.root.position.toArray().map(r5), yaw: r5(p.yaw), sc: p.sc.map(r5) });
function sanitizeProps(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => x && typeof x === 'object' && PROP_TYPES[x.type]).slice(0, MAX_PROPS).map(x => ({
    id: typeof x.id === 'string' ? x.id.slice(0, 16) : uid(), type: x.type, name: x.name, color: x.color, pos: x.pos, yaw: x.yaw, sc: x.sc }));
}
function setProps(list) {
  props.forEach(disposeProp); props = [];
  list.forEach(d => { const p = createProp(d); if (p) props.push(p); });
  if (sel.p && !props.find(p => p.id === sel.p)) sel.p = null;
  syncProps(); mark();
}
const selProp = () => props.find(p => p.id === sel.p) || null;
function addProp(type) {
  if (props.length >= MAX_PROPS) { toast(`에셋은 최대 ${MAX_PROPS}개까지 놓을 수 있습니다.`); return; }
  const c = selChar(), bx = c ? c.root.position.x : 0, bz = c ? c.root.position.z : 0;
  const dx = [1.2, -1.2, 2.4, -2.4, 3.6, -3.6].find(d => !props.some(q => Math.hypot(q.root.position.x - (bx + d), q.root.position.z - bz) < 0.9)) ?? 1.2;
  const p = createProp({ type, pos: [bx + dx, 0, bz] }); props.push(p); selectProp(p); commit();
}
function selectProp(p) { sel.p = p ? p.id : null; sel.j = null; if (p) openLeftTab('props'); syncPanel(); mark(); }
function openLeftTab(t) { const b = document.querySelector(`#leftTabs button[data-t="${t}"]`); if (b && !b.classList.contains('on')) b.click(); }

// ------------------------------------------------------------
// 히스토리 (되돌리기 / 다시 실행) · 자동 저장
// ------------------------------------------------------------
const hist = { stack: [], i: -1 };
const snap = () => JSON.stringify({ c: chars.map(serializeChar), p: props.map(serializeProp) });
function restoreSnap(str) { const o = JSON.parse(str); setChars(sanitizeChars(o.c)); setProps(sanitizeProps(o.p)); }
function commit() {
  const s = snap();
  if (hist.stack[hist.i] === s) { autosaveSoon(); return; }
  hist.stack.length = hist.i + 1; hist.stack.push(s);
  if (hist.stack.length > 120) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  updateUndoBtns(); autosaveSoon();
}
function undo() { if (hist.i > 0) { hist.i--; restoreSnap(hist.stack[hist.i]); updateUndoBtns(); autosaveSoon(); } }
function redo() { if (hist.i < hist.stack.length - 1) { hist.i++; restoreSnap(hist.stack[hist.i]); updateUndoBtns(); autosaveSoon(); } }
function updateUndoBtns() { $('#undo').disabled = hist.i <= 0; $('#redo').disabled = hist.i >= hist.stack.length - 1; }
function getFull() {
  return { v: 1, chars: chars.map(serializeChar), props: props.map(serializeProp), cam: { az: r5(outRig.az), el: r5(outRig.el), dist: r5(outRig.dist), target: outRig.target.toArray().map(r5), fov: out.fov, aspect: out.aspect, roll: r5(out.roll) } };
}
function setCam(cam) {
  if (!cam || typeof cam !== 'object') return;
  outRig.az = finite(cam.az, outRig.az); outRig.el = clamp(finite(cam.el, outRig.el), -1.45, 1.45);
  outRig.dist = clamp(finite(cam.dist, outRig.dist), 0.6, 40);
  if (Array.isArray(cam.target) && cam.target.length === 3 && cam.target.every(v => typeof v === 'number' && isFinite(v))) outRig.target.set(...cam.target);
  out.fov = clamp(finite(cam.fov, out.fov), 15, 100);
  if (ASPECTS[cam.aspect]) out.aspect = cam.aspect;
  out.roll = clamp(finite(cam.roll, 0), -0.8, 0.8);
  syncPanel(); mark();
}
function setFull(f) {
  const list = sanitizeChars(f && f.chars); if (!list) return false;
  setChars(list); setProps(sanitizeProps(f.props)); setCam(f.cam); commit(); return true;
}
let autoT = 0;
function autosaveSoon() { clearTimeout(autoT); autoT = setTimeout(() => store.set(K_AUTO, getFull()), 350); }

// ------------------------------------------------------------
// 선택 · 기즈모 (회전 링 3개)
// ------------------------------------------------------------
const gizmo = new THREE.Group(); gizmo.visible = false; scene.add(gizmo);
const ringHits = [], ringVis = [];
const RING_COL = [0xff4d4f, 0x34c759, 0x4d8dff];
const ringGeoVis = new THREE.TorusGeometry(1, 0.016, 8, 80), ringGeoHit = new THREE.TorusGeometry(1, 0.1, 8, 48);
[0, 1, 2].forEach(i => {
  const holder = new THREE.Group();
  if (i === 0) holder.rotation.y = Math.PI / 2;
  if (i === 1) holder.rotation.x = Math.PI / 2;
  const vis = new THREE.Mesh(ringGeoVis, new THREE.MeshBasicMaterial({ color: RING_COL[i], depthTest: false, transparent: true, opacity: 0.92 }));
  vis.renderOrder = 999;
  const hit = new THREE.Mesh(ringGeoHit, hitMat); hit.userData = { ring: i };
  holder.add(vis, hit); gizmo.add(holder); ringHits.push(hit); ringVis.push(vis);
});
const marker = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0xffd60a, depthTest: false, transparent: true, opacity: 0.95 }));
marker.scale.setScalar(0.1); marker.renderOrder = 1000; gizmo.add(marker);

const tmpP = V3(), tmpQ = new THREE.Quaternion();
function updateGizmo() {
  const c = selChar();
  if (!c || !sel.j) { gizmo.visible = false; return; }
  c.joints[sel.j].getWorldPosition(tmpP); c.root.getWorldQuaternion(tmpQ);
  gizmo.position.copy(tmpP); gizmo.quaternion.copy(tmpQ);
  const cam = activeCam(), dist = cam.position.distanceTo(tmpP);
  gizmo.scale.setScalar(Math.max(dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * 0.17, 0.05));
  gizmo.visible = true; gizmo.updateMatrixWorld(true);
}
function selectChar(c) { sel.c = c ? c.id : null; sel.j = null; sel.p = null; chars.forEach(applyChar); syncPanel(); mark(); }
function selectJoint(c, name) { sel.c = c.id; sel.j = name; sel.p = null; chars.forEach(applyChar); syncPanel(); mark(); }

// ------------------------------------------------------------
// 캐릭터 방향 (발 방향 · 상체 방향 · 마주보기)
// ------------------------------------------------------------
const wrapRad = a => Math.atan2(Math.sin(a), Math.cos(a));
function faceYawOf(joint) { // 관절이 바라보는 월드 방향 (z축 기준 yaw)
  const v = V3(0, 0, 1).applyQuaternion(joint.getWorldQuaternion(new THREE.Quaternion()));
  return Math.atan2(v.x, v.z);
}
function feetYaw(c) { // 발끝이 향하는 방향. 바닥 화살표가 이 방향을 가리킵니다.
  c.root.updateMatrixWorld(true);
  const a = V3(), b = V3(), f = V3();
  for (const sd of ['L', 'R']) { c.joints['ankle' + sd].getWorldPosition(a); c.joints['toe' + sd].getWorldPosition(b); b.sub(a); b.y = 0; f.add(b); }
  return f.lengthSq() > 1e-6 ? Math.atan2(f.x, f.z) : faceYawOf(c.joints.pelvis);
}
function chestYaw(c) { c.root.updateMatrixWorld(true); return faceYawOf(c.joints.spineUp); }
// 하체(두 다리)를 상체가 바라보는 방향으로 돌립니다. 상체와 팔은 그대로입니다.
function alignLegs(c) {
  const d = wrapRad(chestYaw(c) - feetYaw(c)); if (Math.abs(d) < 1e-4) return false;
  const q = new THREE.Quaternion().setFromAxisAngle(V3(0, 1, 0), d);
  rotateJointWorld(c.joints.hipL, q); rotateJointWorld(c.joints.hipR, q);
  mark(); return true;
}
// 캐릭터 전체를 돌려 상체가 대상 쪽을 보게 하고, 하체도 같은 방향으로 맞춥니다.
function faceTowards(c, tx, tz, withLegs = true) {
  const want = Math.atan2(tx - c.root.position.x, tz - c.root.position.z);
  c.yaw = wrapRad(c.yaw + wrapRad(want - chestYaw(c))); applyChar(c);
  if (withLegs) alignLegs(c);
}

// ------------------------------------------------------------
// 관절 수학 (월드 회전, 2본 IK)
// ------------------------------------------------------------
const qFromTo = (u, v) => {
  if (u.lengthSq() < 1e-12 || v.lengthSq() < 1e-12) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(u.clone().normalize(), v.clone().normalize());
};
function rotateJointWorld(j, qd) {
  const pq = new THREE.Quaternion(), wq = new THREE.Quaternion();
  j.parent.updateWorldMatrix(true, false);
  j.parent.getWorldQuaternion(pq); j.getWorldQuaternion(wq);
  wq.premultiply(qd);
  j.quaternion.copy(pq.invert().multiply(wq)).normalize();
  j.updateMatrixWorld(true);
}
function solveTwoBone(A, B, C, target, defPole) {
  const a = V3(), b = V3(), c = V3();
  A.getWorldPosition(a); B.getWorldPosition(b); C.getWorldPosition(c);
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const at = target.clone().sub(a);
  const d = clamp(at.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const dir = at.normalize();
  const pole = b.clone().sub(a); pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-6) { pole.copy(defPole); pole.addScaledVector(dir, -pole.dot(dir)); }
  if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
  pole.normalize();
  const x = (d * d + l1 * l1 - l2 * l2) / (2 * d), h = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
  const b2 = a.clone().addScaledVector(dir, x).addScaledVector(pole, h);
  const c2 = a.clone().addScaledVector(dir, d);
  rotateJointWorld(A, qFromTo(b.clone().sub(a), b2.clone().sub(a)));
  const bb = V3(), cc = V3();
  B.getWorldPosition(bb); C.getWorldPosition(cc);
  rotateJointWorld(B, qFromTo(cc.sub(bb), c2.clone().sub(bb)));
}

// ------------------------------------------------------------
// 뷰 / 렌더링
// ------------------------------------------------------------
const labelsBox = $('#labels'), frameEl = $('#frame'), pipEl = $('#pip');
let dirty = true;
let pivotUntil = 0;
function mark() { dirty = true; }
const activeCam = () => view.mode === 'work' ? workCam : outCam;
const activeRig = () => view.mode === 'work' ? workRig : outRig;
function stageSize() { return { W: Math.max(stage.clientWidth, 1), H: Math.max(stage.clientHeight, 1) }; }
function viewRect() {
  const { W, H } = stageSize();
  if (view.mode === 'work') return { x: 0, y: 0, w: W, h: H };
  const a = aspectVal(), m = 40;
  let w = Math.max(W - 2 * m, 40), h = Math.max(H - 2 * m, 40);
  if (w / h > a) w = h * a; else h = w / a;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
function syncCams() {
  const { W, H } = stageSize();
  workCam.aspect = W / H; workCam.updateProjectionMatrix(); workRig.apply(workCam);
  outCam.aspect = aspectVal(); outCam.fov = out.fov; outCam.updateProjectionMatrix(); outRig.apply(outCam);
  if (out.roll) { outCam.rotateZ(-out.roll); outCam.updateMatrixWorld(true); }
}
function toScreen(v) {
  const p = v.clone().project(activeCam()), r = viewRect();
  return { x: r.x + (p.x + 1) / 2 * r.w, y: r.y + (1 - p.y) / 2 * r.h, z: p.z };
}
function render() {
  const { W, H } = stageSize();
  syncCams(); updateCamViz(); updateGizmo();
  chars.forEach(c => { c.aids.rotation.y = feetYaw(c); });
  props.forEach(p => { p.outline.visible = p.id === sel.p; });
  camViz.visible = view.mode === 'work';
  const rect = viewRect();
  if (view.mode === 'work') {
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H);
    renderer.render(scene, workCam);
    // 출력 카메라 미리보기 (PiP)
    const pw = Math.round(Math.min(250, W * 0.34)), ph = Math.round(pw / aspectVal());
    pipEl.style.width = pw + 'px'; pipEl.style.height = ph + 'px'; pipEl.style.display = 'block';
    withClean({ grid: true }, () => {
      renderer.setScissorTest(true); renderer.setViewport(12, 12, pw, ph); renderer.setScissor(12, 12, pw, ph);
      renderer.render(scene, outCam); renderer.setScissorTest(false);
    });
    frameEl.style.display = 'none';
  } else {
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H);
    renderer.setClearColor(0x14171c, 1); renderer.clear();
    const vx = Math.round(rect.x), vy = Math.round(H - rect.y - rect.h), vw = Math.round(rect.w), vh = Math.round(rect.h);
    renderer.setScissorTest(true); renderer.setViewport(vx, vy, vw, vh); renderer.setScissor(vx, vy, vw, vh);
    renderer.render(scene, outCam); renderer.setScissorTest(false);
    pipEl.style.display = 'none';
    Object.assign(frameEl.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
    const { w, h } = outSize();
    $('#frameTag').textContent = `${out.aspect} · ${w}×${h}px · 화각 ${out.fov}°`;
  }
  // 이름표 위치
  for (const c of chars) {
    const p = V3(c.root.position.x, c.root.position.y + c.height / 100 * 1.08 + 0.1, c.root.position.z);
    const s = toScreen(p), vis = s.z < 1;
    c.label.style.display = vis ? 'block' : 'none';
    c.label.style.left = s.x + 'px'; c.label.style.top = s.y + 'px';
    c.label.classList.toggle('sel', c.id === sel.c);
  }
  const pv = $('#pivot'), on = performance.now() < pivotUntil;
  if (on) { const ps = toScreen(pivotPoint()); pv.style.left = ps.x + 'px'; pv.style.top = ps.y + 'px'; }
  pv.classList.toggle('on', on && toScreen(pivotPoint()).z < 1);
  updateCamSliders();
}
(function loop() { requestAnimationFrame(loop); if (dirty) { dirty = false; render(); } })();
new ResizeObserver(() => {
  const { W, H } = stageSize(); renderer.setSize(W, H, false); mark();
}).observe(stage);

// 에디터 보조물을 숨기고 실행 (캡처, 미리보기, 썸네일 공용)
function withClean(opts, fn) {
  const saved = [], hide = (o, v) => { saved.push([o, o.visible]); o.visible = v; };
  hide(gizmo, false); hide(camViz, false); hide(grid, opts.grid === 'on' ? true : opts.grid === true ? disp.grid : false);
  const alone = opts.only || opts.solo;
  chars.forEach(c => { hide(c.aids, false); if ((opts.only && c !== opts.only) || opts.solo) hide(c.root, false); });
  props.forEach(p => { hide(p.outline, false); if (alone) hide(p.root, false); });
  try { return fn(); } finally { saved.reverse().forEach(([o, v]) => { o.visible = v; }); }
}

function updateHud() {
  const hud = $('#hud'); hud.innerHTML = '';
  const m = modes[view.mode] === 'look' ? '제자리 회전' : '대상 중심 회전';
  const tips = view.mode === 'work'
    ? ['작업 뷰', '관절·링 드래그로 포즈 편집', `빈 곳 드래그 = ${m}`, 'Space + 좌클릭 드래그 이동 · 휠 확대', '주황 카메라 이동 · 앞의 작은 구로 방향 조절']
    : ['카메라 뷰 (출력 구도)', `드래그 = ${m} (Alt 반대)`, 'Space + 좌클릭 드래그 이동 · 휠 앞뒤 · 방향키 회전'];
  tips.forEach(t => { const sp = el('span'); sp.textContent = t; hud.append(sp); });
  $('#modeBar').querySelectorAll('button').forEach(bn => bn.classList.toggle('on', bn.dataset.t === modes[view.mode]));
}
function setView(v) {
  view.mode = v;
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  updateHud(); mark();
}

// ------------------------------------------------------------
// 포인터 인터랙션
// ------------------------------------------------------------
const raycaster = new THREE.Raycaster();
let drag = null, lastX = 0, lastY = 0, hoverT = 0, spacePan = false;
const posOf = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const blocksSpacePan = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName));
function setRay(p) {
  syncCams();
  const r = viewRect();
  raycaster.setFromCamera(new THREE.Vector2(((p.x - r.x) / r.w) * 2 - 1, -((p.y - r.y) / r.h) * 2 + 1), activeCam());
}
const rayPlane = pl => { const t = V3(); return raycaster.ray.intersectPlane(pl, t) ? t : null; };
function pick() {
  gizmo.updateMatrixWorld(true);
  if (gizmo.visible) {
    const h = raycaster.intersectObjects(ringHits, false)[0];
    if (h) return { kind: 'ring', i: h.object.userData.ring, point: h.point.clone() };
  }
  const wk = view.mode === 'work';
  const ch = wk ? raycaster.intersectObject(camHit, false)[0] : null;
  const ah = wk ? raycaster.intersectObject(aimHit, false)[0] : null;
  const hits = []; chars.forEach(c => hits.push(...c.hits));
  const h = raycaster.intersectObjects(hits, false)[0];
  const best = [ch && { d: ch.distance, k: 'cam' }, ah && { d: ah.distance, k: 'aim' }, h && { d: h.distance, k: 'joint' }]
    .filter(Boolean).sort((a, b) => a.d - b.d)[0];
  if (best && best.k === 'cam') return { kind: 'cam' };
  if (best && best.k === 'aim') return { kind: 'aim' };
  if (h) return { kind: 'joint', c: h.object.userData.char, name: h.object.userData.joint };
  const ar = raycaster.intersectObjects(chars.map(c => c.arrowHit), false)[0];
  if (ar) return { kind: 'arrow', c: ar.object.userData.char };
  const d = raycaster.intersectObjects(chars.map(c => c.disc), false)[0];
  const body = []; chars.forEach(c => body.push(...c.flesh));
  const bh = raycaster.intersectObjects(body, false)[0];
  const pm = []; props.forEach(p => pm.push(...p.meshes));
  const pr = raycaster.intersectObjects(pm, false)[0];
  const near = [
    d && { d: d.distance, kind: 'base', c: d.object.userData.char },
    bh && { d: bh.distance, kind: 'char', c: bh.object.userData.char },
    pr && { d: pr.distance, kind: 'prop', p: pr.object.userData.prop },
  ].filter(Boolean).sort((a, b) => a.d - b.d)[0];
  if (near) return near;
  return null;
}
function startMove(c, plane, shift) {
  const g = rayPlane(plane); if (!g) return null;
  return { type: 'move', c, plane, grab: g, start: c.root.position.clone(), shift, moved: false };
}
stage.addEventListener('contextmenu', e => e.preventDefault());
stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.lab,#pip,#modeBar')) return;
  stage.setPointerCapture(e.pointerId);
  const p = posOf(e); lastX = p.x; lastY = p.y;
  if (e.button === 0 && spacePan) { drag = { type: 'pan', moved: false, dist: 0, viaSpace: true }; stage.style.cursor = 'grabbing'; return; }
  if (e.button === 1 || e.button === 2) { drag = { type: 'pan', moved: false, dist: 0 }; stage.style.cursor = 'grabbing'; return; }
  if (e.button !== 0) return;
  setRay(p);
  const hit = pick();
  if (!hit) { drag = { type: e.shiftKey ? 'pan' : 'orbit', moved: false, dist: 0 }; stage.style.cursor = 'grabbing'; return; }

  if (hit.kind === 'ring') {
    const c = selChar(), jo = c.joints[sel.j], center = V3(); jo.getWorldPosition(center);
    const axis = [V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1)][hit.i].applyQuaternion(gizmo.quaternion).normalize();
    drag = { type: 'ring', i: hit.i, axis, center, p: hit.point.clone(), jo, moved: false };
    ringVis[hit.i].material.opacity = 1; return;
  }
  if (hit.kind === 'aim') {
    const ap = aimHit.getWorldPosition(V3()), pl = new THREE.Plane().setFromNormalAndCoplanarPoint(activeCam().getWorldDirection(V3()), ap);
    if (rayPlane(pl)) drag = { type: 'aim', plane: pl, P: camPos(), moved: false };
    return;
  }
  if (hit.kind === 'cam') {
    const p0 = camPos(), n = activeCam().getWorldDirection(V3()); n.y = 0; if (n.lengthSq() < 1e-6) n.set(0, 0, 1); n.normalize();
    const pl = e.shiftKey ? new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0) : new THREE.Plane(V3(0, 1, 0), -p0.y);
    const g = rayPlane(pl); if (g) drag = { type: 'camMove', plane: pl, grab: g, start: outRig.target.clone(), shift: e.shiftKey, moved: false };
    return;
  }
  if (hit.kind === 'prop') {
    const p = hit.p; selectProp(p); const pos = p.root.position.clone();
    const n = activeCam().getWorldDirection(V3()); n.y = 0; if (n.lengthSq() < 1e-6) n.set(0, 0, 1); n.normalize();
    const pl = e.shiftKey ? new THREE.Plane().setFromNormalAndCoplanarPoint(n, pos) : new THREE.Plane(V3(0, 1, 0), -pos.y), g = rayPlane(pl);
    if (g) drag = { type: 'propMove', p, plane: pl, grab: g, start: pos, shift: e.shiftKey, moved: false };
    return;
  }
  if (hit.kind === 'arrow') {
    const c = hit.c; selectChar(c);
    const pl = new THREE.Plane(V3(0, 1, 0), 0), g = rayPlane(pl);
    if (g) drag = { type: 'turn', c, plane: pl, off: wrapRad(feetYaw(c) - Math.atan2(g.x - c.root.position.x, g.z - c.root.position.z)), moved: false };
    return;
  }
  if (hit.kind === 'base' || hit.kind === 'char') {
    selectChar(hit.c);
    drag = startMove(hit.c, new THREE.Plane(V3(0, 1, 0), 0), false); return;
  }
  const { c, name } = hit, def = DEF[name], jo = c.joints[name];
  selectJoint(c, name);
  const wp = V3(); jo.getWorldPosition(wp);
  if (def.mode === 'move') {
    if (e.shiftKey) {
      const n = activeCam().getWorldDirection(V3()); n.y = 0; if (n.lengthSq() < 1e-6) n.set(0, 0, 1); n.normalize();
      drag = startMove(c, new THREE.Plane().setFromNormalAndCoplanarPoint(n, wp), true);
    } else drag = startMove(c, new THREE.Plane(V3(0, 1, 0), -wp.y), false);
    return;
  }
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(activeCam().getWorldDirection(V3()), wp);
  const g = rayPlane(pl);
  if (def.mode === 'select' || !g) { drag = { type: 'none' }; return; }
  const off = wp.clone().sub(g);
  if (def.mode === 'ik') {
    const ch = IK_CHAIN[name], q0 = new THREE.Quaternion(); jo.getWorldQuaternion(q0);
    drag = { type: 'ik', c, ch, plane: pl, off, q0, moved: false };
  } else drag = { type: 'swing', c, jo, plane: pl, off, moved: false };
});
stage.addEventListener('pointermove', e => {
  const p = posOf(e), dx = p.x - lastX, dy = p.y - lastY; lastX = p.x; lastY = p.y;
  if (!drag) { if (spacePan) { stage.style.cursor = 'grab'; return; } hoverSoon(p); return; }
  if (drag.type === 'orbit' || drag.type === 'pan') {
    drag.dist += Math.abs(dx) + Math.abs(dy); if (drag.dist > 3) drag.moved = true;
    const rig = activeRig();
    if (drag.type === 'orbit') {
      const inPlace = (modes[view.mode] === 'look') !== e.altKey, kk = 0.0042 * (activeCam().fov / 40);
      if (inPlace) rigLookBy(rig, -dx * kk, dy * kk);
      else { rigOrbitAround(rig, pivotPoint(), -dx * 0.0065, dy * 0.0065); showPivot(); }
    } else { rig.pan(dx, dy, activeCam(), viewRect().h); if (drag.viaSpace) stage.style.cursor = 'grabbing'; }
    if (view.mode === 'cam') autosaveSoon();
    mark(); return;
  }
  if (drag.type === 'none') return;
  setRay(p);
  if (drag.type === 'ring') {
    const d = drag, r = d.p.clone().sub(d.center), rl = r.length(); if (rl < 1e-5) return;
    const t = V3().crossVectors(d.axis, r).normalize(), off = rl * 0.25;
    const cs = toScreen(d.center), ps = toScreen(d.center.clone().addScaledVector(t, off));
    const sx = ps.x - cs.x, sy = ps.y - cs.y, sl = sx * sx + sy * sy; if (sl < 0.25) return;
    const da = clamp(((dx * sx + dy * sy) * off / sl) / rl, -0.6, 0.6);
    rotateJointWorld(d.jo, new THREE.Quaternion().setFromAxisAngle(d.axis, da));
    d.p.sub(d.center).applyAxisAngle(d.axis, da).add(d.center);
    d.moved = true;
  } else if (drag.type === 'swing') {
    const g = rayPlane(drag.plane); if (!g) return;
    const target = g.add(drag.off), P = drag.jo.parent, a = V3(), b = V3();
    P.getWorldPosition(a); drag.jo.getWorldPosition(b);
    rotateJointWorld(P, qFromTo(b.sub(a), target.sub(a))); drag.moved = true;
  } else if (drag.type === 'ik') {
    const g = rayPlane(drag.plane); if (!g) return;
    const target = g.add(drag.off), [a, b, c, side] = drag.ch, J = drag.c.joints;
    const pole = V3(0, 0, side).applyQuaternion(drag.c.root.getWorldQuaternion(new THREE.Quaternion()));
    solveTwoBone(J[a], J[b], J[c], target, pole);
    const cq = new THREE.Quaternion(); J[c].getWorldQuaternion(cq);
    rotateJointWorld(J[c], drag.q0.clone().multiply(cq.invert())); // 손/발의 방향 유지
    drag.moved = true;
  } else if (drag.type === 'propMove') {
    const g = rayPlane(drag.plane); if (!g) return; const d = g.sub(drag.grab), p = drag.p;
    if (drag.shift) p.root.position.y = clamp(drag.start.y + d.y, 0, 4);
    else { p.root.position.x = drag.start.x + d.x; p.root.position.z = drag.start.z + d.z; }
    applyProp(p); drag.moved = true;
  } else if (drag.type === 'turn') {
    const g = rayPlane(drag.plane); if (!g) return; const c = drag.c;
    const target = Math.atan2(g.x - c.root.position.x, g.z - c.root.position.z) + drag.off;
    c.yaw = wrapRad(c.yaw + wrapRad(target - feetYaw(c))); applyChar(c); drag.moved = true;
  } else if (drag.type === 'aim') {
    const g = rayPlane(drag.plane); if (!g) return;
    const look = g.sub(drag.P); if (look.length() < 0.05) return; look.normalize();
    outRig.az = Math.atan2(-look.x, -look.z); outRig.el = clamp(Math.asin(-look.y), -1.45, 1.45);
    outRig.target.copy(drag.P).addScaledVector(dirVec(outRig.az, outRig.el), -outRig.dist);
    drag.moved = true; autosaveSoon();
  } else if (drag.type === 'camMove') {
    const g = rayPlane(drag.plane); if (!g) return;
    const d = g.sub(drag.grab); if (drag.shift) { d.x = 0; d.z = 0; } else d.y = 0;
    outRig.target.copy(drag.start).add(d); drag.moved = true; autosaveSoon();
  } else if (drag.type === 'move') {
    const g = rayPlane(drag.plane); if (!g) return;
    const d = g.sub(drag.grab), c = drag.c;
    if (drag.shift) c.root.position.y = clamp(drag.start.y + d.y, -1.2, 3);
    else { c.root.position.x = drag.start.x + d.x; c.root.position.z = drag.start.z + d.z; }
    applyChar(c); drag.moved = true;
  }
  mark();
});
function endDrag() {
  if (!drag) return;
  const viaSpace = !!drag.viaSpace;
  if (drag.type === 'ring') ringVis.forEach(v => { v.material.opacity = 0.92; });
  if (drag.moved && !['orbit', 'pan'].includes(drag.type)) commit();
  if (drag.type === 'propMove') syncProps();
  if (drag.type === 'orbit' && !drag.moved && (sel.j || sel.p)) { sel.j = null; sel.p = null; syncPanel(); }
  drag = null;
  if (viaSpace) stage.style.cursor = spacePan ? 'grab' : '';
  else if (spacePan) stage.style.cursor = 'grab';
  else stage.style.cursor = '';
  mark();
}
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('wheel', e => {
  e.preventDefault(); activeRig().dolly(Math.exp(e.deltaY * 0.0012));
  if (view.mode === 'cam') autosaveSoon(); mark();
}, { passive: false });
function hoverSoon(p) {
  if (hoverT) return;
  hoverT = setTimeout(() => {
    hoverT = 0; if (drag) return;
    if (spacePan) { stage.style.cursor = 'grab'; return; }
    setRay(p); const h = pick();
    stage.style.cursor = !h ? '' : (h.kind === 'base' || h.kind === 'char' || h.kind === 'cam' || h.kind === 'prop') ? 'move' : h.kind === 'aim' ? 'crosshair' : h.kind === 'arrow' ? 'grab' : 'pointer';
  }, 40);
}
pipEl.addEventListener('click', () => setView('cam'));

// ------------------------------------------------------------
// 출력 (캡처 · PNG · 썸네일)
// ------------------------------------------------------------
function outSize() {
  const a = aspectVal();
  return a >= 1 ? { w: OUT_LONG_EDGE, h: Math.round(OUT_LONG_EDGE / a) } : { w: Math.round(OUT_LONG_EDGE * a), h: OUT_LONG_EDGE };
}
// 메인 렌더러 하나로 오프스크린 렌더 타깃에 그린 뒤 2D 캔버스로 옮깁니다 (WebGL 컨텍스트를 하나만 사용).
function renderWith(cam, w, h, opts) {
  const rt = renderer.capabilities.isWebGL2
    ? new THREE.WebGLMultisampleRenderTarget(w, h, { format: THREE.RGBAFormat })
    : new THREE.WebGLRenderTarget(w, h, { format: THREE.RGBAFormat });
  const buf = new Uint8Array(w * h * 4);
  const prevScissor = renderer.getScissorTest();
  try {
    withClean(opts, () => {
      renderer.setScissorTest(false); renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
    });
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  } finally { renderer.setRenderTarget(null); renderer.setScissorTest(prevScissor); rt.dispose(); mark(); }
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(w, h), row = w * 4;
  for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row); // 세로 뒤집기
  ctx.putImageData(img, 0, 0);
  return cv;
}
function renderOutput(w, h) { syncCams(); return renderWith(outCam, w, h, { grid: disp.capGrid ? 'on' : 'off' }); }
function stamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function download(blob, name) {
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function flash() { const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
async function capture(mode) {
  const { w, h } = outSize(), cv = renderOutput(w, h);
  flash();
  const blobP = new Promise(res => cv.toBlob(res, 'image/png'));
  if (mode === 'png') { download(await blobP, `poseblock-${stamp()}.png`); toast(`PNG로 저장했습니다 (${w}×${h})`); return; }
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('no clipboard');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })]);
    toast('클립보드에 복사했습니다. 붙여넣기(Ctrl+V)로 사용하세요.');
  } catch (err) {
    download(await blobP, `poseblock-${stamp()}.png`);
    toast('클립보드를 쓸 수 없어 PNG로 저장했습니다. (HTTPS 또는 localhost에서 열면 복사됩니다)', 4600);
  }
}
function poseThumb(c, yawOff = 0) {
  c.root.updateMatrixWorld(true);
  const pts = JN.map(n => c.joints[n].getWorldPosition(V3()));
  const box = new THREE.Box3().setFromPoints(pts); box.expandByScalar(0.16);
  const ctr = box.getCenter(V3()), size = box.getSize(V3());
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 60), fh = Math.tan(THREE.MathUtils.degToRad(15));
  const dist = Math.max(size.y, size.x, size.z) / 2 / fh * 1.08 + size.z / 2;
  const f = V3(0, 0, 1).applyAxisAngle(V3(0, 1, 0), c.yaw + yawOff);
  cam.position.copy(ctr).addScaledVector(f, dist); cam.lookAt(ctr); cam.updateMatrixWorld(true);
  return renderWith(cam, 200, 200, { only: c, grid: 'off' }).toDataURL('image/jpeg', 0.84);
}
function sceneThumb() {
  syncCams(); const a = aspectVal(), w = 200, h = Math.round(w / a);
  return renderWith(outCam, w, Math.max(h, 40), { grid: 'off' }).toDataURL('image/jpeg', 0.8);
}

// ------------------------------------------------------------
// 패널 UI
// ------------------------------------------------------------
let toastT = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function syncPanel() {
  const box = $('#chips'); box.innerHTML = '';
  chars.forEach(c => {
    const b = el('button', 'chip' + (c.id === sel.c ? ' on' : '')), i = el('i');
    i.style.background = c.color; b.append(i, document.createTextNode(c.name));
    b.onclick = () => selectChar(c); box.append(b);
  });
  const c = selChar();
  $('#addChar').disabled = chars.length >= MAX_CHARS;
  $('#delChar').disabled = !c || chars.length <= 1;
  $('#charCtl').style.display = c ? '' : 'none';
  if (c) {
    if (document.activeElement !== $('#cName')) $('#cName').value = c.name;
    $('#cHeight').value = c.height; $('#cHeightV').textContent = c.height + ' cm';
    $('#cYaw').value = Math.round(c.yaw * 180 / Math.PI); $('#cYawV').textContent = $('#cYaw').value + '°';
    const j = $('#jInfo');
    if (sel.j) { const d = DEF[sel.j]; j.innerHTML = `<b></b> · ${MODE_HINT[d.mode]}`; j.firstChild.textContent = d.label; }
    else j.textContent = '관절 구를 클릭하면 회전 링이 나타납니다. 24개 관절 모두 선택할 수 있습니다.';
    $('#resetJoint').disabled = !sel.j;
  }
  const ft = $('#faceTarget'), prev = ft.value; ft.innerHTML = '';
  if (c) {
    const others = chars.filter(x => x !== c).sort((a, b) => a.root.position.distanceTo(c.root.position) - b.root.position.distanceTo(c.root.position));
    others.forEach(o => { const op = el('option'); op.value = o.id; op.textContent = o.name; ft.append(op); });
    if (others.some(o => o.id === prev)) ft.value = prev;
  }
  $('#faceOne').disabled = $('#faceBoth').disabled = chars.length < 2;
  document.querySelectorAll('#aspects button').forEach(b => b.classList.toggle('on', b.dataset.a === out.aspect));
  $('#fov').value = out.fov; $('#fovV').textContent = out.fov + '°';
  document.querySelectorAll('#elevs button').forEach(b => b.classList.toggle('on', Math.abs(outRig.el - ELEV[b.dataset.e]) < 0.04));
  syncProps();
  updateUndoBtns();
}
// 캐릭터
$('#addChar').onclick = () => {
  if (chars.length >= MAX_CHARS) return;
  const c = createCharacter(defaultChar(chars.length, chars.map(x => x.color)));
  chars.push(c); selectChar(c); commit();
};
$('#delChar').onclick = () => {
  const c = selChar(); if (!c || chars.length <= 1) return;
  disposeChar(c); chars = chars.filter(x => x !== c); sel.c = chars[0].id; sel.j = null;
  chars.forEach(applyChar); syncPanel(); commit();
};
$('#cName').addEventListener('input', e => { const c = selChar(); if (!c) return; c.name = e.target.value.slice(0, 12) || '?'; c.label.lastChild.textContent = c.name; syncPanelChipsOnly(); mark(); });
$('#cName').addEventListener('change', commit);
function syncPanelChipsOnly() { const c = selChar(); document.querySelectorAll('#chips .chip.on').forEach(b => { b.lastChild.textContent = c.name; }); }
$('#cHeight').addEventListener('input', e => { const c = selChar(); c.height = +e.target.value; $('#cHeightV').textContent = c.height + ' cm'; applyChar(c); });
$('#cHeight').addEventListener('change', commit);
$('#cYaw').addEventListener('input', e => { const c = selChar(); c.yaw = +e.target.value * Math.PI / 180; $('#cYawV').textContent = e.target.value + '°'; applyChar(c); });
$('#cYaw').addEventListener('change', commit);
const faceTarget = () => chars.find(x => x.id === $('#faceTarget').value);
$('#faceOne').onclick = () => {
  const c = selChar(), t = faceTarget(); if (!c || !t) return;
  faceTowards(c, t.root.position.x, t.root.position.z); commit(); syncPanel(); toast(`${c.name}이(가) ${t.name}을(를) 바라봅니다.`);
};
$('#faceBoth').onclick = () => {
  const c = selChar(), t = faceTarget(); if (!c || !t) return;
  const p1 = c.root.position.clone(), p2 = t.root.position.clone();
  faceTowards(c, p2.x, p2.z); faceTowards(t, p1.x, p1.z); commit(); syncPanel(); toast(`${c.name}과(와) ${t.name}이(가) 서로 마주봅니다.`);
};
$('#alignLegs').onclick = () => { const c = selChar(); if (!c) return; toast(alignLegs(c) ? '하체 방향을 상체에 맞췄습니다.' : '이미 상체와 하체가 같은 방향입니다.'); commit(); };
$('#resetJoint').onclick = () => { const c = selChar(); if (!c || !sel.j) return; c.joints[sel.j].quaternion.identity(); c.root.updateMatrixWorld(true); mark(); commit(); };
$('#resetPose').onclick = () => { const c = selChar(); if (!c) return; JN.forEach(n => c.joints[n].quaternion.identity()); c.root.updateMatrixWorld(true); mark(); commit(); };
// 카메라
Object.keys(ASPECTS).forEach(k => {
  const b = el('button'); b.textContent = k; b.dataset.a = k;
  b.onclick = () => { out.aspect = k; syncPanel(); mark(); autosaveSoon(); };
  $('#aspects').append(b);
});
$('#fov').addEventListener('input', e => { out.fov = +e.target.value; $('#fovV').textContent = out.fov + '°'; mark(); autosaveSoon(); });
document.querySelectorAll('#elevs button').forEach(b => b.onclick = () => { setElevation(ELEV[b.dataset.e]); syncPanel(); });
$('#fromWork').onclick = () => {
  outRig.az = workRig.az; outRig.el = workRig.el; outRig.dist = workRig.dist; outRig.target.copy(workRig.target);
  syncPanel(); mark(); autosaveSoon(); toast('현재 작업 뷰 시점을 출력 카메라에 적용했습니다.');
};
// 표시
const bindOpt = (id, key, after) => $(id).addEventListener('change', e => { disp[key] = e.target.checked; if (after) after(); mark(); });
bindOpt('#optGrid', 'grid', applyDisplayAll); bindOpt('#optBody', 'body', applyDisplayAll);
bindOpt('#optJoints', 'joints', applyDisplayAll); bindOpt('#optGhost', 'ghost', applyDisplayAll); bindOpt('#optCapGrid', 'capGrid');
// 헤더
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#newScene').onclick = () => { sel.c = null; sel.j = null; sel.p = null; setProps([]); setChars([defaultChar()].map(d => ({ ...d, name: 'A' }))); commit(); toast('새 씬을 만들었습니다. 되돌리기로 복구할 수 있습니다.'); };
$('#capCopy').onclick = () => capture('copy'); $('#capPng').onclick = () => capture('png');
document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => setView(b.dataset.v));

// 에셋 패널
// 일반 실행에서는 정적 WebP만 사용한다. 단일 HTML 빌드는 build-single.mjs가 같은 이미지를 data URI로 주입한다.
const PROP_THUMB_VERSION = '1.4.0';
const propThumbs = window.__PB_PROP_THUMBS__ || {};
function propThumbSrc(type) { return propThumbs[type] || `assets/thumbs/${type}.webp?v=${PROP_THUMB_VERSION}`; }
function renderPropGrid() {
  const types = PROP_CATEGORIES[propCategory] || PROP_CATEGORIES.basic;
  const g = $('#propGrid'); g.innerHTML = '';
  types.forEach(type => {
    const T = PROP_TYPES[type]; if (!T) return;
    const card = el('div', 'sv'), img = el('img'), nm = el('div', 'nm ro');
    img.src = propThumbSrc(type);
    img.alt = T.name; img.title = `${T.name} 추가`; img.loading = 'lazy'; img.decoding = 'async'; img.onclick = () => addProp(type);
    nm.textContent = T.name; card.append(img, nm); g.append(card);
  });
}
function setPropCategory(cat) {
  if (!PROP_CATEGORIES[cat]) return;
  propCategory = cat;
  document.querySelectorAll('#propCats button').forEach(b => b.classList.toggle('on', b.dataset.cat === cat));
  renderPropGrid();
}
document.querySelectorAll('#propCats button').forEach(b => b.onclick = () => setPropCategory(b.dataset.cat));
function syncProps() {
  const box = $('#propChips'); if (!box) return; box.innerHTML = '';
  props.forEach(p => {
    const b = el('button', 'chip' + (p.id === sel.p ? ' on' : '')); b.textContent = p.name; b.onclick = () => selectProp(p); box.append(b);
  });
  $('#propHint').hidden = props.length > 0 && !!selProp();
  const p = selProp(); $('#propCtl').hidden = !p;
  if (!p) return;
  const set = (id, v, txt) => { const r = $('#' + id); if (document.activeElement !== r) r.value = v; $('#' + id + 'V').textContent = txt; };
  set('pSx', Math.round(p.sc[0] * 100), Math.round(p.sc[0] * 100) + '%'); set('pSy', Math.round(p.sc[1] * 100), Math.round(p.sc[1] * 100) + '%'); set('pSz', Math.round(p.sc[2] * 100), Math.round(p.sc[2] * 100) + '%');
  set('pYaw', Math.round(wrap180(p.yaw / D2R)), Math.round(wrap180(p.yaw / D2R)) + '°'); set('pLift', Math.round(p.root.position.y * 100), Math.round(p.root.position.y * 100) + ' cm');
  document.querySelectorAll('#propColors .sw').forEach(b => b.classList.toggle('on', b.dataset.c === p.color));
}
PROP_COLORS.forEach(col => { const b = el('button', 'sw'); b.dataset.c = col; b.style.background = col; b.title = col;
  b.onclick = () => { const p = selProp(); if (!p) return; p.color = col; applyProp(p); syncProps(); commit(); }; $('#propColors').append(b); });
function bindProp(id, fn) {
  $(id).addEventListener('input', e => { const p = selProp(); if (!p) return; fn(p, +e.target.value); applyProp(p); syncProps(); });
  $(id).addEventListener('change', commit);
}
function setPropScale(p, axis, v) {
  if ($('#pLock').checked) { const r = v / p.sc[axis]; p.sc = p.sc.map(x => clamp(x * r, 0.2, 4)); } else p.sc[axis] = clamp(v, 0.2, 4);
}
bindProp('#pSx', (p, v) => setPropScale(p, 0, v / 100)); bindProp('#pSy', (p, v) => setPropScale(p, 1, v / 100)); bindProp('#pSz', (p, v) => setPropScale(p, 2, v / 100));
bindProp('#pYaw', (p, v) => { p.yaw = v * D2R; }); bindProp('#pLift', (p, v) => { p.root.position.y = v / 100; });
function deleteProp() { const p = selProp(); if (!p) return; disposeProp(p); props = props.filter(q => q !== p); sel.p = null; syncPanel(); commit(); }
$('#propDel').onclick = deleteProp;
$('#propDup').onclick = () => {
  const p = selProp(); if (!p || props.length >= MAX_PROPS) return;
  const d = serializeProp(p); delete d.id; delete d.name; d.pos[0] += 0.6; const q = createProp(d); props.push(q); selectProp(q); commit();
};

// 탭 (왼쪽 설정, 오른쪽 라이브러리)
function bindTabs(rootSel, cb) {
  const root = $(rootSel);
  root.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); cb(b.dataset.t);
  }));
}
bindTabs('#leftTabs', t => { document.querySelectorAll('#left .pane').forEach(p => { p.hidden = p.dataset.pane !== t; }); if (t === 'props' && !$('#propGrid').children.length) renderPropGrid(); });
bindTabs('#libTabs', t => { tab = t; renderSaved(); });

// ------------------------------------------------------------
// 자세 프리셋 (각도는 도 단위 [x, y, z] 오일러 XYZ, 팔다리는 아래(-Y)로 늘어진 기본 자세 기준)
//  - 어깨·엉덩이 x: 음수 = 앞으로, z: 왼쪽은 양수 = 바깥쪽 (오른쪽은 반대)
//  - 팔꿈치 x: 음수 = 굽힘(앞), 무릎 x: 양수 = 굽힘(뒤), 척추 x: 양수 = 앞으로 숙임
// ------------------------------------------------------------
const mirrorSpec = o => {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (/L$/.test(k)) r[k.slice(0, -1) + 'R'] = [v[0], -v[1], -v[2]];
    else if (/R$/.test(k)) r[k.slice(0, -1) + 'L'] = [v[0], -v[1], -v[2]];
  }
  return r;
};
const sym = l => ({ ...l, ...mirrorSpec(l) });
const PRESETS = [
  { id: 'stand', name: '기본 서기', j: sym({ shoulderL: [0, 0, 5] }) },
  { id: 'relax', name: '편하게 서기', j: {
    pelvis: [0, -8, 3], spineLow: [0, 5, -2], spineMid: [0, 4, 0], spineUp: [0, 4, 0], head: [0, 6, 0],
    hipL: [-8, 0, 0], kneeL: [10, 0, 0], shoulderL: [-5, 0, 8], elbowL: [-18, 0, 0], shoulderR: [3, 0, -9], elbowR: [-8, 0, 0] } },
  { id: 'walk', name: '걷기', j: {
    pelvis: [0, -6, 0], spineLow: [3, 0, 0], spineMid: [0, 6, 0],
    hipL: [-28, 0, 0], kneeL: [6, 0, 0], ankleL: [12, 0, 0], hipR: [22, 0, 0], kneeR: [30, 0, 0],
    shoulderL: [25, 0, 5], elbowL: [-15, 0, 0], shoulderR: [-25, 0, -5], elbowR: [-35, 0, 0] } },
  { id: 'run', name: '달리기', j: {
    spineLow: [12, 0, 0], spineMid: [6, 0, 0], neck: [-8, 0, 0], head: [-6, 0, 0],
    hipL: [-65, 0, 0], kneeL: [75, 0, 0], ankleL: [10, 0, 0], hipR: [30, 0, 0], kneeR: [55, 0, 0], ankleR: [5, 0, 0],
    shoulderL: [45, 0, 8], elbowL: [-80, 0, 0], shoulderR: [-50, 0, -8], elbowR: [-90, 0, 0] } },
  { id: 'sit', name: '앉기 (의자)', j: { ...sym({ hipL: [-90, 0, 3], kneeL: [90, 0, 0], shoulderL: [-15, 0, 6], elbowL: [-45, 0, 0] }), spineLow: [4, 0, 0] } },
  { id: 'squat', name: '쪼그려 앉기', j: { ...sym({ hipL: [-120, 0, 12], kneeL: [135, 0, 0], ankleL: [-15, 0, 0], shoulderL: [-40, 0, 5], elbowL: [-25, 0, 0] }),
    spineLow: [18, 0, 0], spineMid: [6, 0, 0], neck: [-12, 0, 0] } },
  { id: 'wave', name: '손 흔들기', j: {
    shoulderR: [0, 0, -80], elbowR: [0, 0, -80], shoulderL: [0, 0, 6], elbowL: [-15, 0, 0], head: [0, -5, -5], spineMid: [0, 4, 0] } },
  { id: 'shake', name: '악수 (손 내밀기)', j: {
    shoulderR: [-45, 0, -8], elbowR: [-60, 0, 0], shoulderL: [0, 0, 6], elbowL: [-12, 0, 0], spineLow: [5, 0, 0], neck: [-3, 0, 0] } },
  { id: 'point', name: '가리키기', j: {
    shoulderR: [-80, 0, -12], elbowR: [-5, 0, 0], shoulderL: [0, 0, 8], elbowL: [-20, 0, 0], head: [0, -8, 0],
    hipL: [-10, 0, 0], kneeL: [8, 0, 0], hipR: [8, 0, 0] } },
  { id: 'cross', name: '팔짱 끼기', j: { ...sym({ shoulderL: [-30, 0, 5], elbowL: [-115, 0, 0] }), hipL: [-4, 0, 0], hipR: [2, 0, 0] },
    ik: { wristL: [-0.15, 1.14, 0.17], wristR: [0.15, 1.08, 0.20] } },
  { id: 'hands', name: '손 들기', j: { ...sym({ shoulderL: [0, 0, 75], elbowL: [0, 0, 80] }), neck: [-5, 0, 0] } },
  { id: 'jump', name: '점프', j: { ...sym({ shoulderL: [0, 0, 145], elbowL: [0, 0, 10] }),
    hipL: [-45, 0, 6], kneeL: [75, 0, 0], hipR: [-20, 0, -6], kneeR: [50, 0, 0], spineLow: [-6, 0, 0] }, lift: 0.4 },
];
// 발바닥의 가장 낮은 높이 (월드)
function footMinY(c) {
  c.root.updateMatrixWorld(true);
  const s_ = c.root.scale.x, v = V3(); let m = Infinity;
  for (const n of ['ankleL', 'ankleR']) { c.joints[n].getWorldPosition(v); m = Math.min(m, v.y - 0.09 * s_); }
  for (const n of ['toeL', 'toeR']) { c.joints[n].getWorldPosition(v); m = Math.min(m, v.y - 0.02 * s_); }
  return m;
}
function groundChar(c) { c.root.position.y = clamp(c.root.position.y - footMinY(c), -1.2, 3); c.root.updateMatrixWorld(true); }
function applyPresetTo(c, p) {
  applyChar(c); // 키(스케일)를 먼저 동기화해야 발 높이가 정확합니다
  JN.forEach(n => c.joints[n].quaternion.identity());
  for (const [n, v] of Object.entries(p.j)) if (c.joints[n]) c.joints[n].quaternion.setFromEuler(new THREE.Euler(v[0] * D2R, v[1] * D2R, v[2] * D2R, 'XYZ'));
  c.root.updateMatrixWorld(true);
  if (p.ik) for (const [n, t] of Object.entries(p.ik)) {
    const ch = IK_CHAIN[n], J = c.joints, rq = new THREE.Quaternion();
    c.root.getWorldQuaternion(rq);
    solveTwoBone(J[ch[0]], J[ch[1]], J[ch[2]], c.root.localToWorld(V3(...t)), V3(0, 0, ch[3]).applyQuaternion(rq));
  }
  groundChar(c); c.root.position.y += (p.lift || 0) * (c.root.scale.x); applyChar(c);
}
const presetThumbs = {};
function ensurePresetThumbs() {
  for (const p of PRESETS) {
    if (presetThumbs[p.id]) continue;
    const tc = createCharacter({ name: '', color: '#4f5d78', pos: [0, 0, 0], height: 175 });
    tc.aids.visible = false; applyPresetTo(tc, p);
    presetThumbs[p.id] = poseThumb(tc, p.id === 'stand' || p.id === 'hands' || p.id === 'cross' ? 0.35 : 0.65);
    disposeChar(tc);
  }
}

// 저장 목록 (프리셋 / 내 포즈 / 씬)
const lists = { poses: store.get(K_POSES) || [], scenes: store.get(K_SCENES) || [] };
let tab = 'presets';
const LIB_HINT = {
  presets: '클릭하면 선택한 캐릭터에 적용됩니다. 적용한 뒤 관절을 더 다듬어 쓰세요.',
  poses: '관절 회전값만 저장되어 키가 다른 캐릭터에도 적용됩니다.',
  scenes: '캐릭터 배치, 포즈, 출력 카메라까지 통째로 저장합니다.',
};
const persistLists = () => { store.set(K_POSES, lists.poses); store.set(K_SCENES, lists.scenes); };
function renderSaved() {
  $('#saveRow').hidden = tab === 'presets';
  $('#libHint').textContent = LIB_HINT[tab];
  $('#saveBtn').textContent = tab === 'poses' ? '현재 포즈 저장' : '현재 씬 저장';
  const g = $('#saved'); g.innerHTML = '';
  if (tab === 'presets') {
    ensurePresetThumbs();
    PRESETS.forEach(p => {
      const card = el('div', 'sv'), img = el('img'), nm = el('div', 'nm ro');
      img.src = presetThumbs[p.id]; img.alt = p.name; img.title = '클릭하면 선택한 캐릭터에 적용';
      img.onclick = () => applySaved(p); nm.textContent = p.name; card.append(img, nm); g.append(card);
    });
    return;
  }
  const arr = lists[tab];
  if (!arr.length) { const p = el('p', 'empty'); p.textContent = tab === 'poses' ? '저장한 포즈가 없습니다.' : '저장한 씬이 없습니다.'; g.append(p); return; }
  arr.forEach(it => {
    const card = el('div', 'sv'), img = el('img'), nm = el('div', 'nm'), span = el('span');
    img.src = it.thumb || ''; img.alt = it.name; img.title = tab === 'poses' ? '클릭하면 선택한 캐릭터에 적용' : '클릭하면 씬을 불러옴';
    img.onclick = () => applySaved(it);
    span.textContent = it.name;
    const ed = el('button'); ed.textContent = '✎'; ed.title = '이름 변경';
    ed.onclick = () => {
      const inp = el('input'); inp.type = 'text'; inp.value = it.name; inp.maxLength = 20;
      span.replaceWith(inp); inp.focus(); inp.select();
      const done = () => { it.name = inp.value.trim() || it.name; persistLists(); renderSaved(); };
      inp.onblur = done; inp.onkeydown = ev => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = it.name; inp.blur(); } };
    };
    const del = el('button'); del.textContent = '✕'; del.title = '삭제';
    del.onclick = () => { lists[tab] = lists[tab].filter(x => x !== it); persistLists(); renderSaved(); };
    const shr = el('button', 'btn sm shr'); shr.textContent = '공유 · 내보내기';
    shr.onclick = () => openShare(tab === 'poses' ? 'pose' : 'scene', it.name, tab === 'poses' ? it.q : it.state, it.thumb);
    nm.append(span, ed, del); card.append(img, nm, shr); g.append(card);
  });
}
function applySaved(it) {
  if (tab === 'scenes') { toast(setFull(it.state) ? `'${it.name}' 씬을 불러왔습니다.` : '씬 데이터가 올바르지 않습니다.'); return; }
  const c = selChar() || chars[0]; if (!c) return;
  if (tab === 'presets') { applyPresetTo(c, it); }
  else { const was = Math.abs(footMinY(c)) < 0.03; applyQuats(c, it.q); if (was) groundChar(c); applyChar(c); }
  mark(); commit(); toast(`'${it.name}' 자세를 ${c.name}에 적용했습니다.`);
}
$('#saveBtn').onclick = () => {
  const inp = $('#saveName'), n = lists[tab].length + 1;
  if (tab === 'poses') {
    const c = selChar() || chars[0]; if (!c) return;
    const q = {}; JN.forEach(k => { q[k] = c.joints[k].quaternion.toArray().map(r5); });
    lists.poses.unshift({ id: uid(), name: inp.value.trim() || `포즈 ${n}`, q, thumb: poseThumb(c, 0.5), t: Date.now() });
  } else if (tab === 'scenes') {
    lists.scenes.unshift({ id: uid(), name: inp.value.trim() || `씬 ${n}`, state: getFull(), thumb: sceneThumb(), t: Date.now() });
  } else return;
  inp.value = ''; persistLists(); renderSaved(); toast('저장했습니다.'); mark();
};
$('#groundBtn').onclick = () => { const c = selChar(); if (!c) return; groundChar(c); applyChar(c); commit(); };
$('#expJson').onclick = () => {
  const data = { app: 'poseblock3d', version: 1, poses: lists.poses, scenes: lists.scenes };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `poseblock-library-${stamp()}.json`);
};
$('#impJson').onclick = () => $('#impFile').click();
$('#impFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text()); let np = 0, ns = 0;
    (Array.isArray(d.poses) ? d.poses : []).forEach(p => {
      if (p && typeof p.q === 'object' && p.q) { lists.poses.push({ id: uid(), name: String(p.name || '가져온 포즈').slice(0, 20), q: p.q, thumb: typeof p.thumb === 'string' && p.thumb.startsWith('data:image/') ? p.thumb : '', t: Date.now() }); np++; }
    });
    (Array.isArray(d.scenes) ? d.scenes : []).forEach(s_ => {
      if (s_ && s_.state && sanitizeChars(s_.state.chars)) { lists.scenes.push({ id: uid(), name: String(s_.name || '가져온 씬').slice(0, 20), state: s_.state, thumb: typeof s_.thumb === 'string' && s_.thumb.startsWith('data:image/') ? s_.thumb : '', t: Date.now() }); ns++; }
    });
    persistLists(); renderSaved();
    toast(np + ns ? `포즈 ${np}개, 씬 ${ns}개를 가져왔습니다.` : '가져올 수 있는 데이터가 없습니다.');
  } catch (err) { toast('JSON 파일을 읽을 수 없습니다.'); }
});

// ------------------------------------------------------------
// 공유 (링크 · 파일)
// ------------------------------------------------------------
function showDialog(title, body, buttons) {
  $('#dlgTitle').textContent = title;
  const b = $('#dlgBody'); b.innerHTML = '';
  (Array.isArray(body) ? body : [body]).forEach(n => { if (typeof n === 'string') { const p = el('p'); p.textContent = n; b.append(p); } else b.append(n); });
  const bt = $('#dlgBtns'); bt.innerHTML = '';
  buttons.forEach(x => {
    const btn = el('button', 'btn sm' + (x.primary ? ' pri' : '')); btn.textContent = x.label;
    btn.onclick = () => { if (!x.keep) closeDialog(); if (x.onClick) x.onClick(); }; bt.append(btn);
  });
  $('#dlg').hidden = false;
}
function closeDialog() { $('#dlg').hidden = true; }
$('#dlg').addEventListener('pointerdown', e => { if (e.target.id === 'dlg') closeDialog(); });

const b64u = {
  enc(u8) { let s_ = ''; for (let i = 0; i < u8.length; i += 8192) s_ += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s_).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(t) { t = t.replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return Uint8Array.from(atob(t), ch => ch.charCodeAt(0)); },
};
async function pipeBytes(u8, stream) {
  const w = stream.writable.getWriter(); w.write(u8).catch(() => {}); w.close().catch(() => {}); // 손상된 데이터의 에러는 아래 await에서 한 번만 처리
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
async function packShare(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (window.CompressionStream) return 'z.' + b64u.enc(await pipeBytes(raw, new CompressionStream('deflate-raw')));
  return 'j.' + b64u.enc(raw);
}
async function unpackShare(str) {
  if (str.length > 400000 || !/^[zj]\.[A-Za-z0-9_-]+$/.test(str)) throw new Error('bad link');
  let u8 = b64u.dec(str.slice(2));
  if (str[0] === 'z') u8 = await pipeBytes(u8, new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(u8));
}
const r4 = v => Math.round(v * 1e4) / 1e4;
function compactQ(q) { // 회전이 없는 관절은 생략하고 소수점을 줄여 링크를 짧게 만듭니다.
  const o = {};
  for (const n of JN) { const a = q && q[n]; if (!Array.isArray(a) || a.length !== 4) continue; if (Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]) < 1e-4 && a[3] > 0.99999) continue; o[n] = a.map(r4); }
  return o;
}
const compactFull = f => ({ ...f, chars: f.chars.map(c => ({ ...c, pos: c.pos.map(r4), yaw: r4(c.yaw), q: compactQ(c.q) })) });
const fileSafe = t => String(t).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || stamp(); // 파일명은 영문·숫자만 (실제 이름은 파일 안에 저장)
function exportFile(kind, name, data, thumb) {
  const item = kind === 'pose' ? { id: uid(), name, q: data, thumb: thumb || '' } : { id: uid(), name, state: data, thumb: thumb || '' };
  const lib = { app: 'poseblock3d', version: 2, poses: kind === 'pose' ? [item] : [], scenes: kind === 'scene' ? [item] : [] };
  download(new Blob([JSON.stringify(lib)], { type: 'application/json' }), `poseblock-${kind}-${fileSafe(name)}.json`);
  toast('파일로 저장했습니다. 받는 사람은 "JSON 가져오기"로 불러오면 됩니다.', 3600);
}
async function openShare(kind, name, data, thumb) {
  const obj = kind === 'pose' ? { v: 1, k: 'pose', n: name, q: compactQ(data) } : { v: 1, k: 'scene', n: name, s: compactFull(data) };
  let url = ''; try { url = location.href.split('#')[0] + '#share=' + await packShare(obj); } catch (e) { url = ''; }
  const ta = el('textarea', 'link'); ta.readOnly = true; ta.value = url || '링크를 만들 수 없습니다. 파일로 저장해 공유해 주세요.';
  const notes = [location.protocol === 'file:'
    ? '지금은 내 컴퓨터의 파일로 열려 있어서, 이 링크는 이 컴퓨터에서만 열립니다. 웹에 배포한 주소에서 만든 링크는 누구에게나 열립니다. 어디서든 쓰려면 "파일로 저장"을 이용하세요.'
    : '받는 사람이 링크를 열면 PoseBlock에 바로 불러와집니다.'];
  if (url) notes.push(`링크 길이 ${url.length.toLocaleString()}자` + (url.length > 6000 ? ' · 길어서 일부 메신저에서 잘릴 수 있습니다. 이럴 때는 파일로 공유하세요.' : ''));
  showDialog(kind === 'pose' ? `포즈 공유 · ${name}` : `씬 공유 · ${name}`, [notes[0], ta, ...notes.slice(1)], [
    { label: '링크 복사', primary: true, keep: true, onClick: async () => {
      try { await navigator.clipboard.writeText(url); toast('링크를 복사했습니다.'); }
      catch (e) { ta.focus(); ta.select(); toast('복사 권한이 없어 링크를 선택해 두었습니다. Ctrl+C로 복사하세요.', 3600); } } },
    { label: '파일로 저장', keep: true, onClick: () => exportFile(kind, name, data, thumb) },
    { label: '닫기' },
  ]);
  if (url) { ta.focus(); ta.select(); }
}
$('#shareBtn').onclick = () => openShare('scene', '내 씬', getFull(), '');
$('#shareNow').onclick = () => {
  const nm = $('#saveName').value.trim();
  if (tab === 'poses') { const c = selChar() || chars[0]; if (!c) return; const q = {}; JN.forEach(k => { q[k] = c.joints[k].quaternion.toArray().map(r5); }); openShare('pose', nm || '내 포즈', q, ''); }
  else openShare('scene', nm || '내 씬', getFull(), '');
};
// 공유 링크로 들어왔을 때
async function handleShareHash() {
  const m = location.hash.match(/^#share=(.+)$/); if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let o; try { o = await unpackShare(m[1]); } catch (e) { toast('공유 링크를 읽을 수 없습니다. 링크가 잘렸는지 확인해 주세요.', 4200); return; }
  const name = String((o && o.n) || '').slice(0, 20);
  if (o && o.v === 1 && o.k === 'pose' && o.q && typeof o.q === 'object') {
    const tc = createCharacter({ name: '', color: '#4f5d78', pos: [0, 0, 0], height: 175, q: o.q }); tc.aids.visible = false;
    const thumb = poseThumb(tc, 0.5); disposeChar(tc);
    lists.poses.unshift({ id: uid(), name: name || '공유받은 포즈', q: o.q, thumb, t: Date.now() }); persistLists();
    document.querySelector('#libTabs button[data-t="poses"]').click();
    toast(`공유받은 포즈 '${name || '공유받은 포즈'}'를 내 포즈에 추가했습니다. 클릭하면 적용됩니다.`, 4800);
  } else if (o && o.v === 1 && o.k === 'scene' && o.s && sanitizeChars(o.s.chars)) {
    showDialog('공유받은 씬', [`'${name || '공유받은 씬'}' 씬을 열까요?`, '지금 작업 중인 씬은 "내 씬" 탭에 "공유 링크 열기 전 작업"으로 보관됩니다.'], [
      { label: '열기', primary: true, onClick: () => {
        lists.scenes = lists.scenes.filter(x => x.name !== '공유 링크 열기 전 작업');
        lists.scenes.unshift({ id: uid(), name: '공유 링크 열기 전 작업', state: getFull(), thumb: sceneThumb(), t: Date.now() });
        setFull(o.s);
        lists.scenes.unshift({ id: uid(), name: name || '공유받은 씬', state: getFull(), thumb: sceneThumb(), t: Date.now() });
        persistLists(); document.querySelector('#libTabs button[data-t="scenes"]').click(); toast('공유받은 씬을 열었습니다.');
      } },
      { label: '취소' },
    ]);
  } else toast('지원하지 않는 공유 링크입니다.', 4000);
}
window.addEventListener('hashchange', handleShareHash);

// 카메라 위치 (슬라이더 · 키보드)
function camPos() { syncCams(); return outCam.position.clone(); }
function setCamPos(p) { outRig.target.add(p.clone().sub(camPos())); mark(); autosaveSoon(); }
function updateDirSliders() {
  const set = (id, v, txt) => { const r = $('#' + id); if (document.activeElement !== r) r.value = v; $('#' + id + 'V').textContent = txt; };
  const yaw = wrap180(-outRig.az / D2R), tilt = -outRig.el / D2R, roll = out.roll / D2R;
  set('camYaw', yaw, Math.round(yaw) + '°'); set('camTilt', tilt, Math.round(tilt) + '°'); set('camRoll', roll, Math.round(roll) + '°');
}
function updateCamSliders() {
  updateDirSliders();
  const p = outCam.position;
  [['camX', p.x], ['camY', p.y], ['camZ', p.z]].forEach(([id, v]) => {
    const r = $('#' + id); if (document.activeElement !== r) r.value = v; $('#' + id + 'V').textContent = v.toFixed(1) + ' m';
  });
}
['X', 'Y', 'Z'].forEach(ax => $('#cam' + ax).addEventListener('input', e => {
  const p = camPos(); p[ax.toLowerCase()] = +e.target.value; setCamPos(p);
}));
$('#findCam').onclick = () => {
  setView('work');
  const C = camPos(), T = V3(); chars.forEach(c => T.add(c.root.position)); T.divideScalar(Math.max(chars.length, 1)); T.y = 0.95;
  const d = C.clone().sub(T); d.y = 0; const len = Math.max(d.length(), 1);
  if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
  d.normalize();
  workRig.target.copy(C).add(T).multiplyScalar(0.5); workRig.target.y = Math.max((C.y + T.y) / 2, 0.8);
  workRig.az = Math.atan2(d.z, -d.x); workRig.el = 0.3; workRig.dist = Math.max(len * 1.15 + 2.5, 5.5);
  mark();
};
// 카메라 회전 (제자리 회전 / 대상 중심 회전)
const rigPos = rig => rig.target.clone().addScaledVector(dirVec(rig.az, rig.el), rig.dist);
// 제자리 회전. 카메라 위치는 고정하고 바라보는 방향만 바꿉니다.
function rigLookBy(rig, dYaw, dTilt) {
  const P = rigPos(rig);
  rig.az -= dYaw; rig.el = clamp(rig.el - dTilt, -1.45, 1.45);
  rig.target.copy(P).addScaledVector(dirVec(rig.az, rig.el), -rig.dist);
  mark(); autosaveSoon();
}
// 회전 중심이 되는 대상. 선택한 캐릭터의 가슴 높이이고, 선택이 없으면 모든 캐릭터의 중앙입니다.
function pivotPoint() {
  const c = selChar(), T = V3();
  if (c) return T.set(c.root.position.x, c.root.position.y + c.height / 100 * 0.55, c.root.position.z);
  chars.forEach(x => T.add(x.root.position)); T.divideScalar(Math.max(chars.length, 1)); T.y = 0.95; return T;
}
// 대상 중심 회전. 대상을 축으로 카메라를 통째로 돌려서 구도 속 대상의 위치와 거리가 유지됩니다.
function rigOrbitAround(rig, pivot, dYaw, dEl) {
  const P = rigPos(rig), T = rig.target.clone();
  const turn = (q, p) => p.sub(pivot).applyQuaternion(q).add(pivot);
  const qy = new THREE.Quaternion().setFromAxisAngle(V3(0, 1, 0), dYaw);
  turn(qy, P); turn(qy, T);
  const right = V3().crossVectors(T.clone().sub(P), V3(0, 1, 0));
  if (right.lengthSq() > 1e-8) {
    right.normalize();
    const qp = new THREE.Quaternion().setFromAxisAngle(right, -dEl), P2 = turn(qp, P.clone()), T2 = turn(qp, T.clone());
    const v = P2.clone().sub(T2);
    if (Math.abs(Math.asin(v.y / v.length())) < 1.45) { P.copy(P2); T.copy(T2); }
  }
  const v = P.clone().sub(T), d = v.length();
  rig.az = Math.atan2(v.x, v.z); rig.el = Math.asin(v.y / d); rig.dist = d; rig.target.copy(T);
  mark(); autosaveSoon();
}
function showPivot() { pivotUntil = performance.now() + 900; clearTimeout(showPivot.t); showPivot.t = setTimeout(mark, 950); }
// 앵글 프리셋. 대상을 바라본 채 같은 거리에서 카메라 높이만 바꿉니다.
function setElevation(el_) {
  const T = pivotPoint(), r = camPos().sub(T), d = Math.max(r.length(), 1.5);
  outRig.az = Math.atan2(r.x, r.z); outRig.el = el_; outRig.dist = d; outRig.target.copy(T);
  mark(); autosaveSoon();
}
function lookBy(dYaw, dTilt) { rigLookBy(outRig, dYaw, dTilt); }
function setLook(yawDeg, tiltDeg) {
  const P = camPos();
  outRig.az = -yawDeg * D2R; outRig.el = clamp(-tiltDeg * D2R, -1.45, 1.45);
  outRig.target.copy(P).addScaledVector(dirVec(outRig.az, outRig.el), -outRig.dist);
  mark(); autosaveSoon();
}
$('#camYaw').addEventListener('input', e => setLook(+e.target.value, -outRig.el / D2R));
$('#camTilt').addEventListener('input', e => setLook(-outRig.az / D2R, +e.target.value));
$('#camRoll').addEventListener('input', e => { out.roll = +e.target.value * D2R; mark(); autosaveSoon(); });
$('#rollReset').onclick = () => { out.roll = 0; mark(); autosaveSoon(); };
$('#lookSel').onclick = () => {
  const T = pivotPoint(), P = camPos(), v = P.clone().sub(T), d = Math.max(v.length(), 0.6); v.normalize();
  outRig.az = Math.atan2(v.x, v.z); outRig.el = clamp(Math.asin(v.y), -1.45, 1.45); outRig.dist = d;
  outRig.target.copy(P).addScaledVector(dirVec(outRig.az, outRig.el), -d);
  mark(); autosaveSoon();
};
$('#modeBar').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { modes[view.mode] = b.dataset.t; updateHud(); }));
function moveCamKey(k, step) {
  syncCams();
  const f = outCam.getWorldDirection(V3()); f.y = 0; if (f.lengthSq() < 1e-6) f.set(0, 0, -1); f.normalize();
  const r = V3().crossVectors(f, V3(0, 1, 0)).normalize(), d = V3();
  if (k === 'w') d.addScaledVector(f, step); if (k === 's') d.addScaledVector(f, -step);
  if (k === 'd') d.addScaledVector(r, step); if (k === 'a') d.addScaledVector(r, -step);
  if (k === 'e') d.y += step; if (k === 'q') d.y -= step;
  outRig.target.add(d); mark(); autosaveSoon();
}

// 단축키
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#dlg').hidden) { closeDialog(); return; } // 입력칸에 포커스가 있어도 공유 창은 Esc로 닫힘
  if (e.code === 'Space' && !blocksSpacePan(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); spacePan = true; if (!drag) stage.style.cursor = 'grab'; return;
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (!mod && view.mode === 'cam' && k.startsWith('arrow') && e.target.tagName !== 'INPUT') {
    e.preventDefault(); const st = (e.shiftKey ? 8 : 2) * D2R;
    lookBy(k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, k === 'arrowup' ? st : k === 'arrowdown' ? -st : 0);
  }
  else if (!mod && view.mode === 'cam' && (k === 'z' || k === 'x')) {
    out.roll = clamp(out.roll + (k === 'x' ? 1 : -1) * (e.shiftKey ? 5 : 1) * D2R, -0.8, 0.8); mark(); autosaveSoon();
  }
  else if (!mod && view.mode === 'cam' && k.length === 1 && 'wasdqe'.includes(k)) { e.preventDefault(); moveCamKey(k, e.shiftKey ? 0.45 : 0.12); }
  else if (!mod && k === 'tab') { e.preventDefault(); setView(view.mode === 'work' ? 'cam' : 'work'); }
  else if (!mod && k === 'r') { modes[view.mode] = modes[view.mode] === 'look' ? 'orbit' : 'look'; updateHud(); toast(modes[view.mode] === 'look' ? '드래그 = 제자리 회전' : '드래그 = 대상 중심 회전', 1400); }
  else if (!mod && k === 'c') capture('copy');
  else if (!mod && k === 'p') capture('png');
  else if ((k === 'delete' || k === 'backspace') && !mod && selProp() && e.target.tagName !== 'INPUT') { e.preventDefault(); deleteProp(); }
  else if (k === 'escape') { if (!$('#dlg').hidden) { closeDialog(); return; } sel.j = null; sel.p = null; syncPanel(); mark(); }
});

window.addEventListener('keyup', e => {
  if (e.code !== 'Space' || !spacePan) return;
  spacePan = false;
  if (!drag) stage.style.cursor = '';
});
window.addEventListener('blur', () => {
  spacePan = false;
  if (!drag) stage.style.cursor = '';
});

// ------------------------------------------------------------
// 시작
// ------------------------------------------------------------
(function boot() {
  // 새로고침/재진입은 항상 기본 씬으로 시작한다. 사용자가 저장한 포즈/씬 라이브러리는 별도 저장소라 그대로 유지된다.
  setProps([]);
  setChars([{ ...defaultChar(), name: 'A' }]);
  commit(); setView('work'); syncPanel(); mark();
  setTimeout(renderSaved, 60);
  setTimeout(handleShareHash, 220);
})();

// 테스트와 디버깅용 진입점
window.PoseBlock = {
  chars: () => chars, getFull, setFull, setView, capture, undo, redo, render, selectJoint, selectChar,
  solveTwoBone, rotateJointWorld, DEFS, outSize, renderOutput, poseThumb, sceneThumb, workRig, outRig, out,
  sel, hist, lists, toScreen, setRay, pick, PRESETS, applyPresetTo, footMinY, groundChar, camPos, presetThumbs, dirVec, lookBy, setLook, outCam, modes, pivotPoint, feetYaw, chestYaw, alignLegs, faceTowards, commit, openShare, packShare, unpackShare, handleShareHash, props: () => props, addProp, selectProp, selProp, deleteProp, PROP_TYPES, propThumbs, applyProp, disp, applyDisplayAll,
};
})();
