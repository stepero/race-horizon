import type { Difficulty } from '../sim/ai';
import type { WeatherMode } from '../sim/weather';
import type { Upgrades } from '../sim/vehicle';

export type SeriesId = 'gt1' | 'gt2' | 'gt3' | 'f1' | 'f2' | 'f3';
export type EventKind = 'qual' | 'champ' | 'tourn' | 'regular' | 'base' | 'endurance';
export type GoalKind = 'champPos' | 'wins' | 'podiums' | 'points';

export interface Profile {
  name: string;
  nickname: string;
  /** Kód krajiny (pozri profileData.ts). */
  country: string;
  /** Index avatara (pozri AVATARS). */
  avatar: number;
}

/** Cieľ sezóny od trénera tímu. */
export interface Goal {
  kind: GoalKind;
  target: number;
  /** Odmena v minciach (menšia ako cena za šampionát). */
  reward: number;
  /** Cieľ z minulej sezóny, ktorý sa skúša znova. */
  retry: boolean;
  done: boolean;
}

export interface SeasonStats {
  races: number;
  wins: number;
  podiums: number;
  /** Body získané v šampionáte tejto sezóny. */
  points: number;
}

export interface DriverTag { name: string; team: string; color: string }

/** Spoločné údaje šampionátu a turnaja (súčet bodov z viacerých pretekov). */
export interface Standings {
  tracks: string[];
  weather: WeatherMode[];
  /** Počet odjazdených kôl/pretekov. */
  round: number;
  points: Record<string, number>;
  wins: Record<string, number>;
  names: Record<string, DriverTag>;
  /** Tvoje poradie v jednotlivých pretekoch. */
  results: number[];
  done: boolean;
  finalPos: number | null;
  seriesId: SeriesId;
}

export interface ChampState extends Standings { kind: 'champ' }
export interface TournState extends Standings { kind: 'tourn'; id: string }

export interface Offer {
  kind: 'stay' | 'up' | 'side' | 'down';
  teamId: string;
  goal: Goal;
  /** Podpisový bonus v minciach. */
  signing: number;
}

export interface SeasonRecord {
  season: number;
  teamId: string;
  seriesId: SeriesId | null;
  finalPos: number | null;
  levelEnd: number;
  goalDone: boolean;
}

export interface Note { key: string; params?: Record<string, string | number> }

export interface RaceOutcome {
  kind: EventKind;
  seriesId: SeriesId;
  trackId: string;
  pos: number;
  n: number;
  retired: boolean;
  levelBefore: number;
  levelDelta: number;
  levelAfter: number;
  coins: number;
  /** Body do šampionátu/turnaja (0 pri voľných pretekoch). */
  points: number;
  notes: Note[];
}

export interface CareerEvent {
  kind: EventKind;
  seriesId: SeriesId;
  trackId: string;
  laps: number;
  weather: WeatherMode;
  opponents: number;
  difficulty: Difficulty;
  gridPos: number;
}

export interface Career {
  v: 1;
  id: string;
  created: number;
  updated: number;
  profile: Profile;
  teamId: string;
  level: number;
  coins: number;
  season: number;
  seed: number;
  /** Vylepšenia podľa tímu (každé auto má vlastné). */
  upgrades: Record<string, Upgrades>;
  /** Výsledky kvalifikácií v tejto sezóne (jeden pokus na sériu). */
  qual: Partial<Record<SeriesId, 'passed' | 'failed'>>;
  champ: ChampState | null;
  tourn: TournState | null;
  goal: Goal;
  stats: SeasonStats;
  /** Ponuky po skončení sezóny; kým nie je rozhodnuté, sezóna nepokračuje. */
  offers: Offer[] | null;
  history: SeasonRecord[];
  /** Rozohrané súťažné preteky (pri zatvorení hry sa zapíšu ako odstúpenie). */
  pending: CareerEvent | null;
  last: RaceOutcome | null;
  /** 24-hodinovka: raz za sezónu (spotrebuje sa pri výsledku, aj pri odstúpení). */
  endurance: { done: boolean };
  totals: { races: number; wins: number; podiums: number };
}

export interface ResultRow {
  id: string;
  name: string;
  team: string;
  color: string;
  pos: number;
  isPlayer: boolean;
}

export interface CareerMeta {
  id: string;
  nickname: string;
  name: string;
  level: number;
  season: number;
  teamId: string;
  updated: number;
}
