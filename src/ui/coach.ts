import { lapsLeftOf, type Sim } from '../sim/sim';

interface Cand { key: string; prio: number }

/**
 * Tréner: vyberie JEDNU aktuálnu správu. Správa ostáva zobrazená, kým ju nenahradí iná.
 * Nemá históriu, hlas ani upozornenia na jednotlivé zákruty.
 */
export class Coach {
  current = 'coach.start';
  private prio = 1;
  private since = 0;
  private clock = 0;
  private lastPrio = new Map<string, number>();

  update(race: Sim, dt: number): string {
    this.clock += dt;
    const cands = this.candidates(race);
    this.lastPrio.clear();
    for (const c of cands) this.lastPrio.set(c.key, c.prio);
    const best = cands.reduce((a, b) => (b.prio > a.prio ? b : a), cands[0]);
    const dwell = this.clock - this.since;
    const stillTrue = this.lastPrio.has(this.current);
    // vyššia priorita prebije po krátkom čase; inak čakáme, kým pôvodný stav pominie
    if (best.key !== this.current && ((best.prio > this.prio && dwell > 1.2) || (!stillTrue && dwell > 3) || (dwell > 8 && best.prio >= this.prio))) {
      this.current = best.key;
      this.prio = best.prio;
      this.since = this.clock;
    } else if (stillTrue) {
      this.prio = this.lastPrio.get(this.current)!;
    }
    return this.current;
  }

  private candidates(race: Sim): Cand[] {
    const p = race.player;
    const st = p.st;
    const w = race.weather;
    const track = race.track;
    const out: Cand[] = [{ key: 'coach.clear', prio: 0 }];
    const add = (key: string, prio: number) => out.push({ key, prio });
    const speed = Math.hypot(st.vx, st.vy);

    if (race.phase === 'grid' || race.phase === 'lights') {
      add('coach.start', 40);
      return out;
    }
    if (race.free) return this.worldCandidates(race, out);
    if (p.finished) { add('coach.finished', 90); return out; }
    if (race.phase === 'racing' && race.time < 4) add('coach.go', 30);

    const wear = Math.max(...st.wear);
    const dmg = Math.max(...st.damage);
    const lapFuel = p.fuelPerM * track.length;
    const lapsOfFuel = lapFuel > 0 ? st.fuel / lapFuel : 99;
    const lapsLeft = lapsLeftOf(race, p);
    const inPit = track.inPitLane(p.q);

    if (inPit) add('coach.pitLane', 50);
    const dur = race.cfg.durationS;
    if (dur != null && !p.finished && p.pit.stops < (race.cfg.mandatoryStops ?? 0)) {
      if (dur - race.time < dur * 0.2) add('coach.mustStopLate', 84);
      else add('coach.mustStop', 52);
    }
    if (p.pit.phase === 'exit' || (p.pit.stops > 0 && race.time - 0 > 0 && p.pit.phase === 'none' && p.pit.served)) add('coach.pitFresh', 35);

    // palivo, pneumatiky, poškodenie – len ak má zmysel zastavovať
    if (lapsLeft > 1.2) {
      if (lapsOfFuel < 0.7) add('coach.fuelCritical', 85);
      else if (lapsOfFuel < 1.6) add('coach.fuelLow', 60);
      if (wear > 0.85) add('coach.tyresDead', 80);
      else if (wear > 0.62) add('coach.tyresWorn', 58);
      if (dmg > 0.6) add('coach.damageHeavy', 75);
      else if (dmg > 0.25) add('coach.damage', 55);
    }

    if (p.surface === 'grass') add('coach.offTrack', 70);
    if (st.skid > 0.55 && speed > 20 && (w.wetness > 0.15 || st.tcActive)) add('coach.skid', 72);
    if (w.wetness > 0.35 && speed > 55 && st.brake < 0.1) add('coach.slowDown', 65);
    if (wear > 0.4 && dmg > 0.15 && speed < 20 && race.time > 10) add('coach.slowing', 20);

    // počasie
    if (w.rain > 0.7) add('coach.rainHeavy', 45);
    else if (w.rain > 0.04 && w.target > w.rain) add('coach.rainStart', 44);
    else if (w.rain > 0.02 && w.target < w.rain) add('coach.rainStop', 43);
    if (w.wetness > 0.3) add('coach.wet', 18);
    if (lapsLeft <= 1 && lapsLeft > 0) add('coach.lastLap', 25);
    return out;
  }

  /** Otvorený svet: bez kôl, cieľa a boxov – len počasie, palivo, poškodenie a tempo. */
  private worldCandidates(race: Sim, out: Cand[]): Cand[] {
    const p = race.player;
    const st = p.st;
    const w = race.weather;
    const add = (key: string, prio: number) => out.push({ key, prio });
    const speed = Math.hypot(st.vx, st.vy);
    const wear = Math.max(...st.wear);
    const dmg = Math.max(...st.damage);
    if (p.surface === 'grass') add('coach.offTrack', 70);
    if (st.skid > 0.55 && speed > 20 && (w.wetness > 0.15 || st.tcActive)) add('coach.skid', 72);
    if (w.wetness > 0.35 && speed > 55 && st.brake < 0.1) add('coach.slowDown', 65);
    if (dmg > 0.6) add('coach.damageHeavy', 75);
    else if (dmg > 0.25) add('coach.damage', 55);
    if (wear > 0.85) add('coach.tyresDead', 80);
    if (st.fuel / p.spec.fuelCapacity < 0.12) add('coach.fuelLowWorld', 60);
    if (w.rain > 0.7) add('coach.rainHeavy', 45);
    else if (w.rain > 0.04 && w.target > w.rain) add('coach.rainStart', 44);
    else if (w.rain > 0.02 && w.target < w.rain) add('coach.rainStop', 43);
    if (w.wetness > 0.3) add('coach.wet', 18);
    return out;
  }
}
