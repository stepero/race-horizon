import { CAR_MODEL_BY_ID, TEAMS, type CarClass, type Team } from '../data/catalog';
import { UPGRADE_STEP, type Upgrades } from '../sim/vehicle';
import { clamp } from '../sim/math';
import type { Difficulty } from '../sim/ai';
import type { EventKind, SeriesId } from './types';

/** Všetky číselné konštanty kariéry sú tu – dajú sa ľahko vyvážiť. */
export const MAX_LEVEL = 1000;
export const MAX_UPGRADE = 5;
export const CHAMP_RACES = 10;
export const FIELD = 20; // počet jazdcov v kvalifikácii a šampionáte
export const QUAL_ADVANCE = 5;
export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export interface Series {
  id: SeriesId;
  cls: CarClass;
  tier: 1 | 2 | 3;
  /** Od akého levelu je séria odomknutá. */
  unlockLevel: number;
  /** Nad týmto levelom už víťazstvá v sérii prinášajú čoraz menej bodov levelu. */
  ceiling: number;
  difficulty: Difficulty;
  laps: number;
  /** Násobok mincí. */
  mult: number;
}

export const SERIES: Series[] = [
  { id: 'gt1', cls: 'GT', tier: 1, unlockLevel: 0, ceiling: 300, difficulty: 'easy', laps: 3, mult: 1 },
  { id: 'gt2', cls: 'GT', tier: 2, unlockLevel: 200, ceiling: 550, difficulty: 'medium', laps: 4, mult: 1.5 },
  { id: 'gt3', cls: 'GT', tier: 3, unlockLevel: 450, ceiling: 800, difficulty: 'hard', laps: 5, mult: 2.2 },
  { id: 'f1', cls: 'F1', tier: 1, unlockLevel: 0, ceiling: 450, difficulty: 'medium', laps: 3, mult: 2.4 },
  { id: 'f2', cls: 'F1', tier: 2, unlockLevel: 200, ceiling: 700, difficulty: 'hard', laps: 4, mult: 3.2 },
  { id: 'f3', cls: 'F1', tier: 3, unlockLevel: 450, ceiling: 1000, difficulty: 'expert', laps: 5, mult: 4.4 },
];
export const SERIES_BY_ID = Object.fromEntries(SERIES.map((s) => [s.id, s])) as Record<SeriesId, Series>;

export const seriesOf = (cls: CarClass): Series[] => SERIES.filter((s) => s.cls === cls);
export const unlockedSeries = (cls: CarClass, level: number): Series[] => seriesOf(cls).filter((s) => level >= s.unlockLevel);
export const newlyUnlocked = (cls: CarClass, before: number, after: number): Series[] =>
  seriesOf(cls).filter((s) => before < s.unlockLevel && after >= s.unlockLevel);
export const topSeries = (cls: CarClass, level: number): Series => {
  const u = unlockedSeries(cls, level);
  return u[u.length - 1];
};

/** Tímy, ktoré možno vybrať na začiatku kariéry (F1 len slabšie tímy – prestup do lepších prichádza neskôr). */
export const START_F1_TEAMS = ['cadillac', 'haas', 'audi', 'rb'];

// ------------------------------------------------------------------ body, level, mince
const round5 = (v: number) => Math.round(v / 5) * 5;
const round10 = (v: number) => Math.round(v / 10) * 10;

export const racePoints = (pos: number): number => POINTS[pos - 1] ?? 0;

export const EVENT_WEIGHT: Record<EventKind, number> = { qual: 16, champ: 36, tourn: 30, regular: 22, base: 14, endurance: 40 };
const KIND_COINS: Record<EventKind, number> = { qual: 0.25, champ: 1, tourn: 0.9, regular: 0.6, base: 0.4, endurance: 1.6 };
const SHARE = [1, 0.75, 0.6, 0.5, 0.42, 0.35, 0.3, 0.25, 0.2, 0.16];
const shareOf = (pos: number) => SHARE[pos - 1] ?? 0.1;

/**
 * Zmena levelu po pretekoch: víťaz získa celú váhu, stred poľa ~0, posledný stratí 80 % váhy.
 * Nad stropom série zisky klesajú a straty rastú (nedá sa „farmiť“ level v najľahšej sérii).
 */
export function levelDelta(pos: number, n: number, weight: number, level: number, series: Series): number {
  if (n <= 1) return 0;
  const x = 1 - (2 * (pos - 1)) / (n - 1);
  const over = Math.max(0, level - series.ceiling);
  const d = x >= 0 ? weight * x * clamp(1 - over / 500, 0.1, 1) : weight * 0.8 * x * (1 + clamp(over / 500, 0, 1));
  return Math.round(d);
}

export function raceCoins(pos: number, series: Series, kind: EventKind, retired: boolean): number {
  const share = retired ? 0.05 : shareOf(pos);
  return round5(300 * series.mult * share * KIND_COINS[kind]);
}

export const champPrize = (pos: number, s: Series): number => round10(2500 * s.mult * (pos <= 10 ? shareOf(pos) : 0.05));
export const champLevelBonus = (pos: number, s: Series): number =>
  Math.round(([120, 80, 60, 40, 30, 20, 15, 10, 5, 5][pos - 1] ?? 0) * (1 + 0.25 * (s.tier - 1)));
export const tournPrize = (pos: number, s: Series): number => round10(800 * s.mult * (pos <= 10 ? shareOf(pos) : 0.05));
export const tournLevelBonus = (pos: number): number => [40, 25, 15, 8, 5][pos - 1] ?? 0;
export const qualBonus = (s: Series): number => round10(300 * s.mult);
export const goalReward = (cls: CarClass, level: number): number => round10(400 * topSeries(cls, level).mult);

// ------------------------------------------------------------------ vylepšenia
export const UPGRADE_KEYS = ['engine', 'tyres', 'brakes', 'wing', 'chassis'] as const;
export type UpgradeKey = (typeof UPGRADE_KEYS)[number];
const BASE_PRICE: Record<UpgradeKey, number> = { engine: 600, tyres: 400, brakes: 300, wing: 400, chassis: 500 };

/** Cena prechodu z úrovne `level` na `level + 1`; `null` pri maxime. Vylepšenia F1 áut sú drahšie. */
export function upgradePrice(key: UpgradeKey, level: number, cls: CarClass): number | null {
  if (level >= MAX_UPGRADE) return null;
  return round10(BASE_PRICE[key] * Math.pow(1 + level, 1.35) * (cls === 'F1' ? 2 : 1));
}

/** Účinok vylepšenia na danej úrovni v percentách (znamienko = smer zmeny parametra). */
export function upgradeEffects(key: UpgradeKey, level: number): { id: string; pct: number }[] {
  const S = UPGRADE_STEP;
  const p = (v: number) => Math.round(v * level * 1000) / 10;
  switch (key) {
    case 'engine': return [{ id: 'power', pct: p(S.engine) }];
    case 'tyres': return [{ id: 'grip', pct: p(S.tyresMu) }, { id: 'wear', pct: -p(S.tyresWear) }];
    case 'brakes': return [{ id: 'brake', pct: p(S.brakes) }];
    case 'wing': return [{ id: 'downforce', pct: p(S.wingDownforce) }, { id: 'drag', pct: p(S.wingDrag) }];
    case 'chassis': return [{ id: 'slip', pct: -p(S.chassisSlip) }, { id: 'mass', pct: -p(S.chassisMass) }];
  }
}

export function emptyUpgrades(): Upgrades { return { engine: 0, tyres: 0, brakes: 0, wing: 0, chassis: 0 }; }

// ------------------------------------------------------------------ tímy
/** Level, od ktorého sa o hráča tím zaujíma (používa sa pri ponukách prestupov). */
export function teamPrestige(team: Team): number {
  if (team.cls === 'F1') return Math.round(250 + ((team.tier - 0.64) / 0.36) * 650);
  return Math.round(clamp(((team.tier - 0.78) / 0.12) * 350, 0, 400));
}

/** Sila tímu v rámci jeho triedy 0..1. */
export function teamStrength(team: Team): number {
  return team.cls === 'F1' ? clamp((team.tier - 0.66) / 0.32, 0, 1) : clamp((team.tier - 0.8) / 0.1, 0, 1);
}

export function teamLabel(team: Team): string {
  return team.cls === 'F1' ? team.name : `${team.brand} – ${CAR_MODEL_BY_ID[team.car].name}`;
}

export const F1_TEAM_IDS = TEAMS.map((t) => t.id);

// ------------------------------------------------------------------ turnaje
export interface TournamentDef { id: string; tracks: string[] }
export const TOURNAMENTS: TournamentDef[] = [
  { id: 'europe', tracks: ['spa', 'monza', 'silverstone', 'barcelona'] },
  { id: 'asia', tracks: ['suzuka', 'shanghai', 'sepang', 'singapore'] },
  { id: 'america', tracks: ['miami', 'montreal', 'cota', 'interlagos'] },
];
