import type { Race, Racer } from '../sim/race';
import { SNAP_HZ, type C2S, type NetSnap, type S2C, type StandingRow } from './protocol';

/** Najmenšie rozhranie siete, ktoré relácia potrebuje (spĺňa `NetClient` aj testovací stroj). */
export interface NetLike {
  send(m: C2S): void;
  on(f: (m: S2C) => void): () => void;
}

/** Zobrazovacie oneskorenie cudzích áut [s]: ~2 pakety pri 20 Hz, vyhladí kolísanie siete. */
export const INTERP_DELAY = 0.1;
/** Ako dlho smie auto pokračovať podľa poslednej rýchlosti, kým chýbajú nové dáta [s]. */
export const MAX_EXTRAPOLATE = 0.25;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const wrapPi = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

/** Zostaví paket zo stavu vlastného auta. */
export function snapshotOf(race: Race): NetSnap {
  const r = race.player, s = r.st;
  return {
    T: r3(race.clock), x: r3(s.x), y: r3(s.y), h: r3(s.heading), vx: r3(s.vx), vy: r3(s.vy), r: r3(s.r),
    st: r3(s.steer), th: r3(s.throttle), br: r3(s.brake), g: s.gear, rpm: Math.round(s.rpm),
    prog: r3(r.prog), laps: r.lapsDone, fin: r.finished, finT: r.finishT == null ? null : r3(r.finishT),
    best: r.bestLap == null ? null : r3(r.bestLap), last: r.lastLap == null ? null : r3(r.lastLap),
    pit: r.pit.phase, dmg: [r3(s.damage[0]), r3(s.damage[1]), r3(s.damage[2]), r3(s.damage[3])],
  };
}

interface Entry { at: number; snap: NetSnap }

/**
 * Vyrovnávacia pamäť jedného cudzieho auta. Čas paketu sa prepočíta na lokálny čas cez odhad
 * posunu hodín (minimum z posledných paketov = najrýchlejší prenos), takže sieťový jitter sa vyhladí.
 */
export class RemoteBuffer {
  private list: Entry[] = [];
  private diffs: number[] = [];

  push(snap: NetSnap, at: number): void {
    const last = this.list[this.list.length - 1];
    if (last && snap.T <= last.snap.T) return; // starý alebo duplicitný paket
    this.diffs.push(at - snap.T);
    if (this.diffs.length > 40) this.diffs.shift();
    this.list.push({ at: snap.T, snap });
    if (this.list.length > 40) this.list.shift();
  }

  /** Odhad posunu: lokálny čas = T + offset. */
  get offset(): number {
    return this.diffs.length ? Math.min(...this.diffs) : 0;
  }

  get latest(): NetSnap | null {
    return this.list.length ? this.list[this.list.length - 1].snap : null;
  }

  get size(): number { return this.list.length; }

  /** Stav auta v lokálnom čase `now` (zobrazovacie oneskorenie sa už započítava tu). */
  sample(now: number): NetSnap | null {
    const n = this.list.length;
    if (!n) return null;
    const t = now - INTERP_DELAY - this.offset; // čas odosielateľa
    const first = this.list[0].snap, last = this.list[n - 1].snap;
    if (t <= first.T) return first;
    if (t >= last.T) {
      const dt = Math.min(t - last.T, MAX_EXTRAPOLATE);
      const c = Math.cos(last.h), s = Math.sin(last.h);
      return { ...last, x: last.x + (last.vx * c - last.vy * s) * dt, y: last.y + (last.vx * s + last.vy * c) * dt, h: last.h + last.r * dt };
    }
    let i = n - 1;
    while (i > 0 && this.list[i - 1].at >= t) i--;
    const a = this.list[i - 1].snap, b = this.list[i].snap;
    const k = (t - a.T) / Math.max(1e-6, b.T - a.T);
    const L = (p: number, q: number) => p + (q - p) * k;
    return {
      ...b,
      x: L(a.x, b.x), y: L(a.y, b.y), h: a.h + wrapPi(b.h - a.h) * k,
      vx: L(a.vx, b.vx), vy: L(a.vy, b.vy), r: L(a.r, b.r), st: L(a.st, b.st), th: L(a.th, b.th), br: L(a.br, b.br),
      rpm: L(a.rpm, b.rpm), prog: L(a.prog, b.prog),
    };
  }
}

/**
 * Online relácia počas pretekov: posiela stav vlastného auta, prijíma cudzie a premieta ich do `Race`
 * (poloha, otáčky, poškodenie, kolá…), takže vykresľovanie aj HUD fungujú bez zmeny.
 */
export class OnlineSession {
  readonly buffers = new Map<string, RemoteBuffer>();
  /** Posledné poradie zo servera (tabuľka výsledkov v hre). */
  standings: StandingRow[] = [];
  results: StandingRow[] | null = null;
  private sendT = 0;
  private off: () => void;
  private byId = new Map<string, Racer>();

  constructor(private net: NetLike, private race: Race, readonly selfId: string, private clock: () => number = () => performance.now() / 1000) {
    for (const r of race.racers) if (r.remote) { this.byId.set(r.id, r); this.buffers.set(r.id, new RemoteBuffer()); }
    this.off = net.on((m) => this.onMessage(m));
  }

  dispose(): void { this.off(); }

  private onMessage(m: S2C): void {
    switch (m.t) {
      case 'go': this.race.release(); break;
      case 'states': {
        const now = this.clock();
        for (const [id, snap] of m.list) this.buffers.get(id)?.push(snap, now);
        break;
      }
      case 'left': { const r = this.byId.get(m.id); if (r) r.hidden = true; break; }
      case 'standings': this.standings = m.list; break;
      case 'results': this.results = m.list; break;
      default: break;
    }
  }

  /** Volať raz za snímku (po `race.advance`). */
  update(dt: number): void {
    const race = this.race;
    if (!race.gate && !this.results) {
      this.sendT += dt;
      if (this.sendT >= 1 / SNAP_HZ) {
        this.sendT = 0;
        this.net.send({ t: 'state', s: snapshotOf(race) });
      }
    }
    const now = this.clock();
    for (const [id, r] of this.byId) {
      const buf = this.buffers.get(id)!;
      const s = buf.sample(now);
      if (!s) continue;
      applySnap(r, s);
      const last = buf.latest!;
      r.lapsDone = last.laps; r.bestLap = last.best; r.lastLap = last.last;
      if (last.fin && !r.finished) { r.finished = true; }
      r.finishT = last.finT;
      r.pit.phase = last.pit;
    }
    this.rankFinishers();
  }

  /** Poradie v cieli podľa času dojazdu (lokálne `finishOrder` závisí od toho, kedy dorazil paket). */
  private rankFinishers(): void {
    const fin = this.race.racers.filter((r) => r.finished && !r.hidden).sort((a, b) => (a.finishT ?? 1e9) - (b.finishT ?? 1e9));
    fin.forEach((r, i) => { r.finishOrder = i + 1; });
    this.race.finishCount = Math.max(this.race.finishCount, fin.length);
  }
}

function applySnap(r: Racer, s: NetSnap): void {
  const st = r.st;
  st.x = s.x; st.y = s.y; st.heading = s.h; st.vx = s.vx; st.vy = s.vy; st.r = s.r;
  st.steer = s.st; st.throttle = s.th; st.brake = s.br; st.gear = s.g; st.rpm = s.rpm;
  st.damage = [s.dmg[0], s.dmg[1], s.dmg[2], s.dmg[3]];
  r.prog = s.prog;
}
