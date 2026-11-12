import { describe, expect, it } from 'vitest';
import {
  buildSpec, createVehicleState, PHYS_DT, stepVehicle, G,
  type Assists, type CarSpec, type DriveInput, type VehicleEnv,
} from '../src/sim/vehicle';

const f1 = (): CarSpec => buildSpec({
  id: 'test-f1', mass: 800, fuelCapacity: 70, wheelbase: 3.6, weightRear: 0.55, hCg: 0.3,
  length: 5.5, width: 2.0, powerW: 750_000, redline: 12000, idle: 4000, launchRpm: 8500,
  wheelRadius: 0.34, driveEff: 0.92, rearDrive: 1, cdA: 1.1, clA: 3.6, aeroFront: 0.42,
  brakeMax: 36_000, brakeBias: 0.58, mu: 1.9, loadSens: 0.08, peakSlip: 0.1, maxSteer: 0.34,
  wearRate: 0.0000045, shiftTime: 0.04, gears: 8, firstGearKph: 80, topGearKph: 365,
});

const env: VehicleEnv = { grip: 1, rrCoef: 0.012, speedLimit: 0, hold: false, fuelPerMeter: 0, wearScale: 1, wetness: 0 };
const assists: Assists = { abs: true, tc: 1, steer: 1, autoGear: true };

function run(spec: CarSpec, secs: number, inp: (t: number, v: number) => DriveInput, e = env, a = assists) {
  const st = createVehicleState(spec, 0, 0, 0);
  const log: { t: number; v: number; x: number; y: number; ay: number }[] = [];
  for (let t = 0; t < secs; t += PHYS_DT) {
    stepVehicle(spec, st, inp(t, st.vx), a, e, PHYS_DT);
    log.push({ t, v: st.vx, x: st.x, y: st.y, ay: st.ay });
  }
  return { st, log };
}

describe('fyzika vozidla', () => {
  it('zrýchlenie 0–100 km/h v rozumnom čase', () => {
    const { log } = run(f1(), 8, () => ({ steer: 0, throttle: 1, brake: 0 }));
    const t100 = log.find((l) => l.v * 3.6 >= 100)?.t ?? 99;
    const t200 = log.find((l) => l.v * 3.6 >= 200)?.t ?? 99;
    console.log('0-100', t100.toFixed(2), '0-200', t200.toFixed(2));
    expect(t100).toBeGreaterThan(1.8);
    expect(t100).toBeLessThan(3.4);
    expect(t200).toBeGreaterThan(4.2);
    expect(t200).toBeLessThan(7.5);
  });

  it('dosiahne rozumnú maximálnu rýchlosť', () => {
    const { st } = run(f1(), 60, () => ({ steer: 0, throttle: 1, brake: 0 }));
    console.log('vmax', (st.vx * 3.6).toFixed(0));
    expect(st.vx * 3.6).toBeGreaterThan(300);
    expect(st.vx * 3.6).toBeLessThan(400);
  });

  it('brzdenie z 300 km/h s ABS', () => {
    const spec = f1();
    const st = createVehicleState(spec, 0, 0, 0);
    st.vx = 300 / 3.6; st.gear = 8;
    let t = 0; let d = 0;
    while (st.vx > 100 / 3.6 && t < 10) { stepVehicle(spec, st, { steer: 0, throttle: 0, brake: 1 }, assists, env, PHYS_DT); t += PHYS_DT; d = st.x; }
    console.log('300->100', t.toFixed(2), 's', d.toFixed(0), 'm');
    // vrcholové brzdenie ~4.8 g (reálne F1: 5–6 g)
    expect(t).toBeGreaterThan(1.5);
    expect(t).toBeLessThan(4.5);
  });

  it('stacionárne zatáčanie: maximum bočného zrýchlenia rastie s prítlakom', () => {
    const peakLat = (kph: number, gear: number) => {
      let best = 0;
      for (const steer of [0.15, 0.25, 0.35, 0.5, 0.7, 1]) {
        const spec = f1();
        const st = createVehicleState(spec, 0, 0, 0);
        st.vx = kph / 3.6; st.gear = gear;
        for (let t = 0; t < 6; t += PHYS_DT) {
          stepVehicle(spec, st, { steer, throttle: st.vx < kph / 3.6 ? 0.7 : 0.1, brake: 0 }, assists, env, PHYS_DT);
          if (t > 2.5) best = Math.max(best, Math.abs(st.ay) / G);
        }
        expect(Number.isFinite(st.x)).toBe(true);
      }
      return best;
    };
    const slow = peakLat(100, 4), mid = peakLat(150, 5), fast = peakLat(250, 7);
    console.log('peak ay [g] 100/150/250 km/h:', slow.toFixed(2), mid.toFixed(2), fast.toFixed(2));
    expect(slow).toBeGreaterThan(1.8);
    expect(mid).toBeGreaterThan(slow);
    expect(fast).toBeGreaterThan(mid);
    expect(fast).toBeLessThan(6.5);
  });

  it('mokro zníži priľnavosť', () => {
    const lat = (grip: number) => {
      const spec = f1();
      const st = createVehicleState(spec, 0, 0, 0);
      st.vx = 100 / 3.6; st.gear = 4;
      let m = 0;
      for (let t = 0; t < 5; t += PHYS_DT) {
        stepVehicle(spec, st, { steer: 0.6, throttle: st.vx < 100 / 3.6 ? 0.5 : 0.1, brake: 0 }, assists, { ...env, grip }, PHYS_DT);
        if (t > 2) m = Math.max(m, Math.abs(st.ay));
      }
      return m;
    };
    const dry = lat(1), wet = lat(0.65);
    console.log('dry', (dry / G).toFixed(2), 'wet', (wet / G).toFixed(2));
    expect(wet).toBeLessThan(dry * 0.85);
  });

  it('bez ABS sa pri plnom brzdení kolesá zablokujú (dlhšia brzdná dráha)', () => {
    const dist = (abs: boolean) => {
      const spec = f1();
      const st = createVehicleState(spec, 0, 0, 0);
      st.vx = 200 / 3.6; st.gear = 6;
      let t = 0;
      while (st.vx > 5 && t < 12) { stepVehicle(spec, st, { steer: 0, throttle: 0, brake: 1 }, { ...assists, abs }, env, PHYS_DT); t += PHYS_DT; }
      return st.x;
    };
    expect(dist(false)).toBeGreaterThan(dist(true));
  });

  it('auto sa nepohne v režime hold (semafor)', () => {
    const { st } = run(f1(), 2, () => ({ steer: 0, throttle: 1, brake: 0 }), { ...env, hold: true });
    expect(st.x).toBe(0);
  });

  it('spiatočka funguje', () => {
    const { st } = run(f1(), 4, (t) => ({ steer: 0, throttle: 0, brake: t > 0.5 ? 1 : 0 }));
    st.gear = -1;
    const spec = f1();
    const s2 = createVehicleState(spec, 0, 0, 0);
    s2.gear = -1;
    for (let t = 0; t < 3; t += PHYS_DT) stepVehicle(spec, s2, { steer: 0, throttle: 0, brake: 1 }, { ...assists, autoGear: false }, env, PHYS_DT);
    expect(s2.vx).toBeLessThan(-1);
  });

  it('palivo ubúda a pneumatiky sa opotrebúvajú', () => {
    const spec = f1();
    const st = createVehicleState(spec, 0, 0, 0);
    st.vx = 80; st.gear = 6;
    const f0 = st.fuel;
    for (let t = 0; t < 20; t += PHYS_DT) stepVehicle(spec, st, { steer: 0.2, throttle: 0.8, brake: 0 }, assists, { ...env, fuelPerMeter: 0.0003 }, PHYS_DT);
    expect(st.fuel).toBeLessThan(f0);
    expect(st.wear[2]).toBeGreaterThan(0);
  });
});
