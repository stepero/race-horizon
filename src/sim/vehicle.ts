import { clamp, lerp } from './math';

export const G = 9.81;
export const RHO = 1.2;
/** Fixný krok fyziky [s]. */
export const PHYS_DT = 1 / 240;

export interface CarSpec {
  id: string;
  mass: number; // kg bez paliva (vrátane jazdca)
  fuelCapacity: number; // kg
  wheelbase: number; // m
  weightRear: number; // podiel statickej hmotnosti na zadnej náprave
  hCg: number; // výška ťažiska [m]
  length: number;
  width: number;
  yawInertia: number;
  powerW: number;
  redline: number; // ot/min
  idle: number;
  launchRpm: number;
  ratios: number[]; // celkové prevody (prevodový stupeň × stály prevod)
  wheelRadius: number;
  driveEff: number;
  rearDrive: number; // podiel hnacej sily na zadnú nápravu (1 = RWD, 0 = FWD)
  cdA: number;
  clA: number;
  aeroFront: number;
  brakeMax: number; // N celkovo
  brakeBias: number; // podiel na prednú nápravu
  mu: number;
  loadSens: number;
  peakSlip: number; // uhol šmyku pneumatiky pri maximálnej bočnej sile [rad]
  maxSteer: number; // rad
  wearRate: number; // základná rýchlosť opotrebenia pneumatík
  shiftTime: number;
  peakTorque: number;
  topSpeed: number; // m/s – informatívne (z návrhu prevodov)
}

export interface SpecInput extends Omit<CarSpec, 'ratios' | 'peakTorque' | 'topSpeed' | 'yawInertia'> {
  gears: number;
  firstGearKph: number; // rýchlosť na červenej čiare v 1. stupni
  topGearKph: number; // rýchlosť na červenej čiare v najvyššom stupni
  yawInertia?: number;
}

export function torqueShape(x: number): number {
  if (x >= 1) return 0;
  const bell = clamp(1 - 2.2 * (x - 0.74) * (x - 0.74), 0.35, 1);
  const low = Math.min(1, 0.45 + 2.2 * x);
  const cut = x > 0.97 ? (1 - x) / 0.03 : 1;
  return bell * low * cut;
}

export function buildSpec(inp: SpecInput): CarSpec {
  const { gears, firstGearKph, topGearKph, yawInertia, ...rest } = inp;
  const w = (kph: number) => (inp.redline * 2 * Math.PI) / 60 * inp.wheelRadius / (kph / 3.6);
  const r1 = w(firstGearKph);
  const rN = w(topGearKph);
  const ratios: number[] = [];
  for (let i = 0; i < gears; i++) ratios.push(r1 * Math.pow(rN / r1, i / (gears - 1)));
  let best = 0;
  for (let i = 1; i < 400; i++) {
    const x = i / 400;
    best = Math.max(best, torqueShape(x) * x * inp.redline * 2 * Math.PI / 60);
  }
  const peakTorque = inp.powerW / best;
  const I = yawInertia ?? (inp.mass * (0.4 * inp.wheelbase) ** 2);
  return { ...rest, ratios, peakTorque, yawInertia: I, topSpeed: topGearKph / 3.6 };
}

export function torqueAt(spec: CarSpec, rpm: number): number {
  return spec.peakTorque * torqueShape(rpm / spec.redline);
}

// ---- vylepšenia ----
export interface Upgrades {
  engine: number;
  tyres: number;
  brakes: number;
  wing: number;
  chassis: number;
}
export const NO_UPGRADES: Upgrades = { engine: 0, tyres: 0, brakes: 0, wing: 0, chassis: 0 };

/** Účinok jednej úrovne vylepšenia (používa aj obchod v kariére na zobrazenie efektu). */
export const UPGRADE_STEP = {
  engine: 0.03, tyresMu: 0.025, tyresWear: 0.06, brakes: 0.04, wingDownforce: 0.05, wingDrag: 0.02, chassisSlip: 0.025, chassisMass: 0.012,
} as const;

export function applyUpgrades(spec: CarSpec, up: Upgrades): CarSpec {
  const S = UPGRADE_STEP;
  return {
    ...spec,
    powerW: spec.powerW * (1 + S.engine * up.engine),
    peakTorque: spec.peakTorque * (1 + S.engine * up.engine),
    mu: spec.mu * (1 + S.tyresMu * up.tyres),
    wearRate: spec.wearRate * (1 - S.tyresWear * up.tyres),
    brakeMax: spec.brakeMax * (1 + S.brakes * up.brakes),
    clA: spec.clA * (1 + S.wingDownforce * up.wing),
    cdA: spec.cdA * (1 + S.wingDrag * up.wing),
    peakSlip: spec.peakSlip * (1 - S.chassisSlip * up.chassis),
    mass: spec.mass * (1 - S.chassisMass * up.chassis),
  };
}

// ---- stav ----
export interface VehicleState {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  r: number;
  steer: number;
  gear: number; // -1 = spiatočka, 1..N
  rpm: number;
  shiftTimer: number;
  revTimer: number;
  throttle: number;
  brake: number;
  fuel: number;
  wear: [number, number, number, number]; // PL, PP, ZL, ZP
  damage: [number, number, number, number]; // predok, zadok, ľavá, pravá
  ax: number;
  ay: number;
  beta: number;
  absActive: boolean;
  tcActive: boolean;
  steerAssistActive: boolean;
  skid: number;
  limiter: boolean;
}

export function createVehicleState(spec: CarSpec, x: number, y: number, heading: number): VehicleState {
  return {
    x, y, heading, vx: 0, vy: 0, r: 0, steer: 0, gear: 1, rpm: spec.idle, shiftTimer: 0, revTimer: 0,
    throttle: 0, brake: 0, fuel: spec.fuelCapacity, wear: [0, 0, 0, 0], damage: [0, 0, 0, 0],
    ax: 0, ay: 0, beta: 0, absActive: false, tcActive: false, steerAssistActive: false, skid: 0, limiter: false,
  };
}

export interface DriveInput {
  steer: number; // -1..1, kladné = doľava
  throttle: number;
  brake: number;
}

export interface Assists {
  abs: boolean;
  tc: 0 | 1 | 2;
  steer: 0 | 1 | 2;
  autoGear: boolean;
}

export interface VehicleEnv {
  grip: number; // počasie × povrch
  rrCoef: number;
  speedLimit: number; // m/s, 0 = bez limitu
  hold: boolean; // auto je držané (štart / servis)
  fuelPerMeter: number;
  wearScale: number;
  wetness: number;
}

export function wearGrip(w: number): number {
  const cliff = w > 0.85 ? 0.15 * ((w - 0.85) / 0.15) : 0;
  return 1 - 0.3 * Math.pow(w, 1.5) - cliff;
}

const STEER_VS: Record<number, number> = { 0: 32, 1: 24, 2: 19 };

/** Maximálny uhol natočenia kolies pri danej rýchlosti. */
export function steerLimit(spec: CarSpec, speed: number, level: number): number {
  const vs = STEER_VS[level] ?? 24;
  const soft = spec.maxSteer / (1 + (speed / vs) * (speed / vs));
  // Aj pri vysokej rýchlosti musí byť možné dosiahnuť hranicu priľnavosti:
  // geometrický uhol pre ~5 g + rezerva na uhol šmyku pneumatiky.
  const v = Math.max(speed, 1);
  const needed = (spec.wheelbase * 5 * G) / (v * v) + spec.peakSlip * 1.15;
  return Math.min(spec.maxSteer, Math.max(soft, needed));
}

export function shiftGear(spec: CarSpec, st: VehicleState, dir: 1 | -1): void {
  if (st.shiftTimer > 0) return;
  const n = spec.ratios.length;
  if (st.gear === -1) {
    if (dir > 0 && Math.abs(st.vx) < 1.5) {
      st.gear = 1;
    }
    return;
  }
  const ng = st.gear + dir;
  if (ng < 1) {
    if (st.vx < 1.5) st.gear = -1;
    return;
  }
  if (ng > n) return;
  st.gear = ng;
  st.shiftTimer = spec.shiftTime;
}

function rpmForGear(spec: CarSpec, speed: number, gear: number): number {
  return (speed / spec.wheelRadius) * spec.ratios[gear - 1] * 60 / (2 * Math.PI);
}

function autoGearbox(spec: CarSpec, st: VehicleState, inp: DriveInput, dt: number): void {
  const speed = Math.abs(st.vx);
  if (st.gear === -1) {
    if (inp.throttle > 0.2 && st.vx > -1) st.gear = 1;
    return;
  }
  if (speed < 1.2 && inp.brake > 0.3 && inp.throttle < 0.1) {
    st.revTimer += dt;
    if (st.revTimer > 0.4 && st.vx < 0.8) st.gear = -1;
  } else st.revTimer = 0;
  if (st.shiftTimer > 0) return;
  const n = spec.ratios.length;
  const rpmNow = rpmForGear(spec, speed, st.gear);
  if (st.gear < n && rpmNow > spec.redline * (0.9 + 0.06 * inp.throttle)) {
    st.gear++;
    st.shiftTimer = spec.shiftTime;
  } else if (st.gear > 1) {
    const low = rpmForGear(spec, speed, st.gear - 1);
    if (rpmNow < spec.redline * 0.4 || (inp.brake > 0.5 && low < spec.redline * 0.86)) {
      st.gear--;
      st.shiftTimer = spec.shiftTime;
    }
  }
}

/** Zjednodušená Pacejkova krivka: maximum `avail` pri uhle `peak`, potom mierny pokles. */
function latForce(alpha: number, avail: number, peak: number): number {
  if (avail < 1) return 0;
  const B = 1.7321 / peak; // tan(π/3) → 1.5·atan(B·peak) = π/2
  return -avail * Math.sin(1.5 * Math.atan(B * alpha));
}

/** Jeden krok fyziky vozidla (dvojstopový model s trecou kružnicou). */
export function stepVehicle(
  spec: CarSpec, st: VehicleState, inp: DriveInput, as: Assists, env: VehicleEnv, dt: number,
): void {
  const m = spec.mass + st.fuel;
  const L = spec.wheelbase;
  const a = L * spec.weightRear; // ťažisko -> predná náprava
  const b = L - a;
  const R = spec.wheelRadius;
  const wLoad = m * G;

  st.shiftTimer = Math.max(0, st.shiftTimer - dt);

  if (env.hold) {
    st.vx = 0; st.vy = 0; st.r = 0; st.ax = 0; st.ay = 0; st.skid = 0; st.beta = 0;
    st.absActive = false; st.tcActive = false; st.limiter = false;
    st.throttle = inp.throttle; st.brake = inp.brake;
    st.rpm = lerp(st.rpm, spec.idle + (spec.launchRpm - spec.idle) * inp.throttle, 0.15);
    return;
  }

  if (as.autoGear) autoGearbox(spec, st, inp, dt);
  else if (st.gear === -1 && inp.throttle > 0.2 && st.vx > -1) st.gear = 1;

  const speed = Math.abs(st.vx);
  const fwd = st.vx >= 0 ? 1 : -1;

  // --- obmedzovač rýchlosti (boxy) ---
  let thr = inp.throttle;
  let brk = inp.brake;
  st.limiter = false;
  if (env.speedLimit > 0) {
    st.limiter = speed > env.speedLimit - 3;
    thr *= clamp((env.speedLimit - speed + 1.5) / 1.5, 0, 1);
    if (st.gear > 0) brk = Math.max(brk, clamp((speed - env.speedLimit - 0.8) / 4, 0, 0.7));
  }
  st.throttle = thr; st.brake = brk;

  // --- poškodenie ---
  const dF = st.damage[0], dR = st.damage[1], dS = Math.max(st.damage[2], st.damage[3]);
  const powerMul = (1 - 0.3 * dF - 0.15 * dR) * (st.fuel > 0 ? 1 : 0.15);
  const downMul = 1 - 0.35 * Math.max(dF, dR);
  const gripMulF = 1 - 0.22 * dF - 0.08 * dS;
  const gripMulR = 1 - 0.18 * dR - 0.08 * dS;
  const pull = (st.damage[2] - st.damage[3]) * 0.012;

  // --- aerodynamika ---
  const v2 = st.vx * st.vx;
  const Fdown = 0.5 * RHO * spec.clA * downMul * v2;
  const Fdrag = 0.5 * RHO * spec.cdA * (1 + 0.25 * dF) * v2 * fwd;
  const Frr = env.rrCoef * wLoad * fwd * Math.min(1, speed / 2);

  // --- zaťaženie náprav ---
  const refF = wLoad * (b / L);
  const refR = wLoad * (a / L);
  const dyn = st.ax * m * spec.hCg / L;
  const Fzf = Math.max(refF + Fdown * spec.aeroFront - dyn, 0.2 * refF);
  const Fzr = Math.max(refR + Fdown * (1 - spec.aeroFront) + dyn, 0.2 * refR);
  const wearF = wearGrip((st.wear[0] + st.wear[1]) / 2);
  const wearR = wearGrip((st.wear[2] + st.wear[3]) / 2);
  const muF = spec.mu * env.grip * gripMulF * wearF * Math.pow(Fzf / refF, -spec.loadSens);
  const muR = spec.mu * env.grip * gripMulR * wearR * Math.pow(Fzr / refR, -spec.loadSens);
  const FmaxF = muF * Fzf;
  const FmaxR = muR * Fzr;

  // --- uhly šmyku ---
  const vxa = Math.max(speed, 4.5);
  const latScale = clamp((st.vx - 1) / 5, 0, 1);
  const vyF = st.vy + a * st.r;
  const vyR = st.vy - b * st.r;
  const alphaR = Math.atan2(vyR, vxa);

  // --- riadenie ---
  const lim = steerLimit(spec, speed, as.steer);
  let target = inp.steer * lim + pull;
  st.steerAssistActive = false;
  if (as.steer > 0 && st.vx > 8) {
    const beta = Math.atan2(st.vy, Math.max(st.vx, 1));
    const dead = 0.07;
    if (Math.abs(beta) > dead) {
      const k = as.steer === 1 ? 0.55 : 1.0;
      target += k * Math.sign(beta) * (Math.abs(beta) - dead);
      st.steerAssistActive = true;
    }
  }
  const maxRate = 1.4 + 3 / (1 + speed / 10);
  st.steer += clamp(target - st.steer, -maxRate * dt, maxRate * dt);
  const delta = st.steer;
  const alphaF = Math.atan2(vyF, vxa) - delta;

  // --- hnacia sila ---
  let Fdrive = 0;
  if (st.gear >= 1) {
    const ratio = spec.ratios[st.gear - 1];
    const rpmWheel = rpmForGear(spec, speed, st.gear);
    const clutchRpm = spec.idle + (spec.launchRpm - spec.idle) * thr;
    const rpm = Math.max(rpmWheel, clutchRpm);
    st.rpm = lerp(st.rpm, st.shiftTimer > 0 ? rpm * 0.8 : rpm, 0.35);
    if (st.shiftTimer <= 0) {
      if (thr > 0.03) Fdrive = torqueAt(spec, rpm) * thr * powerMul * ratio * spec.driveEff / R;
      else Fdrive = -0.1 * spec.peakTorque * (rpmWheel / spec.redline) * ratio * spec.driveEff / R;
    }
  } else if (st.gear === -1) {
    st.rpm = lerp(st.rpm, spec.idle + (spec.launchRpm - spec.idle) * 0.4 * inp.brake, 0.2);
    if (st.vx > -8) Fdrive = -inp.brake * 0.35 * wLoad;
    brk = 0;
  }
  const driveF = Fdrive * (1 - spec.rearDrive);
  let driveR = Fdrive * spec.rearDrive;

  // --- brzdy ---
  let Fb = brk * spec.brakeMax;
  if (speed < 6) Fb = Math.min(Fb, (m * speed) / dt * 0.9);
  let Fbf = Fb * spec.brakeBias;
  let Fbr = Fb * (1 - spec.brakeBias);

  // bočné sily bez pozdĺžneho zaťaženia (na odhad kapacity)
  const stiffF = spec.peakSlip;
  const stiffR = spec.peakSlip * 0.85; // tuhší zadok (menší uhol šmyku) → prirodzená nedotáčavosť
  const FyF0 = latForce(alphaF, FmaxF, stiffF) * latScale;
  const FyR0 = latForce(alphaR, FmaxR, stiffR) * latScale;
  const capF = Math.sqrt(Math.max(0, FmaxF * FmaxF - FyF0 * FyF0));
  const capR = Math.sqrt(Math.max(0, FmaxR * FmaxR - FyR0 * FyR0));

  st.absActive = false; st.tcActive = false;
  let lockF = 0, lockR = 0, spin = 0;
  if (as.abs) {
    if (Fbf > capF * 0.96) { Fbf = capF * 0.96; st.absActive = true; }
    if (Fbr > capR * 0.8) { Fbr = capR * 0.8; st.absActive = true; } // ABS chráni stabilitu zadnej nápravy
  } else {
    lockF = clamp((Fbf / Math.max(FmaxF, 1) - 0.98) / 0.3, 0, 1);
    lockR = clamp((Fbr / Math.max(FmaxR, 1) - 0.98) / 0.3, 0, 1);
    if (lockF > 0) Fbf = FmaxF * 0.8;
    if (lockR > 0) Fbr = FmaxR * 0.8;
  }

  let driveFLim = driveF;
  if (driveR > 0 || driveFLim > 0) {
    if (as.tc > 0) {
      const k = as.tc === 1 ? 0.97 : 0.85;
      if (driveR > capR * k) { driveR = capR * k; st.tcActive = true; }
      if (driveFLim > capF * k) { driveFLim = capF * k; st.tcActive = true; }
    } else {
      if (driveR > capR * 0.98) { spin = clamp((driveR / capR - 0.98) / 0.4, 0, 1); driveR = Math.min(driveR, FmaxR * 0.92); }
    }
  }

  const FxF = driveFLim - fwd * Fbf;
  const FxR = driveR - fwd * Fbr;

  const availF = Math.sqrt(Math.max(FmaxF * FmaxF - FxF * FxF, (0.05 * FmaxF) ** 2)) * (1 - 0.75 * lockF);
  const availR = Math.sqrt(Math.max(FmaxR * FmaxR - FxR * FxR, (0.05 * FmaxR) ** 2)) * (1 - 0.75 * lockR) * (1 - 0.55 * spin);
  const FyF = latForce(alphaF, availF, stiffF) * latScale;
  const FyR = latForce(alphaR, availR, stiffR) * latScale;

  // --- pohybové rovnice ---
  const cd = Math.cos(delta), sd = Math.sin(delta);
  const Fx = FxF * cd - FyF * sd + FxR - Fdrag - Frr;
  const Fy = FyF * cd + FxF * sd + FyR;
  const Mz = a * (FyF * cd + FxF * sd) - b * FyR - 220 * st.r;
  const ax = Fx / m;
  const ay = Fy / m;

  st.vx += (ax + st.r * st.vy) * dt;
  st.vy += (ay - st.r * st.vx) * dt;
  st.r += (Mz / spec.yawInertia) * dt;

  // nízka rýchlosť: kinematický model
  if (st.vx < 6) {
    const kb = st.vx < 1 ? 1 : clamp(1 - (st.vx - 1) / 5, 0, 1);
    const rKin = (st.vx * Math.tan(delta)) / L;
    const f = Math.min(1, dt * 25) * kb;
    st.r += (rKin - st.r) * f;
    st.vy -= st.vy * f;
  }
  // státie bez pohonu
  if (speed < 0.12 && thr < 0.02 && brk > 0.05) { st.vx = 0; st.vy = 0; st.r = 0; }

  st.ax = lerp(st.ax, ax, 0.25);
  st.ay = lerp(st.ay, ay, 0.25);

  // --- poloha ---
  const c = Math.cos(st.heading), s = Math.sin(st.heading);
  st.x += (st.vx * c - st.vy * s) * dt;
  st.y += (st.vx * s + st.vy * c) * dt;
  st.heading += st.r * dt;
  if (st.heading > Math.PI) st.heading -= 2 * Math.PI;
  else if (st.heading < -Math.PI) st.heading += 2 * Math.PI;

  st.beta = Math.atan2(st.vy, Math.max(Math.abs(st.vx), 1));

  // --- opotrebenie, palivo, šmyk ---
  const useF = Math.hypot(FxF, FyF) / Math.max(FmaxF, 1);
  const useR = Math.hypot(FxR, FyR) / Math.max(FmaxR, 1);
  const rate = spec.wearRate * dt * env.wearScale * (1 - 0.3 * env.wetness);
  const side = clamp(st.ay / (2.5 * G), -1, 1);
  st.wear[0] = Math.min(1, st.wear[0] + rate * useF * useF * (1 - 0.5 * side));
  st.wear[1] = Math.min(1, st.wear[1] + rate * useF * useF * (1 + 0.5 * side));
  st.wear[2] = Math.min(1, st.wear[2] + rate * useR * useR * (1 - 0.5 * side));
  st.wear[3] = Math.min(1, st.wear[3] + rate * useR * useR * (1 + 0.5 * side));
  st.fuel = Math.max(0, st.fuel - env.fuelPerMeter * speed * dt * (0.35 + 0.65 * thr));

  const slipMax = Math.max(Math.abs(alphaF), Math.abs(alphaR));
  st.skid = speed > 5 ? clamp(slipMax / 0.2 - 0.55, 0, 1) : 0;
  st.skid = Math.max(st.skid, lockF, lockR, spin * 0.8, st.absActive ? 0.35 : 0);
}
