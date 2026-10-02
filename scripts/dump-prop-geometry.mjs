import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js/app.js'), 'utf8');
const start = src.indexOf('const PROP_COLORS =');
const end = src.indexOf('let propCategory =', start);
if (start < 0 || end < 0) throw new Error('app.js에서 에셋 정의 블록을 찾지 못했습니다.');
const defs = src.slice(start, end);

class Vec3 {
  constructor(x=0,y=0,z=0){ this.x=x; this.y=y; this.z=z; }
  set(x,y,z){ this.x=x; this.y=y; this.z=z; return this; }
  clone(){ return new Vec3(this.x,this.y,this.z); }
  copy(v){ this.x=v.x; this.y=v.y; this.z=v.z; return this; }
  sub(v){ this.x-=v.x; this.y-=v.y; this.z-=v.z; return this; }
  add(v){ this.x+=v.x; this.y+=v.y; this.z+=v.z; return this; }
  multiplyScalar(s){ this.x*=s; this.y*=s; this.z*=s; return this; }
  length(){ return Math.hypot(this.x,this.y,this.z); }
  normalize(){ const l=this.length()||1; return this.multiplyScalar(1/l); }
  toArray(){ return [this.x,this.y,this.z]; }
}
class Euler {
  constructor(){ this.x=0; this.y=0; this.z=0; }
  set(x=0,y=0,z=0){ this.x=x; this.y=y; this.z=z; return this; }
  toArray(){ return [this.x,this.y,this.z]; }
}
class Scale extends Vec3 { constructor(){ super(1,1,1); } }
class Quat {
  constructor(){ this.from=[0,1,0]; this.to=[0,1,0]; }
  setFromUnitVectors(a,b){ this.from=a.toArray(); this.to=b.toArray(); return this; }
}
class Geometry { constructor(type, params){ this.type=type; this.params=params; } }
class BoxGeometry extends Geometry { constructor(w,h,d){ super('box',{w,h,d}); } }
class CylinderGeometry extends Geometry { constructor(rt,rb,h,seg=16){ super('cylinder',{rt,rb,h,seg}); } }
class SphereGeometry extends Geometry { constructor(r,ws=20,hs=14){ super('sphere',{r,ws,hs}); } }
class ConeGeometry extends Geometry { constructor(r,h,seg=16){ super('cone',{r,h,seg}); } }
class TorusGeometry extends Geometry { constructor(r,tube,rs=10,ts=28){ super('torus',{r,tube,rs,ts}); } }
class Mesh {
  constructor(geometry, material){ this.geometry=geometry; this.material=material; this.position=new Vec3(); this.rotation=new Euler(); this.scale=new Scale(); this.quaternion=new Quat(); }
}
const THREE={Mesh,BoxGeometry,CylinderGeometry,SphereGeometry,ConeGeometry,TorusGeometry};
const context={THREE, Math, V3:(x=0,y=0,z=0)=>new Vec3(x,y,z)};
vm.createContext(context);
vm.runInContext(`${defs}\nglobalThis.__PB={PROP_TYPES,PROP_CATEGORIES};`, context);
const {PROP_TYPES, PROP_CATEGORIES}=context.__PB;
const out={categories:PROP_CATEGORIES, assets:{}};
for (const [type,T] of Object.entries(PROP_TYPES)) {
  const main={kind:'main'}, dark={kind:'dark'};
  const items=T.build(main,dark).map(o=>({
    geometry:o.geometry.type,
    params:o.geometry.params,
    material:o.material?.kind || 'main',
    position:o.position.toArray(),
    rotation:o.rotation.toArray(),
    scale:o.scale.toArray(),
    quaternion:{from:o.quaternion.from,to:o.quaternion.to},
  }));
  out.assets[type]={name:T.name,color:T.color,items};
}
process.stdout.write(JSON.stringify(out));
