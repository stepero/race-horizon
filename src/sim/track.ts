import { clamp, smoothstep, wrapPi } from './math';

export interface TrackData {
  id: string;
  ds: number;
  length: number;
  placeholder: boolean;
  fictional?: boolean;
  n: number;
  x: number[];
  y: number[];
  wr: number[];
  wl: number[];
  line: number[];
  z: number[];
  runoff: number;
  pit: { sIn: number; sOut: number; boxFrom: number; boxSpacing: number; side: number };
}

export type Surface = 'asphalt' | 'kerb' | 'pit' | 'grass' | 'wall';

export interface TrackQuery {
  i: number; // index segmentu
  s: number; // vzdialenosť pozdĺž trate [m]
  d: number; // bočný posun od osi (kladný = vľavo) [m]
  heading: number; // smer trate
  surface: Surface;
  edge: number; // vzdialenosť za okrajom trate (0 ak je na trati)
  wallPen: number; // hĺbka prieniku do bariéry (>0 = kolízia)
  wallNormal: number; // znamienko bočného smeru, ktorým treba auto odtlačiť (+1 doľava)
}

export const PIT_WIDTH = 14; // šírka boxovej uličky
export const PIT_LIMIT = 22; // m/s (~80 km/h)
export const PIT_WALL = 1; // vzdialenosť steny za boxovou uličkou

export class Track {
  readonly d: TrackData;
  readonly n: number;
  readonly ds: number;
  readonly length: number;
  readonly hd: Float64Array;
  readonly curv: Float64Array;
  /** Zakrivenie ideálnej stopy (pre plánovanie rýchlosti AI). */
  readonly lineCurv: Float64Array;
  private lastI = 0;

  constructor(d: TrackData) {
    this.d = d;
    this.n = d.n;
    this.length = d.length;
    this.ds = d.length / d.n;
    this.hd = new Float64Array(d.n);
    this.curv = new Float64Array(d.n);
    for (let i = 0; i < d.n; i++) {
      const a = (i - 1 + d.n) % d.n, b = (i + 1) % d.n;
      this.hd[i] = Math.atan2(d.y[b] - d.y[a], d.x[b] - d.x[a]);
    }
    for (let i = 0; i < d.n; i++) {
      const a = (i - 2 + d.n) % d.n, b = (i + 2) % d.n;
      this.curv[i] = wrapPi(this.hd[b] - this.hd[a]) / (4 * this.ds);
    }
    // ideálna stopa: body, smer a zakrivenie
    const lx = new Float64Array(d.n), ly = new Float64Array(d.n);
    for (let i = 0; i < d.n; i++) { lx[i] = d.x[i] - Math.sin(this.hd[i]) * d.line[i]; ly[i] = d.y[i] + Math.cos(this.hd[i]) * d.line[i]; }
    this.lineCurv = new Float64Array(d.n);
    const K = 3;
    for (let i = 0; i < d.n; i++) {
      const a = (i - K + d.n) % d.n, m = i, b = (i + K) % d.n;
      const h1 = Math.atan2(ly[m] - ly[a], lx[m] - lx[a]), h2 = Math.atan2(ly[b] - ly[m], lx[b] - lx[m]);
      const len = Math.hypot(lx[m] - lx[a], ly[m] - ly[a]) + Math.hypot(lx[b] - lx[m], ly[b] - ly[m]);
      this.lineCurv[i] = wrapPi(h2 - h1) / (len / 2 || 1);
    }
    // jemné vyhladenie, ponechaj maximum
    const tmp = Float64Array.from(this.lineCurv);
    for (let i = 0; i < d.n; i++) {
      let mx = 0;
      for (let k = -2; k <= 2; k++) { const v = tmp[(i + k + d.n) % d.n]; if (Math.abs(v) > Math.abs(mx)) mx = v; }
      this.lineCurv[i] = mx;
    }
  }

  static async load(id: string): Promise<Track> {
    const res = await fetch(`${import.meta.env.BASE_URL}tracks/${id}.json`);
    if (!res.ok) throw new Error(`Trať ${id} sa nepodarilo načítať`);
    return new Track((await res.json()) as TrackData);
  }

  wrapS(s: number): number {
    s %= this.length;
    return s < 0 ? s + this.length : s;
  }
  idx(s: number): number {
    return Math.floor(this.wrapS(s) / this.ds) % this.n;
  }

  /** Bod osi trate v svetových súradniciach (interpolovaný). */
  pointAt(s: number): { x: number; y: number; h: number; i: number } {
    const w = this.wrapS(s) / this.ds;
    const i = Math.floor(w) % this.n, j = (i + 1) % this.n, f = w - Math.floor(w);
    const d = this.d;
    return {
      x: d.x[i] + (d.x[j] - d.x[i]) * f, y: d.y[i] + (d.y[j] - d.y[i]) * f,
      h: this.hd[i] + wrapPi(this.hd[j] - this.hd[i]) * f, i,
    };
  }
  at(s: number, lateral: number): { x: number; y: number; h: number } {
    const p = this.pointAt(s);
    return { x: p.x - Math.sin(p.h) * lateral, y: p.y + Math.cos(p.h) * lateral, h: p.h };
  }
  halfWidths(s: number): { wr: number; wl: number } {
    const w = this.wrapS(s) / this.ds;
    const i = Math.floor(w) % this.n, j = (i + 1) % this.n, f = w - Math.floor(w);
    return { wr: this.d.wr[i] + (this.d.wr[j] - this.d.wr[i]) * f, wl: this.d.wl[i] + (this.d.wl[j] - this.d.wl[i]) * f };
  }
  lineOffset(s: number): number {
    const w = this.wrapS(s) / this.ds;
    const i = Math.floor(w) % this.n, j = (i + 1) % this.n, f = w - Math.floor(w);
    return this.d.line[i] + (this.d.line[j] - this.d.line[i]) * f;
  }
  curvatureAt(s: number): number {
    return this.curv[this.idx(s)];
  }
  lineCurvatureAt(s: number): number {
    return this.lineCurv[this.idx(s)];
  }
  height(s: number): number {
    const w = this.wrapS(s) / this.ds;
    const i = Math.floor(w) % this.n, j = (i + 1) % this.n, f = w - Math.floor(w);
    return this.d.z[i] + (this.d.z[j] - this.d.z[i]) * f;
  }

  // ---------------- boxy ----------------
  /** Relatívna poloha voči štartovej čiare v rozsahu (-L/2, L/2]. */
  rel(s: number): number {
    const w = this.wrapS(s);
    return w > this.length / 2 ? w - this.length : w;
  }
  /** 0..1 – ako ďaleko je boxová ulička rozvinutá (0 = mimo úseku boxov). */
  pitBlend(s: number): number {
    const p = this.d.pit;
    const r = this.rel(s);
    if (r < p.sIn || r > p.sOut) return 0;
    return smoothstep(p.sIn, p.sIn + 120, r) * (1 - smoothstep(p.sOut - 120, p.sOut, r));
  }
  /** Šírka boxovej uličky (od okraja asfaltu) pri danej s. */
  pitWidthAt(s: number): number {
    return this.pitBlend(s) * (PIT_WIDTH + 2.5);
  }
  /** Bočný posun stredu boxovej uličky od osi trate. */
  pitCenter(s: number): number {
    const side = this.d.pit.side;
    const hw = this.halfWidths(s);
    const base = side < 0 ? hw.wr : hw.wl;
    return side * (base + this.pitWidthAt(s) / 2);
  }
  /** Bočný posun jazdného pruhu uličky (blízko trate) – kadiaľ prechádzajú autá bez zastavenia. */
  pitFastLane(s: number): number {
    const side = this.d.pit.side;
    const hw = this.halfWidths(s);
    const base = side < 0 ? hw.wr : hw.wl;
    return side * (base + Math.min(this.pitWidthAt(s) * 0.5, 4.5));
  }
  /** Poloha servisného boxu pre dané poradové číslo. */
  boxPosition(slot: number): { s: number; lateral: number } {
    const p = this.d.pit;
    const s = this.wrapS(p.boxFrom + slot * p.boxSpacing);
    const hw = this.halfWidths(s);
    const base = p.side < 0 ? hw.wr : hw.wl;
    return { s, lateral: p.side * (base + PIT_WIDTH + 2.5 - 3.2) };
  }
  inPitLane(q: { s: number; d: number }): boolean {
    const w = this.pitWidthAt(q.s);
    if (w < 0.5) return false;
    const hw = this.halfWidths(q.s);
    const side = this.d.pit.side;
    const base = side < 0 ? hw.wr : hw.wl;
    const o = side * q.d - base;
    return o > -0.3 && o < w;
  }
  inPitSpeedZone(q: { s: number; d: number }): boolean {
    return this.pitBlend(q.s) > 0.6 && this.inPitLane(q);
  }

  /** Vzdialenosť bariéry od osi trate na danej strane (+1 vľavo, -1 vpravo). */
  wallDist(s: number, side: number): number {
    const hw = this.halfWidths(s);
    const edgeW = side > 0 ? hw.wl : hw.wr;
    const blend = side === this.d.pit.side ? this.pitBlend(s) : 0;
    return edgeW + this.d.runoff * (1 - blend) + (PIT_WIDTH + 2.5 + PIT_WALL) * blend;
  }

  // ---------------- dotaz na polohu ----------------
  /** `hint` = index segmentu z predošlého dotazu (rýchle lokálne hľadanie); -1 = posledný dotaz tohto objektu; <= -2 = celá trať. */
  query(x: number, y: number, hint = -1): TrackQuery {
    const n = this.n, d = this.d;
    let best = Infinity, bi = 0;
    const test = (i: number) => {
      const dx = x - d.x[i], dy = y - d.y[i];
      const q = dx * dx + dy * dy;
      if (q < best) { best = q; bi = i; }
    };
    if (hint === -1) hint = this.lastI;
    if (hint >= 0) {
      for (let k = -14; k <= 14; k++) test((hint + k + n) % n);
      if (best > 30 * 30) for (let i = 0; i < n; i++) test(i);
    } else for (let i = 0; i < n; i++) test(i);
    // projekcia na segment bi..bi±1
    const proj = (a: number, b: number) => {
      const ax = d.x[a], ay = d.y[a], bx = d.x[b], by = d.y[b];
      const vx = bx - ax, vy = by - ay;
      const l2 = vx * vx + vy * vy || 1;
      const t = clamp(((x - ax) * vx + (y - ay) * vy) / l2, 0, 1);
      const px = ax + vx * t, py = ay + vy * t;
      return { t, dist: (x - px) ** 2 + (y - py) ** 2, px, py, vx, vy };
    };
    const nxt = (bi + 1) % n, prv = (bi - 1 + n) % n;
    const pa = proj(bi, nxt), pb = proj(prv, bi);
    let i: number, pp: ReturnType<typeof proj>;
    if (pa.dist <= pb.dist) { i = bi; pp = pa; } else { i = prv; pp = pb; }
    const s = (i + pp.t) * this.ds;
    const ln = Math.hypot(pp.vx, pp.vy) || 1;
    const lat = ((x - pp.px) * -pp.vy + (y - pp.py) * pp.vx) / ln; // kladné = vľavo
    this.lastI = i;
    const j = (i + 1) % n;
    const heading = this.hd[i] + wrapPi(this.hd[j] - this.hd[i]) * pp.t;
    const wr = d.wr[i] + (d.wr[j] - d.wr[i]) * pp.t, wl = d.wl[i] + (d.wl[j] - d.wl[i]) * pp.t;
    return this.classify({ i, s, d: lat, heading, wr, wl });
  }

  private classify(q: { i: number; s: number; d: number; heading: number; wr: number; wl: number }): TrackQuery {
    const side = q.d >= 0 ? 1 : -1;
    const edgeW = side > 0 ? q.wl : q.wr;
    const over = Math.abs(q.d) - edgeW; // >0 = mimo asfaltu
    let surface: Surface = 'asphalt';
    let edge = Math.max(0, over);
    let wallPen = 0, wallNormal = 0;
    const pit = this.d.pit;
    const pw = this.pitWidthAt(q.s);
    const pitHere = side === pit.side && pw > 0.5;
    const onPit = pitHere && over > -0.3 && over < pw;
    if (over > 0) {
      if (onPit) { surface = 'pit'; edge = 0; }
      else if (over < 1.1) surface = 'kerb';
      else surface = 'grass';
    }
    const wd = this.wallDist(q.s, side);
    if (Math.abs(q.d) > wd) { surface = 'wall'; wallPen = Math.abs(q.d) - wd; wallNormal = -side; }
    return { i: q.i, s: q.s, d: q.d, heading: q.heading, surface, edge, wallPen, wallNormal };
  }
}
