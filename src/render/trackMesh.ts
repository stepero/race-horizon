import * as THREE from 'three';
import { PIT_WIDTH, PIT_WALL, type Track } from '../sim/track';
import { mulberry32 } from '../sim/math';

/**
 * Súradnice: simulácia pracuje v rovine (x, y), svet Three.js je (x, výška, z) so z = -y.
 * Smer `h` v simulácii zodpovedá `rotation.y = h`.
 */
export const toWorld = (x: number, y: number, h = 0): THREE.Vector3 => new THREE.Vector3(x, h, -y);

export interface TrackView {
  group: THREE.Group;
  asphalt: THREE.MeshStandardMaterial;
  lights: THREE.MeshBasicMaterial[]; // 5 červených svetiel na štartovej bráne
  greens: THREE.MeshBasicMaterial[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

interface Ribbon { pos: number[]; uv: number[]; idx: number[]; col?: number[] }

function ribbon(): Ribbon { return { pos: [], uv: [], idx: [] }; }

/** Pridá pás medzi dvoma bočnými posunmi (a, b) pre úsek s ∈ [s0, s1]. */
function strip(track: Track, rb: Ribbon, s0: number, s1: number, latA: (s: number) => number, latB: (s: number) => number,
  lift: number, step = track.ds, colorFn?: (s: number) => [number, number, number]) {
  const startV = rb.pos.length / 3;
  let k = 0;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const h = track.height(s) + lift;
    const pa = track.at(s, latA(s)), pb = track.at(s, latB(s));
    rb.pos.push(pa.x, h, -pa.y, pb.x, h, -pb.y);
    rb.uv.push(0, s / 10, 1, s / 10);
    if (colorFn && rb.col) { const c = colorFn(s); rb.col.push(...c, ...c); }
    if (i > 0) {
      const a = startV + (k - 1) * 2, b = startV + k * 2;
      // orientácia: normála nahor
      rb.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    k++;
  }
}

function meshOf(rb: Ribbon, mat: THREE.Material, receive = true): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(rb.pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(rb.uv, 2));
  if (rb.col) g.setAttribute('color', new THREE.Float32BufferAttribute(rb.col, 3));
  g.setIndex(rb.idx);
  g.computeVertexNormals();
  // zaisti normály nahor (pás môže byť navinutý opačne podľa strany)
  const nrm = g.getAttribute('normal');
  let up = 0;
  for (let i = 0; i < nrm.count; i++) up += nrm.getY(i);
  if (up < 0) {
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) { const t = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, t); }
    g.computeVertexNormals();
  }
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = receive;
  return m;
}

function asphaltTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5a5d62';
  g.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(42);
  for (let i = 0; i < 9000; i++) {
    const v = 70 + rnd() * 50;
    g.fillStyle = `rgba(${v},${v},${v + 4},${0.35 + rnd() * 0.3})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
  // stopy gúm v ideálnej stope sú vo vertex farbách; tu len jemná textúra
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function grassTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4c7a37';
  g.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(7);
  for (let i = 0; i < 7000; i++) {
    const v = rnd();
    g.fillStyle = v < 0.5 ? `rgba(40,${90 + rnd() * 40},30,0.5)` : `rgba(${90 + rnd() * 30},${130 + rnd() * 30},60,0.35)`;
    g.fillRect(rnd() * 256, rnd() * 256, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(400, 400);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function buildTrack(track: Track, scene: THREE.Scene, opts: { world?: boolean } = {}): TrackView {
  const world = !!opts.world;
  const group = new THREE.Group();
  const d = track.d;
  const L = track.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < d.n; i++) {
    minX = Math.min(minX, d.x[i]); maxX = Math.max(maxX, d.x[i]); minY = Math.min(minY, d.y[i]); maxY = Math.max(maxY, d.y[i]);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY) + 1200;

  // --- tráva
  const grassTex = grassTexture();
  grassTex.repeat.set(span / 12, span / 12);
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(span, span), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(cx, -0.02, -cy);
  grass.receiveShadow = true;
  group.add(grass);

  // --- asfalt (s jemne tmavšou ideálnou stopou)
  const asphaltTex = asphaltTexture();
  asphaltTex.repeat.set(1, 1);
  const asphalt = new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.92, metalness: 0, vertexColors: true });
  const rb: Ribbon = { pos: [], uv: [], idx: [], col: [] };
  const W = 7; // počet pozdĺžnych pruhov pre farebnú stopu
  {
    const n = d.n;
    for (let i = 0; i <= n; i++) {
      const ss = i === n ? L : i * track.ds;
      const hw = track.halfWidths(ss);
      const line = track.lineOffset(ss);
      const h = track.height(ss) + 0.02;
      for (let k = 0; k <= W; k++) {
        const lat = -hw.wr + ((hw.wr + hw.wl) * k) / W;
        const p = track.at(ss, lat);
        rb.pos.push(p.x, h, -p.y);
        rb.uv.push((lat + 8) / 6, ss / 6);
        const rub = Math.exp(-((lat - line) ** 2) / 3.5);
        const c = 1 - 0.28 * rub;
        rb.col!.push(c, c, c * 0.99);
      }
      if (i > 0) {
        const r0 = (i - 1) * (W + 1), r1 = i * (W + 1);
        for (let k = 0; k < W; k++) rb.idx.push(r0 + k, r1 + k, r0 + k + 1, r0 + k + 1, r1 + k, r1 + k + 1);
      }
    }
  }
  group.add(meshOf(rb, asphalt));

  // --- obrubníky: červeno-biele v zákrutách, inak biela čiara
  const kerbRb: Ribbon = { pos: [], uv: [], idx: [], col: [] };
  const lineRb = ribbon();
  const kerbStep = 2.5;
  const isCorner = (s: number) => Math.abs(track.curvatureAt(s)) > 0.006 || Math.abs(track.curvatureAt(s + 15)) > 0.006 || Math.abs(track.curvatureAt(s - 15)) > 0.006;
  for (const side of [1, -1]) {
    const edge = (s: number) => { const hw = track.halfWidths(s); return side > 0 ? hw.wl : -hw.wr; };
    let runStart = -1;
    for (let s = 0; s <= L; s += kerbStep) {
      const c = isCorner(s) && track.pitWidthAt(s) < 0.5;
      if (c && runStart < 0) runStart = s;
      if ((!c || s + kerbStep > L) && runStart >= 0) {
        const s0 = runStart, s1 = s;
        strip(track, kerbRb, s0, s1, edge, (q) => edge(q) + side * 1.1, 0.045, 1.25,
          (q) => (Math.floor(q / 2.5) % 2 === 0 ? [0.85, 0.08, 0.08] : [0.95, 0.95, 0.95]));
        runStart = -1;
      }
    }
    strip(track, lineRb, 0, L, (q) => edge(q) - side * 0.35, (q) => edge(q) - side * 0.15, 0.03, 5);
  }
  group.add(meshOf(kerbRb, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })));
  const white = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  group.add(meshOf(lineRb, white));

  // --- únikové zóny (štrk/asfalt pruh za obrubníkom)
  const runRb = ribbon();
  for (const side of [1, -1]) {
    const edge = (s: number) => { const hw = track.halfWidths(s); return side > 0 ? hw.wl : -hw.wr; };
    strip(track, runRb, 0, L, (q) => edge(q) + side * 1.1, (q) => edge(q) + side * Math.min(4, d.runoff * 0.5) * (1 - track.pitBlend(q) * (side === d.pit.side ? 1 : 0)), 0.012, 5);
  }
  group.add(meshOf(runRb, new THREE.MeshStandardMaterial({ color: 0x8c8574, roughness: 1 })));

  // --- boxová ulička (len okruhy)
  const p = d.pit;
  const side = p.side;
  const pitRb = ribbon();
  const s0 = track.wrapS(p.sIn), sLen = p.sOut - p.sIn;
  const base = (s: number) => { const hw = track.halfWidths(s); return side > 0 ? hw.wl : hw.wr; };
  if (!world) {
    strip(track, pitRb, s0, s0 + sLen, (q) => side * base(q), (q) => side * (base(q) + track.pitWidthAt(q)), 0.018, 2.5);
    group.add(meshOf(pitRb, new THREE.MeshStandardMaterial({ color: 0x4a4c50, roughness: 0.85 })));
    // deliaca čiara medzi traťou a uličkou + boxy
    const pitLine = ribbon();
    strip(track, pitLine, s0 + 120, s0 + sLen - 120, (q) => side * (base(q) + 0.1), (q) => side * (base(q) + 0.35), 0.03, 4);
    group.add(meshOf(pitLine, white));
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xd8c25a, roughness: 0.6 });
    for (let slot = 0; slot < 32; slot++) {
      const bp = track.boxPosition(slot);
      const rel = track.rel(bp.s);
      if (rel > p.sOut - 130) break;
      const pt = track.at(bp.s, bp.lateral);
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 3.4), boxMat);
      frame.rotation.set(-Math.PI / 2, 0, pt.h);
      frame.position.set(pt.x, track.height(bp.s) + 0.03, -pt.y);
      group.add(frame);
    }
    // garáže
    const garMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ec, roughness: 0.7 });
    const garDark = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.8 });
    {
      const gs0 = p.boxFrom - 10, gs1 = Math.min(p.sOut - 130, p.boxFrom + 32 * p.boxSpacing);
      for (let s = gs0; s < gs1; s += 12) {
        const sm = s + 6;
        const pt = track.at(sm, side * (base(sm) + PIT_WIDTH + 2.5 + PIT_WALL + 6));
        const b = new THREE.Mesh(new THREE.BoxGeometry(11.6, 7, 11), garMat);
        b.rotation.y = pt.h;
        b.position.set(pt.x, track.height(sm) + 3.5, -pt.y);
        b.castShadow = true; b.receiveShadow = true;
        group.add(b);
        const door = new THREE.Mesh(new THREE.PlaneGeometry(9, 5), garDark);
        const dp = track.at(sm, side * (base(sm) + PIT_WIDTH + 2.5 + PIT_WALL + 0.45));
        door.position.set(dp.x, track.height(sm) + 2.5, -dp.y);
        door.rotation.y = pt.h + (side > 0 ? 0 : Math.PI);
        group.add(door);
      }
    }

  }

  // --- bariéry
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.6 });
  const wallTop = new THREE.MeshStandardMaterial({ color: 0x1d5fbf, roughness: 0.5 });
  for (const sd of [1, -1]) {
    const pos: number[] = [], idx: number[] = [];
    const posT: number[] = [], idxT: number[] = [];
    const step = 4;
    let k = 0;
    for (let s = 0; s <= L + 0.01; s += step) {
      const w = track.wallDist(s, sd) + 0.25;
      const pt = track.at(s, sd * w);
      const h = track.height(s);
      pos.push(pt.x, h, -pt.y, pt.x, h + 1.0, -pt.y);
      posT.push(pt.x, h + 1.0, -pt.y, pt.x, h + 1.25, -pt.y);
      if (k > 0) {
        const a = (k - 1) * 2, b = k * 2;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
        idxT.push(a, b, a + 1, a + 1, b, b + 1);
      }
      k++;
    }
    for (const [P, I, M] of [[pos, idx, wallMat], [posT, idxT, wallTop]] as const) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P as number[], 3));
      g.setIndex(I as number[]);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, (M as THREE.Material).clone());
      (m.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      m.castShadow = true; m.receiveShadow = true;
      group.add(m);
    }
  }

  // --- mosty (pilóre pod vyvýšenými úsekmi)
  const pillar = new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.8 });
  for (let s = 0; s < L; s += 12) {
    const h = track.height(s);
    if (h < 1.5) continue;
    for (const sd of [1, -1]) {
      const pt = track.at(s, sd * (track.halfWidths(s).wl + 0.6));
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.8, h, 0.8), pillar);
      c.position.set(pt.x, h / 2, -pt.y);
      group.add(c);
    }
    const under = track.at(s, 0);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(12.5, 0.6, 16), pillar);
    deck.rotation.y = under.h;
    deck.position.set(under.x, h - 0.3, -under.y);
    group.add(deck);
  }

  const lights: THREE.MeshBasicMaterial[] = [];
  const greens: THREE.MeshBasicMaterial[] = [];
  if (!world) {
    // --- štartová čiara (šachovnica)
    {
      const c = document.createElement('canvas'); c.width = 64; c.height = 16;
      const g = c.getContext('2d')!;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4'; g.fillRect(i * 4, j * 4, 4, 4); }
      const tex = new THREE.CanvasTexture(c); tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
      const hw = track.halfWidths(0);
      const pt = track.at(0, (hw.wl - hw.wr) / 2);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, hw.wl + hw.wr), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
      m.rotation.set(-Math.PI / 2, 0, pt.h);
      m.position.set(pt.x, track.height(0) + 0.035, -pt.y);
      group.add(m);
      // štartové boxy (rošt)
      for (let i = 0; i < 30; i++) {
        const sg = -6 - i * 8 + 1.2;
        const lat = i % 2 === 0 ? 2.3 : -2.3;
        const q = track.at(sg, lat);
        const mk = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 2.4), white);
        mk.rotation.set(-Math.PI / 2, 0, q.h);
        mk.position.set(q.x, track.height(sg) + 0.03, -q.y);
        group.add(mk);
      }
    }

    // --- štartová brána so svetlami
    {
      const hw = track.halfWidths(4);
      const span = hw.wl + hw.wr + 3;
      const mid = (hw.wl - hw.wr) / 2;
      const pt = track.at(4, mid);
      const gantry = new THREE.Group();
      const steel = new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.5, metalness: 0.6 });
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.3, span), steel);
      beam.position.y = 7;
      gantry.add(beam);
      for (const z of [-span / 2, span / 2]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), steel); post.position.set(0, 3.7, z); post.castShadow = true; gantry.add(post); }
      for (let i = 0; i < 5; i++) {
        for (const row of [0.3, -0.3]) {
          const mat = new THREE.MeshBasicMaterial({ color: 0x220404 });
          const l = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16), mat);
          l.position.set(-0.41, 7 + row, (i - 2) * 0.75);
          l.rotation.y = -Math.PI / 2;
          gantry.add(l);
          if (row > 0) lights.push(mat); else greens.push(mat);
        }
      }
      gantry.rotation.y = pt.h;
      gantry.position.set(pt.x, track.height(4), -pt.y);
      group.add(gantry);
    }

    // --- tribúny pri štartovej rovinke (na opačnej strane ako boxy)
    {
      const standMat = new THREE.MeshStandardMaterial({ color: 0x8e96a3, roughness: 0.8 });
      const seatMat = new THREE.MeshStandardMaterial({ color: 0x2f5fa8, roughness: 0.8 });
      for (let s = -180; s <= 180; s += 30) {
        const w = track.wallDist(s, -side) + 6;
        const pt = track.at(s, -side * w);
        const st = new THREE.Group();
        for (let k = 0; k < 5; k++) {
          const step = new THREE.Mesh(new THREE.BoxGeometry(26, 1, 2.2), k % 2 ? seatMat : standMat);
          step.position.set(0, 0.5 + k, -side * (k * 2.2));
          st.add(step);
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(27, 0.3, 13), standMat);
        roof.position.set(0, 8, -side * 4.5);
        st.add(roof);
        st.rotation.y = pt.h;
        st.position.set(pt.x, track.height(s), -pt.y);
        st.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        group.add(st);
      }
    }

  }

  // --- stromy (inštancované)
  {
    const rnd = mulberry32(d.n * 13 + 5);
    const TREES = world ? 3500 : 900;
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2.4, 6);
    const crownGeo = new THREE.ConeGeometry(2.4, 6.5, 7);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b4330, roughness: 1 }), TREES);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x2f5a2a, roughness: 1 }), TREES);
    crowns.castShadow = true;
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    const col = new THREE.Color();
    let cnt = 0;
    for (let tries = 0; tries < TREES * 5 && cnt < TREES; tries++) {
      const s = rnd() * L;
      const sd = rnd() < 0.5 ? 1 : -1;
      const off = track.wallDist(s, sd) + 10 + rnd() * (world ? 90 : 120);
      const pt = track.at(s, sd * off);
      const qq = track.query(pt.x, pt.y, -2);
      if (Math.abs(qq.d) < track.wallDist(qq.s, qq.d >= 0 ? 1 : -1) + 7) continue;
      const k = 0.7 + rnd() * 0.8;
      sc.set(k, k, k);
      ps.set(pt.x, 1.2 * k, -pt.y); m4.compose(ps, q4, sc); trunks.setMatrixAt(cnt, m4);
      ps.set(pt.x, (2.4 + 3.2) * k, -pt.y); m4.compose(ps, q4, sc); crowns.setMatrixAt(cnt, m4);
      col.setHSL(0.27 + rnd() * 0.06, 0.45, 0.22 + rnd() * 0.1);
      crowns.setColorAt(cnt, col);
      cnt++;
    }
    trunks.count = cnt; crowns.count = cnt;
    group.add(trunks, crowns);
  }

  scene.add(group);
  return { group, asphalt, lights, greens, bounds: { minX, maxX, minY, maxY } };
}
