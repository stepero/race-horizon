// Procedurálne generované otvorené svety: uzavretá cesta dlhá ~9–10 km, vytvorená v pamäti
// (nie v public/tracks). Výstup je TrackData, takže Track, AI, minimapa, kolízie aj kamera fungujú bez zmien.
// Tvar: deformovaná elipsa (Fourierove harmonické) so semenom; výška: pomalé kopce (periodické, spojité).
import type { TrackData } from './track';
import { mulberry32 } from './math';

/** Vzdialenosť bodov trate [m] (ako v build-tracks.mjs). */
const DS = 5;

export interface WorldSpec {
  id: string;
  name: string;
  seed: number;
  /** Polomery elipsy [m] – hrubá veľkosť mapy. */
  rx: number;
  ry: number;
  /** Výška kopcov [m] (0 = rovina). */
  hills: number;
  /** Polovica šírky vozovky [m]. */
  halfW: number;
  /** Šírka odstavnej plochy za okrajom, kým nasleduje bariéra [m]. */
  runoff: number;
}

/** Dva otvorené svety. Premávka sa zapína samostatne (režim sveta, nie samostatná mapa). */
export const WORLDS: WorldSpec[] = [
  { id: 'world-coast', name: 'Pobrežná magistrála', seed: 11, rx: 1750, ry: 1100, hills: 0, halfW: 8, runoff: 30 },
  { id: 'world-hills', name: 'Horské serpentíny', seed: 29, rx: 1550, ry: 1000, hills: 16, halfW: 7.5, runoff: 30 },
];

export const WORLD_BY_ID: Record<string, WorldSpec> = Object.fromEntries(WORLDS.map((w) => [w.id, w]));

type P2 = [number, number];

const hyp = Math.hypot;

export function pathLength(p: number[][]): number {
  let L = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    L += hyp(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

/** Rovnomerné pretransformovanie uzavretej krivky s bodmi [x, y, ...] na krok ds. */
export function resample(pts: number[][], ds: number): number[][] {
  const n = pts.length;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum.push(cum[i] + hyp(b[0] - a[0], b[1] - a[1]));
  }
  const L = cum[n];
  const m = Math.max(3, Math.round(L / ds));
  const step = L / m;
  const out: number[][] = [];
  let j = 0;
  for (let k = 0; k < m; k++) {
    const s = k * step;
    while (cum[j + 1] < s) j++;
    const a = pts[j % n], b = pts[(j + 1) % n];
    const t = (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1);
    out.push(a.map((v, c) => v + (b[c] - v) * t));
  }
  return out;
}

/** Vyhladenie 1-2-1 jadrom na vybraných stĺpcoch (uzavretá slučka). */
export function smooth(arr: number[][], passes: number, cols: number[]): number[][] {
  let cur = arr.map((r) => r.slice());
  for (let p = 0; p < passes; p++) {
    const nxt = cur.map((r) => r.slice());
    for (let i = 0; i < cur.length; i++) {
      const a = cur[(i - 1 + cur.length) % cur.length], b = cur[i], c = cur[(i + 1) % cur.length];
      for (const k of cols) nxt[i][k] = 0.25 * a[k] + 0.5 * b[k] + 0.25 * c[k];
    }
    cur = nxt;
  }
  return cur;
}

/** Centripetálny Catmull-Rom cez riadiace body (uzavretý). */
export function catmull(ctrl: P2[], perSeg: number): P2[] {
  const n = ctrl.length;
  const out: P2[] = [];
  const tj = (ti: number, a: P2, b: P2) => ti + Math.pow(hyp(b[0] - a[0], b[1] - a[1]), 0.5);
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    for (let k = 0; k < perSeg; k++) {
      const t = t1 + ((t2 - t1) * k) / perSeg;
      const L = (a: P2, b: P2, ta: number, tb: number): P2 => [
        ((tb - t) / (tb - ta)) * a[0] + ((t - ta) / (tb - ta)) * b[0],
        ((tb - t) / (tb - ta)) * a[1] + ((t - ta) / (tb - ta)) * b[1],
      ];
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      out.push(L(B1, B2, t1, t2));
    }
  }
  return out;
}

/** Páry segmentov, ktoré sa pretínajú (trať sa kríži sama so sebou). */
export function findCrossings(pts: number[][]): [number, number][] {
  const n = pts.length;
  const res: [number, number][] = [];
  const cr = (o: number[], p: number[], q: number[]) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const inter = (a: number[], b: number[], c: number[], d: number[]) =>
    cr(a, b, c) * cr(a, b, d) < 0 && cr(c, d, a) * cr(c, d, b) < 0;
  const gap = Math.round(80 / DS);
  for (let i = 0; i < n; i++) for (let j = i + gap; j < n; j++) {
    if (n - (j - i) < gap) continue;
    if (inter(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) res.push([i, j]);
  }
  return res;
}

/** Ako findCrossings, ale hľadá aj úseky, ktoré sa k sebe priblížia menej než minDist (bez pretnutia). */
export function selfIntersects(pts: number[][], minDist: number): [number, number] | null {
  const n = pts.length;
  const gap = Math.round(120 / DS);
  for (let i = 0; i < n; i += 2) for (let j = i + gap; j < n; j += 2) {
    if (n - (j - i) < gap) continue;
    if (hyp(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < minDist) return [i, j];
  }
  return null;
}

/** Riadiace body deformovanej elipsy. Harmonické zvlnenie je malé, aby sa cesta nepretla. */
function controlPoints(spec: WorldSpec, rnd: () => number): P2[] {
  const N = 16;
  const harm = [2, 3, 5].map((k) => ({ k, a: (0.04 + rnd() * 0.06) / (k * 0.6), ph: rnd() * Math.PI * 2 }));
  const pts: P2[] = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    let r = 1;
    for (const h of harm) r += h.a * Math.cos(h.k * th + h.ph);
    pts.push([spec.rx * r * Math.cos(th), spec.ry * r * Math.sin(th)]);
  }
  return pts;
}

/**
 * Postaví TrackData pre svet. Pri neúspechu (pretnutie / priblíženie) skúsi ďalšiu variantu tvaru.
 * Výsledok je deterministický pre dané semeno.
 */
export function buildWorldTrack(spec: WorldSpec): TrackData {
  const minDist = spec.halfW * 2 + 14;
  for (let attempt = 0; attempt < 40; attempt++) {
    const rnd = mulberry32(spec.seed * 7919 + attempt * 104729);
    const ctrl = controlPoints(spec, rnd);
    const dense = catmull(ctrl, 24).map(([x, y]) => [x, y, spec.halfW, spec.halfW]);
    let pts = resample(dense, DS);
    pts = smooth(pts, 3, [0, 1]);
    pts = resample(pts, DS);
    if (findCrossings(pts).length || selfIntersects(pts, minDist)) continue;

    const n = pts.length;
    const L = pathLength(pts);
    const ds = L / n;
    // kopce: súčet periodických sínusov so celočíselnými frekvenciami → spojitý uzáver slučky
    const phA = rnd() * Math.PI * 2, phB = rnd() * Math.PI * 2;
    const z = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const u = (i / n) * Math.PI * 2;
      z[i] = spec.hills * (0.6 * Math.sin(3 * u + phA) + 0.4 * Math.sin(5 * u + phB));
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      id: spec.id,
      ds,
      length: n * ds,
      placeholder: true,
      fictional: true,
      n,
      x: pts.map((p) => r2(p[0])),
      y: pts.map((p) => r2(p[1])),
      wr: pts.map((p) => r2(p[2])),
      wl: pts.map((p) => r2(p[3])),
      line: new Array<number>(n).fill(0),
      z: z.map(r2),
      runoff: spec.runoff,
      // Boxy sú pre svet vypnuté: pit-lane je mimo dosahu (sIn/sOut ďaleko za trasou).
      pit: { sIn: 1e6, sOut: 1e6 + 1, boxFrom: 1e6, boxSpacing: 9.5, side: 1 },
    };
  }
  throw new Error(`worldMap: nepodarilo sa vygenerovať svet ${spec.id}`);
}
