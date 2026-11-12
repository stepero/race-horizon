import * as THREE from 'three';
import { CAR_MODEL_BY_ID } from '../data/catalog';
import type { Racer } from '../sim/race';

/**
 * Dočasné procedurálne modely áut (`placeholder: true` v katalógu).
 * Licencovaný model sa pripojí tak, že v katalógu nastavíš `modelUrl` a v `buildCar` vrátiš
 * načítanú scénu so skupinami pomenovanými `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr`
 * (viď PLACEHOLDER_NODES) – poškodenie a animácia kolies potom fungujú bez ďalších zmien.
 */
export const PLACEHOLDER_NODES = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr', 'frontWing', 'rearWing', 'sideL', 'sideR', 'cockpit'] as const;

export interface CarView {
  group: THREE.Group;
  wheels: { fl: THREE.Group; fr: THREE.Group; rl: THREE.Group; rr: THREE.Group };
  frontWing: THREE.Object3D;
  rearWing: THREE.Object3D;
  sideL: THREE.Object3D;
  sideR: THREE.Object3D;
  cockpit: THREE.Group;
  bodyMats: THREE.MeshStandardMaterial[];
  baseColors: THREE.Color[];
  brakeGlow: THREE.MeshBasicMaterial;
  headlight: THREE.Object3D;
  spin: number;
  halfLen: number;
  eyeHeight: number;
  eyeForward: number;
}

const tyreMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.6, metalness: 0.3 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.35, metalness: 0.8 });
const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b1118, roughness: 0.1, metalness: 0.8 });

function box(w: number, h: number, l: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), mat); // dĺžka = x (smer jazdy), šírka = z
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function wheel(r: number, w: number): THREE.Group {
  const g = new THREE.Group();
  const spinG = new THREE.Group();
  spinG.name = 'spin';
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 20), tyreMat);
  tyre.rotation.x = Math.PI / 2;
  tyre.castShadow = true;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w * 1.02, 12), rimMat);
  rim.rotation.x = Math.PI / 2;
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(r * 1.1, r * 0.1, w * 1.05), darkMat);
  spinG.add(tyre, rim, spoke);
  g.add(spinG);
  return g;
}

export function buildCar(r: Racer): CarView {
  const cls = CAR_MODEL_BY_ID[r.modelId]?.cls ?? 'GT';
  const body = new THREE.MeshStandardMaterial({ color: r.color, roughness: 0.35, metalness: 0.45 });
  const accent = new THREE.MeshStandardMaterial({ color: r.color2, roughness: 0.4, metalness: 0.3 });
  const group = new THREE.Group();
  const bodyMats = [body, accent];
  const brakeGlow = new THREE.MeshBasicMaterial({ color: 0x300000 });
  let view: CarView;
  if (cls === 'F1') view = buildF1(group, body, accent, brakeGlow);
  else view = buildGT(group, body, accent, brakeGlow);
  view.bodyMats = bodyMats;
  view.baseColors = bodyMats.map((m) => m.color.clone());
  return view;
}

function emptyView(group: THREE.Group): CarView {
  return {
    group, wheels: { fl: new THREE.Group(), fr: new THREE.Group(), rl: new THREE.Group(), rr: new THREE.Group() },
    frontWing: new THREE.Group(), rearWing: new THREE.Group(), sideL: new THREE.Group(), sideR: new THREE.Group(),
    cockpit: new THREE.Group(), bodyMats: [], baseColors: [], brakeGlow: new THREE.MeshBasicMaterial(), headlight: new THREE.Group(),
    spin: 0, halfLen: 2.7, eyeHeight: 0.85, eyeForward: 0.1,
  };
}

function buildF1(group: THREE.Group, body: THREE.MeshStandardMaterial, accent: THREE.MeshStandardMaterial, brakeGlow: THREE.MeshBasicMaterial): CarView {
  const v = emptyView(group);
  v.brakeGlow = brakeGlow;
  const L = 5.4;
  // monokok + nos
  group.add(box(0.62, 0.34, 2.6, body, 0.1, 0.42, 0));
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.27, 1.9, 10), body);
  nose.rotation.z = Math.PI / 2; nose.position.set(2.0, 0.34, 0); nose.castShadow = true; group.add(nose);
  group.add(box(0.9, 0.22, 1.6, body, -0.6, 0.38, 0)); // airbox/engine cover
  const engine = box(0.5, 0.42, 1.4, body, -1.55, 0.5, 0); group.add(engine);
  // bočnice
  const sideL = box(0.42, 0.34, 1.7, body, 0.05, 0.36, -0.62);
  const sideR = box(0.42, 0.34, 1.7, body, 0.05, 0.36, 0.62);
  group.add(sideL, sideR);
  v.sideL = sideL; v.sideR = sideR;
  // predné krídlo
  const fw = new THREE.Group();
  fw.add(box(2.0, 0.05, 0.45, accent, 0, 0, 0), box(0.06, 0.2, 0.45, accent, 0, 0.1, 0.98), box(0.06, 0.2, 0.45, accent, 0, 0.1, -0.98));
  fw.position.set(2.85, 0.14, 0); group.add(fw); v.frontWing = fw;
  // zadné krídlo
  const rw = new THREE.Group();
  rw.add(box(1.6, 0.06, 0.5, accent, 0, 0.35, 0), box(0.05, 0.62, 0.5, accent, 0, 0.1, 0.8), box(0.05, 0.62, 0.5, accent, 0, 0.1, -0.8));
  rw.add(box(0.5, 0.35, 0.1, darkMat, 0, 0, 0));
  rw.position.set(-2.55, 0.55, 0); group.add(rw); v.rearWing = rw;
  const light = box(0.25, 0.1, 0.05, brakeGlow, -2.82, 0.55, 0);
  group.add(light);
  // kokpit
  const cockpit = new THREE.Group();
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.3 }));
  helmet.position.set(0.1, 0.72, 0); helmet.castShadow = true;
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.025, 6, 16, Math.PI), darkMat);
  halo.rotation.set(Math.PI / 2, 0, -Math.PI / 2); halo.position.set(0.35, 0.78, 0);
  const sw = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.32), darkMat);
  sw.position.set(0.9, 0.5, 0); sw.rotation.z = -0.9; sw.scale.set(1, 0.6, 0.8);
  cockpit.add(helmet, halo);
  v.cockpit = cockpit; group.add(cockpit);
  group.add(sw);
  // kolesá
  const wr = 0.36, ww = 0.4;
  const mk = (x: number, z: number, wdt: number) => { const w = wheel(wr, wdt); w.position.set(x, wr, z); group.add(w); return w; };
  v.wheels = { fl: mk(1.65, -0.92, ww), fr: mk(1.65, 0.92, ww), rl: mk(-1.7, -0.95, ww + 0.1), rr: mk(-1.7, 0.95, ww + 0.1) };
  group.add(box(0.1, 0.05, 1.4, darkMat, 0, 0.2, 0.0)); // podlaha
  v.halfLen = L / 2; v.eyeHeight = 1.06; v.eyeForward = 0.5;
  return v;
}

function buildGT(group: THREE.Group, body: THREE.MeshStandardMaterial, accent: THREE.MeshStandardMaterial, brakeGlow: THREE.MeshBasicMaterial): CarView {
  const v = emptyView(group);
  v.brakeGlow = brakeGlow;
  group.add(box(1.9, 0.5, 4.5, body, 0, 0.55, 0));
  const hood = box(1.8, 0.14, 1.5, body, 1.4, 0.82, 0); hood.rotation.z = -0.08; group.add(hood);
  const cabin = box(1.5, 0.48, 1.9, glassMat, -0.25, 1.05, 0); group.add(cabin);
  const roof = box(1.45, 0.06, 1.5, body, -0.25, 1.3, 0); group.add(roof);
  // bočné prahy
  const sideL = box(0.12, 0.2, 3.0, accent, 0, 0.32, -0.98);
  const sideR = box(0.12, 0.2, 3.0, accent, 0, 0.32, 0.98);
  group.add(sideL, sideR); v.sideL = sideL; v.sideR = sideR;
  // spredu rozdeľovač
  const fw = new THREE.Group(); fw.add(box(2.0, 0.08, 0.3, accent, 0, 0, 0)); fw.position.set(2.35, 0.28, 0); group.add(fw); v.frontWing = fw;
  // zadné krídlo
  const rw = new THREE.Group();
  rw.add(box(1.9, 0.06, 0.5, accent, 0, 0.5, 0), box(0.05, 0.5, 0.35, darkMat, 0, 0.22, 0.6), box(0.05, 0.5, 0.35, darkMat, 0, 0.22, -0.6));
  rw.position.set(-2.1, 0.95, 0); group.add(rw); v.rearWing = rw;
  group.add(box(1.2, 0.1, 0.05, brakeGlow, -2.27, 0.8, 0));
  // číslo na kapote (pruh)
  const stripe = box(0.5, 0.005, 1.6, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }), 1.4, 0.9, 0);
  stripe.castShadow = false; group.add(stripe);
  const cockpit = new THREE.Group(); v.cockpit = cockpit; group.add(cockpit);
  const wr = 0.35, ww = 0.32;
  const mk = (x: number, z: number) => { const w = wheel(wr, ww); w.position.set(x, wr, z); group.add(w); return w; };
  v.wheels = { fl: mk(1.4, -0.9), fr: mk(1.4, 0.9), rl: mk(-1.35, -0.92), rr: mk(-1.35, 0.92) };
  v.halfLen = 2.3; v.eyeHeight = 1.12; v.eyeForward = 0.05;
  return v;
}

/** Aktualizuje vzhľad podľa stavu: poškodenie (deformácie a zhnednutie) a kolesá. */
export function updateCar(v: CarView, r: Racer, dtDist: number): void {
  const st = r.st;
  v.spin += dtDist / 0.35;
  const spin = v.spin;
  for (const k of ['fl', 'fr', 'rl', 'rr'] as const) {
    const w = v.wheels[k];
    const sp = w.getObjectByName('spin');
    if (sp) sp.rotation.z = -spin; // os kolesa = z modelu
    if (k === 'fl' || k === 'fr') w.rotation.y = st.steer;
  }
  const [dF, dR, dL, dRt] = st.damage;
  // predné krídlo: zlomí sa a posunie
  v.frontWing.rotation.set(0, dF * 0.5, -dF * 0.4);
  v.frontWing.position.y = 0.14 - dF * 0.08;
  v.frontWing.visible = dF < 0.85;
  v.rearWing.rotation.set(dR * 0.25, 0, dR * 0.5);
  v.rearWing.visible = dR < 0.9;
  v.sideL.rotation.set(dL * 0.35, 0, 0);
  v.sideR.rotation.set(-dRt * 0.35, 0, 0);
  // zhnednutie lakovania podľa celkového poškodenia
  const tot = Math.max(dF, dR, dL, dRt);
  for (let i = 0; i < v.bodyMats.length; i++) {
    v.bodyMats[i].color.copy(v.baseColors[i]).lerp(DAMAGE_TINT, tot * 0.55);
    v.bodyMats[i].roughness = 0.35 + 0.5 * tot;
  }
  v.brakeGlow.color.setHex(st.brake > 0.1 ? 0xff1a1a : 0x300000);
}
const DAMAGE_TINT = new THREE.Color(0x2a2623);
