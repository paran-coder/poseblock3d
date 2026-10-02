#!/usr/bin/env python3
"""PoseBlock 3D 에셋 정적 WebP 썸네일 일괄 생성기.

js/app.js의 PROP_TYPES를 scripts/dump-prop-geometry.mjs로 읽어 실제 에셋 프리미티브를 추출한 뒤,
에셋별 대표 카메라 각도/확대 비율로 192x192 WebP를 생성합니다.

사용법: python scripts/generate-thumbnails.py
"""
from __future__ import annotations
import io, json, math, subprocess
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import trimesh

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'thumbs'
SIZE = 192
BG = '#e9ecf0'
DARK = '#343a40'

# (elevation, azimuth, zoom). zoom > 1 = 더 크게 보임.
VIEWS = {
    'box': (24, -42, 1.10), 'chair': (22, -42, 1.06), 'table': (24, -42, 1.04),
    'sofa': (20, -42, 1.05), 'bed': (28, -38, 1.00), 'stairs': (26, -38, 1.02),
    'wall': (18, -33, 0.95), 'pillar': (16, -35, 0.98), 'ball': (20, -40, 1.18),
    'dog': (15, -48, 1.10), 'cat': (14, -48, 1.10), 'horse': (13, -48, 1.03),
    'bird': (18, -45, 1.12), 'tiger': (14, -48, 1.04), 'dragon': (22, -38, 0.93),
    'turtle': (20, -48, 1.12), 'snake': (38, -52, 1.12),
    'car': (18, -42, 1.02), 'bicycle': (15, -42, 1.08), 'motorcycle': (15, -42, 1.08),
    'bus': (18, -38, 0.98), 'truck': (18, -40, 0.98), 'boat': (20, -42, 1.04),
    'airplane': (26, -42, 0.98),
}


def hex_rgb(s: str) -> np.ndarray:
    s = s.lstrip('#')
    return np.array([int(s[i:i+2], 16) / 255 for i in (0, 2, 4)], dtype=float)


def rot_x(a):
    c,s=math.cos(a),math.sin(a); return np.array([[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]],float)
def rot_y(a):
    c,s=math.cos(a),math.sin(a); return np.array([[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]],float)
def rot_z(a):
    c,s=math.cos(a),math.sin(a); return np.array([[c,-s,0,0],[s,c,0,0],[0,0,1,0],[0,0,0,1]],float)


def align_y_to(vec):
    a=np.array([0.,1.,0.]); b=np.array(vec,float)
    n=np.linalg.norm(b)
    if n < 1e-9: return np.eye(4)
    b/=n; v=np.cross(a,b); c=float(np.dot(a,b))
    if c > 0.999999: return np.eye(4)
    if c < -0.999999: return rot_x(math.pi)
    s=np.linalg.norm(v)
    vx=np.array([[0,-v[2],v[1]],[v[2],0,-v[0]],[-v[1],v[0],0]],float)
    R=np.eye(3)+vx+vx@vx*((1-c)/(s*s))
    M=np.eye(4); M[:3,:3]=R; return M


def make_mesh(item):
    p=item['params']; g=item['geometry']
    if g=='box': mesh=trimesh.creation.box(extents=[p['w'],p['h'],p['d']])
    elif g=='cylinder':
        mesh=trimesh.creation.cylinder(radius=p['rt'], height=p['h'], sections=max(12,int(p.get('seg',16))))
        mesh.apply_transform(rot_x(-math.pi/2))  # trimesh Z축 → Three.js CylinderGeometry Y축
    elif g=='sphere': mesh=trimesh.creation.icosphere(subdivisions=2, radius=p['r'])
    elif g=='cone':
        mesh=trimesh.creation.cone(radius=p['r'], height=p['h'], sections=max(12,int(p.get('seg',16))))
        mesh.apply_transform(rot_x(-math.pi/2))  # trimesh Z축 → Three.js ConeGeometry Y축
    elif g=='torus':
        try:
            mesh=trimesh.creation.torus(major_radius=p['r'], minor_radius=p['tube'], major_sections=max(20,int(p.get('ts',28))), minor_sections=max(8,int(p.get('rs',10))))
        except TypeError:
            mesh=trimesh.creation.torus(p['r'], p['tube'])
    else: raise ValueError(g)
    sx,sy,sz=item['scale']; S=np.diag([sx,sy,sz,1.0])
    rx,ry,rz=item['rotation']
    qto=np.array(item['quaternion']['to'],float)
    if np.linalg.norm(qto-np.array([0.,1.,0.])) > 1e-6:
        R=align_y_to(qto)
    else:
        R=rot_z(rz)@rot_y(ry)@rot_x(rx)
    T=np.eye(4); T[:3,3]=np.array(item['position'],float)
    mesh.apply_transform(T@R@S)
    return mesh


def shade_faces(mesh, base):
    n=mesh.face_normals
    light=np.array([-0.35,0.72,0.55]); light/=np.linalg.norm(light)
    d=np.clip(n@light,0,1)
    strength=0.60+0.40*d
    rgb=np.clip(base[None,:]*strength[:,None]+0.035,0,1)
    return np.c_[rgb, np.ones(len(rgb))]


def render_asset(type_id, asset):
    parts=[]
    for item in asset['items']:
        mesh=make_mesh(item)
        base=hex_rgb(DARK if item['material']=='dark' else asset['color'])
        parts.append((mesh,base))
    # Matplotlib은 z축을 화면의 수직축으로 다루므로 앱 좌표 (x,y,z)를 (x,z,y)로 바꿔 그린다.
    allv=np.vstack([m.vertices[:, [0,2,1]] for m,_ in parts])
    lo=allv.min(axis=0); hi=allv.max(axis=0); ctr=(lo+hi)/2; size=hi-lo
    elev,azim,zoom=VIEWS.get(type_id,(22,-42,1.0))
    span=max(size.max(),0.25)/zoom
    # 세로로 긴 물체는 카드 안에서 너무 작아지지 않도록 여유를 약간 줄인다.
    span*=1.12

    fig=plt.figure(figsize=(SIZE/100,SIZE/100),dpi=100,facecolor=BG)
    ax=fig.add_axes([0,0,1,1],projection='3d',facecolor=BG)
    for mesh,base in parts:
        verts=mesh.vertices[:, [0,2,1]][mesh.faces]
        coll=Poly3DCollection(verts, facecolors=shade_faces(mesh,base), edgecolors=(0,0,0,0.10), linewidths=0.22)
        ax.add_collection3d(coll)
    # y가 화면 세로축으로 자연스럽게 보이게 xyz 그대로 사용.
    ax.set_xlim(ctr[0]-span/2,ctr[0]+span/2)
    ax.set_ylim(ctr[1]-span/2,ctr[1]+span/2)
    ax.set_zlim(ctr[2]-span/2,ctr[2]+span/2)
    ax.set_box_aspect((1,1,1)); ax.set_proj_type('ortho'); ax.view_init(elev=elev,azim=azim)
    ax.set_axis_off(); ax.grid(False)
    fig.canvas.draw()
    rgba=np.asarray(fig.canvas.buffer_rgba()).copy(); plt.close(fig)
    im=Image.fromarray(rgba,'RGBA').convert('RGB')
    return im


def main():
    raw=subprocess.check_output(['node', str(ROOT/'scripts/dump-prop-geometry.mjs')], cwd=ROOT)
    data=json.loads(raw)
    OUT.mkdir(parents=True,exist_ok=True)
    order=data['categories']['basic']+data['categories']['animal']+data['categories']['vehicle']
    for type_id in order:
        im=render_asset(type_id,data['assets'][type_id])
        im.save(OUT/f'{type_id}.webp','WEBP',quality=84,method=6)
        print(f'generated {type_id}.webp')
    # 검수용 연락 시트도 scripts 아래에 생성(배포 에셋으로 사용하지 않음).
    cols=6; rows=math.ceil(len(order)/cols); cell=SIZE+28
    sheet=Image.new('RGB',(cols*SIZE,rows*cell),'white')
    draw=ImageDraw.Draw(sheet)
    for i,type_id in enumerate(order):
        x=(i%cols)*SIZE; y=(i//cols)*cell
        sheet.paste(Image.open(OUT/f'{type_id}.webp').convert('RGB'),(x,y))
        draw.text((x+6,y+SIZE+5),f"{data['assets'][type_id]['name']} ({type_id})",fill='#222')
    sheet.save(ROOT/'scripts/thumbnail-contact-sheet.png')
    print(f'완료: {len(order)}개 WebP → {OUT}')

if __name__=='__main__': main()
