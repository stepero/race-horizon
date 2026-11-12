import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Track, type TrackData } from '../src/sim/track';
import { Race, type RaceConfig } from '../src/sim/race';

const load = (id: string) => new Track(JSON.parse(fs.readFileSync(path.resolve('public/tracks', `${id}.json`), 'utf8')) as TrackData);

function run(cfg: Partial<RaceConfig>, maxT = 900) {
  const track = load(cfg.trackId ?? 'horizon-park');
  const race = new Race({
    trackId: 'horizon-park', laps: 3, playerTeamId: 'ferrari', playerName: 'Test', opponents: 9,
    difficulty: 'hard', weather: 'dry', gridPos: 5, consumption: 1, seed: 1, ...cfg,
  }, track);
  race.setPlayerAuto(true);
  const pitIns: string[] = [];
  let movedBeforeGo = false;
  let t = 0;
  while (t < maxT && !race.allFinished) {
    race.advance(1 / 60);
    t += 1 / 60;
    if (race.phase !== 'racing' && race.racers.some((r) => Math.abs(r.st.vx) > 0.01)) movedBeforeGo = true;
    for (const e of race.events) if (e.type === 'pitIn' && e.racer) pitIns.push(e.racer.code);
    race.events.length = 0;
  }
  return { race, pitIns, movedBeforeGo, t };
}

describe('Preteky', () => {
  it('štartové svetlá držia autá, všetci dokončia, poradie je konzistentné', () => {
    const { race, movedBeforeGo } = run({});
    expect(movedBeforeGo).toBe(false);
    expect(race.allFinished).toBe(true);
    const cls = race.classification();
    expect(cls.map((r) => r.pos)).toEqual(cls.map((_, i) => i + 1));
    for (const r of cls) expect(r.lapTimes.length).toBe(3);
    const winner = cls[0];
    console.log('víťaz', winner.name, winner.finishT?.toFixed(1), 'najlepšie kolo', race.bestLapOverall?.t.toFixed(2),
      'zásahy', race.racers.reduce((a, r) => a + r.hits, 0));
  });

  it('AI zájde do boxov pri vysokej spotrebe, servis obnoví auto', () => {
    const { race, pitIns } = run({ consumption: 9, laps: 5, opponents: 5 }, 1400);
    console.log('zastávky', pitIns.join(','), race.racers.map((r) => `${r.code}:${r.pit.stops}`).join(' '));
    expect(pitIns.length).toBeGreaterThan(0);
    expect(race.allFinished).toBe(true);
    for (const r of race.racers) expect(r.st.fuel).toBeGreaterThan(0);
  });

  it('GT preteky v daždi s 20 autami prebehnú', () => {
    const { race } = run({ trackId: 'spielberg', playerTeamId: 'gt-porsche', opponents: 19, weather: 'rain', laps: 2 }, 900);
    expect(race.racers.length).toBe(20);
    expect(race.allFinished).toBe(true);
  });
});
