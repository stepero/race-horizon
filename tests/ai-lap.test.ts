import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Track, type TrackData } from '../src/sim/track';
import { specFor } from '../src/data/catalog';
import { createVehicleState, PHYS_DT, stepVehicle, type Assists, type VehicleEnv } from '../src/sim/vehicle';
import { driveAI, DIFF_PACE, type AIState } from '../src/sim/ai';
import { mulberry32 } from '../src/sim/math';

const load = (id: string) => new Track(JSON.parse(fs.readFileSync(path.resolve('public/tracks', `${id}.json`), 'utf8')) as TrackData);
const env: VehicleEnv = { grip: 1, rrCoef: 0.012, speedLimit: 0, hold: false, fuelPerMeter: 0.00028, wearScale: 1, wetness: 0 };
const as: Assists = { abs: true, tc: 1, steer: 1, autoGear: true };

function lapTest(trackId: string, modelId: string, pace: number, laps = 2) {
  const track = load(trackId);
  const spec = specFor(modelId, 0.9);
  const p = track.at(0, 0);
  const st = createVehicleState(spec, p.x, p.y, p.h);
  const ai: AIState = { pace, offset: 0, offsetTarget: 0, wantsPit: false, mistakeT: 1e9, rnd: mulberry32(3) };
  let lastS = 0, dist = 0, t = 0, offTime = 0, maxOff = 0;
  const lapTimes: number[] = []; let lapStart = 0;
  while (t < 400 && lapTimes.length < laps) {
    const q = track.query(st.x, st.y);
    const inp = driveAI(ai, { track, spec, st, s: q.s, d: q.d, grip: 1, forcedLateral: null, speedCap: 0, stopAtS: null, neighbours: [] }, PHYS_DT);
    stepVehicle(spec, st, inp, as, { ...env, hold: t < 1 }, PHYS_DT);
    const ds = track.wrapS(q.s - lastS + track.length / 2) - track.length / 2;
    dist += ds;
    if (dist > track.length * (lapTimes.length + 1)) { lapTimes.push(t - lapStart); lapStart = t; }
    lastS = q.s;
    const off = Math.abs(q.d) - (q.d > 0 ? track.halfWidths(q.s).wl : track.halfWidths(q.s).wr);
    if (off > 0) offTime += PHYS_DT;
    maxOff = Math.max(maxOff, off);
    t += PHYS_DT;
  }
  return { lapTimes, offTime, maxOff, length: track.length };
}

describe('AI jazdec', () => {
  const ids = fs.readdirSync(path.resolve('public/tracks')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  const cases: [string, string][] = [];
  ids.forEach((id, i) => cases.push([id, 'f1-2026'], [id, ['porsche-gt', 'ferrari-gt', 'nissan-gt', 'toyota-gt'][i % 4]]));
  for (const [tr, car] of cases) {
    it(`prejde 2 kolá: ${tr} / ${car}`, () => {
      const r = lapTest(tr, car, DIFF_PACE.hard);
      console.log(tr, car, 'lapy', r.lapTimes.map((x) => x.toFixed(1)).join(' / '), 's  mimo trate', r.offTime.toFixed(1), 's  max', r.maxOff.toFixed(1), 'm');
      expect(r.lapTimes.length).toBe(2);
      expect(r.maxOff).toBeLessThan(3);
    });
  }
});
