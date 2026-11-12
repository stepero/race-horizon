import { describe, expect, it } from 'vitest';
import { WORLDS, buildWorldTrack, findCrossings, selfIntersects } from '../src/sim/worldMap';
import { WorldSim } from '../src/sim/world';
import { Track } from '../src/sim/track';

const mk = (worldId: string, traffic: boolean, extra = {}) =>
  new WorldSim({ worldId, traffic, trafficCount: 12, playerTeamId: 'gt-porsche', playerName: 'Test', weather: 'dry', seed: 3, ...extra });

describe('Mapy otvorených svetov', () => {
  for (const w of WORLDS) {
    it(`${w.id}: uzavretá cesta bez pretnutia, rozumná dĺžka`, () => {
      const d = buildWorldTrack(w);
      expect(d.length).toBeCloseTo(d.n * d.ds, 3);
      expect(d.length).toBeGreaterThan(6000);
      expect(d.length).toBeLessThan(16000);
      const pts = d.x.map((x, i) => [x, d.y[i]]);
      expect(findCrossings(pts)).toHaveLength(0);
      expect(selfIntersects(pts, w.halfW * 2 + 14)).toBeNull();
      expect(new Set(d.z.map((v) => Math.sign(v))).size).toBeGreaterThan(0);
      // deterministické
      expect(buildWorldTrack(w).x.slice(0, 20)).toEqual(d.x.slice(0, 20));
      expect(new Track(d).length).toBeCloseTo(d.length, 3);
    });
  }
});

describe('WorldSim', () => {
  it('bez premávky: autopilot prejde úsek bez kôl/cieľa, výzvy sa vyhodnocujú', () => {
    const w = mk('world-coast', false);
    expect(w.traffic).toHaveLength(0);
    w.setPlayerAuto(true);
    for (let i = 0; i < 60 * 240; i++) w.advance(1 / 60);
    expect(w.player.finished).toBe(false);
    expect(w.player.lapsDone).toBe(0);
    expect(w.player.prog).toBeGreaterThan(2000);
    expect(w.phase).toBe('racing');
  });

  it('s premávkou: civili jazdia pomaly po trati a nevypadnú', () => {
    const w = mk('world-hills', true);
    expect(w.traffic).toHaveLength(12);
    w.setPlayerAuto(true);
    for (let i = 0; i < 90 * 60; i++) { w.advance(1 / 60); w.events.length = 0; }
    for (const c of w.traffic) {
      expect(Number.isFinite(c.st.x)).toBe(true);
      expect(c.st.vx).toBeLessThan(30);
      expect(Math.abs(c.q.d)).toBeLessThan(15);
    }
    expect(w.traffic.filter((c) => c.st.vx > 5).length).toBeGreaterThan(6);
  });

  it('výzvy: autopilot spustí aspoň jednu a tá sa skončí (hotová/nevyšla) s udalosťou', () => {
    const w = mk('world-coast', false);
    w.setPlayerAuto(true);
    const seen: string[] = [];
    for (let i = 0; i < 240 * 60; i++) {
      w.advance(1 / 60);
      for (const e of w.worldEvents.splice(0)) seen.push(e.type);
      if (seen.includes('done') || seen.includes('failed')) break;
    }
    expect(seen[0]).toBe('start');
    expect(seen.some((e) => e === 'done' || e === 'failed')).toBe(true);
    expect(w.active).toBeNull();
  });

  it('servis: státie dopĺňa palivo a opravuje', () => {
    const w = mk('world-coast', false);
    const p = w.player;
    p.st.fuel = 10; p.st.damage = [0.5, 0, 0, 0]; p.st.vx = 0;
    let svc = false;
    for (let i = 0; i < 60 * 8; i++) {
      p.st.vx = 0; p.st.vy = 0;
      w.advance(1 / 60);
      if (w.worldEvents.splice(0).some((e) => e.type === 'service')) svc = true;
    }
    expect(svc).toBe(true);
    expect(p.st.fuel).toBeGreaterThan(50);
    expect(Math.max(...p.st.damage)).toBe(0);
  });
});
