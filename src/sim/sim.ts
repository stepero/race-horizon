import type { Racer, RacePhase } from './race';
import type { Track } from './track';
import type { Weather } from './weather';
import type { Assists } from './vehicle';
import type { Challenge } from './world';

/** Najmenšie rozhranie, ktoré potrebuje vykresľovanie, HUD a tréner – spĺňa `Race` aj `WorldSim`. */
export interface Sim {
  readonly track: Track;
  readonly weather: Weather;
  readonly racers: Racer[];
  readonly player: Racer;
  readonly cfg: { laps: number; durationS?: number; mandatoryStops?: number; mixed?: boolean };
  readonly phase: RacePhase;
  readonly lights: number;
  readonly time: number;
  readonly sorted: Racer[];
  readonly assists: Assists;
  /** Otvorený svet: bez kôl, štartu a boxov. */
  readonly free?: boolean;
  readonly challenges?: Challenge[];
  readonly active?: Challenge | null;
}

/** Zostávajúce kolá hráča/auta: pri vytrvalostnom pretekoch odhad z času a posledného kola. */
export function lapsLeftOf(sim: Sim, r: Racer): number {
  const L = sim.track.length;
  const frac = r.prog / L - Math.floor(r.prog / L);
  const D = sim.cfg.durationS;
  if (D == null) return sim.cfg.laps - r.prog / L;
  if (sim.time >= D) return 1 - frac;
  return (D - sim.time) / (r.lastLap ?? L / 50) + (1 - frac);
}
