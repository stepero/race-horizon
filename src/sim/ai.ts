import { G, steerLimit, type CarSpec, type DriveInput, type VehicleState } from './vehicle';
import type { Track } from './track';
import { clamp, wrapPi } from './math';

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';

export const DIFF_PACE: Record<Difficulty, number> = { easy: 0.8, medium: 0.88, hard: 0.95, expert: 1.0 };

export interface AIState {
  /** Násobok trecej hranice, ktorý AI využíva pri plánovaní rýchlosti. */
  pace: number;
  /** Bočný posun pri predbiehaní [m]. */
  offset: number;
  offsetTarget: number;
  wantsPit: boolean;
  mistakeT: number;
  rnd: () => number;
}

export interface AIContext {
  track: Track;
  spec: CarSpec;
  st: VehicleState;
  s: number; // aktuálna pozícia pozdĺž trate
  d: number;
  grip: number;
  /** Cieľový bočný posun (napr. boxová ulička), ak je zadaný, prepíše ideálnu stopu. */
  forcedLateral: number | null;
  /** Cieľový bočný posun ako funkcia polohy (boxová ulička); má prednosť pred ideálnou stopou. */
  lateralFn?: ((s: number) => number) | null;
  speedCap: number; // m/s (0 = bez limitu)
  stopAtS: number | null; // zastav na tejto pozícii
  neighbours: { s: number; d: number; v: number }[];
}

const LOOK = 4; // m vzorkovanie

/** Plánovaná rýchlosť v zákrute podľa zakrivenia a dostupnej priľnavosti (vrátane prítlaku). */
export function cornerSpeed(spec: CarSpec, curv: number, mu: number): number {
  const k = Math.max(Math.abs(curv), 1e-4);
  const m = spec.mass + 40;
  // prítlak sa využije len čiastočne (citlivosť pneumatiky na zaťaženie)
  const aeroTerm = (0.5 * 1.2 * spec.clA * mu * 0.8) / m;
  const denom = k - aeroTerm;
  if (denom <= 0) return 120;
  return Math.min(120, Math.sqrt((mu * G) / denom));
}

export function driveAI(ai: AIState, c: AIContext, dt: number): DriveInput {
  const { track, spec, st } = c;
  const v = Math.max(st.vx, 0);
  const mu = spec.mu * c.grip * ai.pace * 0.86;

  // --- cieľová stopa ---
  ai.offset += clamp(ai.offsetTarget - ai.offset, -2.5 * dt, 2.5 * dt);
  const lateralAt = (s: number) => {
    if (c.lateralFn) return c.lateralFn(s);
    if (c.forcedLateral != null) return c.forcedLateral;
    const hw = track.halfWidths(s);
    return clamp(track.lineOffset(s) + ai.offset, -hw.wr + 1.3, hw.wl - 1.3);
  };

  // --- riadenie: pure pursuit ---
  const look = 7 + v * 0.42;
  const p = track.at(c.s + look, lateralAt(c.s + look));
  const dx = p.x - st.x, dy = p.y - st.y;
  const ang = wrapPi(Math.atan2(dy, dx) - st.heading);
  const ld = Math.hypot(dx, dy);
  const kappa = (2 * Math.sin(ang)) / Math.max(ld, 1);
  let steerAngle = Math.atan(spec.wheelbase * kappa);
  if (v > 12) {
    // predná pneumatika potrebuje uhol šmyku úmerný bočnému zaťaženiu
    const latNeed = clamp((v * v * Math.abs(kappa)) / (mu * G * 1.3), 0, 1);
    steerAngle += Math.sign(kappa) * spec.peakSlip * 0.6 * latNeed;
    // spätná väzba na stáčavú rýchlosť: pri nedotáčaní pridaj, pri pretáčaní uber (kontra)
    steerAngle += 0.06 * (v * kappa - st.r);
    // skutočný šmyk zadku: kontra len nad bežný uhol pri zatáčaní
    const slide = Math.abs(st.beta) - 0.12;
    if (slide > 0) steerAngle += Math.sign(st.beta) * slide * 1.2;
  }
  const lim = steerLimit(spec, v, 0);
  let steer = clamp(steerAngle / Math.max(lim, 0.02), -1, 1);

  // --- plánovanie rýchlosti ---
  // Spätný prechod: v každom bode je brzdné spomalenie obmedzené trecou kružnicou
  // (časť priľnavosti spotrebuje zatáčanie), takže AI brzdí skôr pred uťahujúcimi sa zákrutami.
  const decel = mu * G * 0.85;
  const horizon = 60 + v * v / (2 * decel) * 1.3;
  const nS = Math.ceil(horizon / LOOK) + 1;
  const dev = Math.min(1, Math.abs(ai.offset) / 3 + (c.forcedLateral != null || c.lateralFn ? 1 : 0));
  const aeroK = (0.5 * 1.2 * spec.clA * 0.6) / spec.mass; // prítlak na m/s² (konzervatívne)
  let vNext = 120;
  for (let i = nS - 1; i >= 0; i--) {
    const sAhead = c.s + i * LOOK;
    const lc = Math.abs(track.lineCurvatureAt(sAhead));
    // pri odklone od ideálnej stopy (predbiehanie, boxy) ber konzervatívnejšie zakrivenie
    const curv = lc * (1 - dev) + Math.max(lc, Math.abs(track.curvatureAt(sAhead))) * dev;
    const vc = cornerSpeed(spec, curv, mu);
    const v2 = vNext * vNext;
    const aTot = mu * (G + aeroK * v2);
    const aLat = Math.min(v2 * curv, aTot);
    const aLong = Math.max(0.35 * decel, 0.85 * Math.sqrt(aTot * aTot - aLat * aLat));
    vNext = Math.min(vc, Math.sqrt(v2 + 2 * aLong * LOOK));
  }
  let vTarget = vNext;
  if (c.speedCap > 0) vTarget = Math.min(vTarget, c.speedCap);
  if (c.stopAtS != null) {
    let dist = track.wrapS(c.stopAtS - c.s);
    if (dist > track.length - 8) dist = 0; // mierne za cieľom: stoj
    if (dist < 400) vTarget = Math.min(vTarget, Math.sqrt(2 * 6 * Math.max(0, dist - 0.6)));
  }

  // --- vyhýbanie a predbiehanie ---
  let block = 0;
  for (const nb of c.neighbours) {
    const ds = track.wrapS(nb.s - c.s);
    if (ds > 0 && ds < 40) {
      const lat = nb.d - c.d;
      if (Math.abs(lat) < 2.6) {
        // tesne vpredu: prispôsob rýchlosť a skús obchádzať
        if (ds < 14 + v * 0.25 && nb.v < v + 1) block = Math.max(block, 1 - ds / 40);
        if (c.forcedLateral == null && Math.abs(ai.offsetTarget) < 0.5) {
          const hw = track.halfWidths(c.s);
          ai.offsetTarget = lat >= 0 ? -Math.min(3.5, hw.wr - 1.5) : Math.min(3.5, hw.wl - 1.5);
        }
      }
    }
  }
  if (block > 0) vTarget = Math.min(vTarget, Math.max(5, v - block * 6));
  if (block === 0 && Math.abs(ai.offsetTarget) > 0 && ai.rnd() < dt * 0.25) ai.offsetTarget = 0;

  // --- občasná chyba (nižšia náročnosť) ---
  ai.mistakeT -= dt;
  if (ai.mistakeT < 0) {
    ai.mistakeT = 20 + ai.rnd() * 60 * ai.pace;
    if (ai.rnd() > ai.pace) vTarget *= 0.85;
  }

  // --- plyn / brzda ---
  const err = vTarget - v;
  let throttle = 0, brake = 0;
  if (err > 0) throttle = clamp(err * 0.35 + (err > 2 ? 0.3 : 0.05), 0, 1);
  else brake = clamp(-err * 0.18, 0, 1);
  // výjazd zo zákruty: plyn podľa zostávajúcej priľnavosti
  const latUse = Math.abs(st.ay) / Math.max(1, mu * G * (1 + 0.5 * 1.2 * spec.clA * v * v * 0.8 / (spec.mass * G)));
  throttle = Math.min(throttle, clamp(1.6 - 1.5 * latUse, 0.15, 1));
  // brzdenie v zákrute: uvoľni brzdu podľa bočného zaťaženia (trail braking)
  brake = Math.min(brake, clamp(1.35 - 1.1 * latUse, 0.25, 1));
  if (c.stopAtS != null && v < 0.4) { const dd = track.wrapS(c.stopAtS - c.s); if (dd < 3 || dd > track.length - 8) { throttle = 0; brake = 1; } }
  // šmyk: uber plyn
  const b = Math.abs(st.beta);
  if (b > 0.05) throttle *= clamp(1 - (b - 0.05) * 8, 0, 1);
  if (b > 0.1) brake *= clamp(1 - (b - 0.1) * 6, 0.2, 1);
  steer = clamp(steer, -1, 1);
  return { steer, throttle, brake };
}
