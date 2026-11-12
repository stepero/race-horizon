import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Track, type TrackData } from '../src/sim/track';
import { Race, type RaceConfig } from '../src/sim/race';
import { lapsLeftOf } from '../src/sim/sim';
import { enduranceConfig } from '../src/career/career';

const load = (id: string) => new Track(JSON.parse(fs.readFileSync(path.resolve('public/tracks', `${id}.json`), 'utf8')) as TrackData);

function makeCfg(over: Partial<RaceConfig> = {}): RaceConfig {
  return enduranceConfig({
    trackId: 'monaco', laps: 0, playerTeamId: 'gt-porsche', playerName: 'Test', opponents: 29, difficulty: 'hard',
    weather: 'dry', gridPos: 3, consumption: 2.5, seed: 4, ...over,
  });
}

describe('24-hodinovka', () => {
  it('zmiešané pole: ~30 áut, tretina F1, hráč v bloku svojej triedy', () => {
    const race = new Race(makeCfg(), load('monaco'));
    expect(race.racers.length).toBe(30);
    const f1 = race.racers.filter((r) => r.cls === 'F1').length;
    expect(f1).toBe(10);
    expect(race.player.cls).toBe('GT');
    const first = race.sorted.length;
    expect(first).toBe(30);
    const ids = new Set(race.racers.map((r) => r.id));
    expect(ids.size).toBe(30);
    const f1p = new Race(makeCfg({ playerTeamId: 'ferrari' }), load('monaco'));
    expect(f1p.racers.length).toBe(30);
    expect(f1p.racers.filter((r) => r.cls === 'F1').length).toBe(10);
    expect(f1p.player.cls).toBe('F1');
  });

  it('lapsLeftOf pri vytrvalosti klesá s časom', () => {
    const race = new Race(makeCfg({ durationS: 300 }), load('monaco'));
    const a = lapsLeftOf(race, race.player);
    race.time = 150;
    const b = lapsLeftOf(race, race.player);
    expect(b).toBeLessThan(a);
  });

  it('pretek skončí časom, víťaz má najviac kôl, povinná zastávka sa dodrží', () => {
    const dur = 420;
    const race = new Race(makeCfg({ durationS: dur, opponents: 11, gridPos: 3 }), load('monaco'));
    race.setPlayerAuto(true);
    const stops = new Map<string, number>();
    let t = 0;
    while (t < dur + 300 && !race.allFinished) {
      race.advance(1 / 30, 80);
      t += 1 / 30;
      for (const e of race.events) if (e.type === 'pitDone' && e.racer) stops.set(e.racer.id, (stops.get(e.racer.id) ?? 0) + 1);
      race.events.length = 0;
    }
    expect(race.allFinished).toBe(true);
    const cls = race.classification();
    for (const r of cls) {
      expect(r.finished).toBe(true);
      expect(r.finishT!).toBeGreaterThanOrEqual(dur - 1e-6);
    }
    // poradie: najprv tí, čo splnili povinnú zastávku, podľa kôl
    const ok = cls.filter((r) => !r.dq);
    for (let i = 1; i < ok.length; i++) expect(ok[i - 1].lapsDone).toBeGreaterThanOrEqual(ok[i].lapsDone);
    const dqIdx = cls.findIndex((r) => r.dq);
    if (dqIdx >= 0) expect(cls.slice(dqIdx).every((r) => r.dq)).toBe(true);
    const stopped = cls.filter((r) => r.pit.stops >= 1).length;
    console.log('24h skratená: kolá víťaza', cls[0].lapsDone, 'zastávky', stopped, '/', cls.length, 'dq', cls.filter((r) => r.dq).length);
    expect(stopped).toBeGreaterThan(cls.length / 2);
  }, 120000);
});
