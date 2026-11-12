import { buildSpec, type CarSpec, type SpecInput } from '../sim/vehicle';

/**
 * KATALÓG – jediné miesto, kam sa pridávajú nové autá, tímy, jazdci a trate.
 * Všetky 3D modely sú zatiaľ DOČASNÉ (procedurálne, `placeholder: true`) a dajú sa nahradiť
 * licencovanými modelmi cez pole `modelUrl` (pozri src/render/carModel.ts).
 */

export type CarClass = 'F1' | 'GT';

export interface Team {
  id: string;
  name: string;
  brand: string;
  cls: CarClass;
  color: string;
  color2: string;
  /** Výkonnosť auta 0..1 (ovplyvňuje tempo AI). */
  tier: number;
  car: string;
}

export interface Driver {
  id: string;
  name: string;
  code: string;
  number: number;
  nat: string;
  team: string;
  /** Zručnosť 0..1 */
  skill: number;
  real: boolean;
  reserve?: boolean;
}

export interface CarModel {
  id: string;
  name: string;
  brand: string;
  cls: CarClass;
  input: SpecInput;
  placeholder: true;
  modelUrl?: string;
}

export interface TrackInfo {
  id: string;
  name: string;
  gp: string;
  country: string;
  round: number | null;
  placeholder: boolean;
  fictional?: boolean;
}

// ------------------------------------------------------------------ autá
const F1_INPUT: SpecInput = {
  id: 'f1', mass: 800, fuelCapacity: 70, wheelbase: 3.6, weightRear: 0.55, hCg: 0.3, length: 5.5, width: 2.0,
  powerW: 750_000, redline: 12000, idle: 4000, launchRpm: 8500, wheelRadius: 0.34, driveEff: 0.92, rearDrive: 1,
  cdA: 1.1, clA: 3.8, aeroFront: 0.42, brakeMax: 36_000, brakeBias: 0.58, mu: 1.9, loadSens: 0.08, peakSlip: 0.1,
  maxSteer: 0.34, wearRate: 0.0021, shiftTime: 0.04, gears: 8, firstGearKph: 80, topGearKph: 365,
};

function gt(id: string, over: Partial<SpecInput>): SpecInput {
  return {
    id, mass: 1280, fuelCapacity: 100, wheelbase: 2.7, weightRear: 0.54, hCg: 0.45, length: 4.6, width: 2.0,
    powerW: 410_000, redline: 7600, idle: 1500, launchRpm: 5000, wheelRadius: 0.34, driveEff: 0.9, rearDrive: 1,
    cdA: 1.05, clA: 1.6, aeroFront: 0.4, brakeMax: 22_000, brakeBias: 0.6, mu: 1.55, loadSens: 0.1, peakSlip: 0.12,
    maxSteer: 0.4, wearRate: 0.0019, shiftTime: 0.1, gears: 6, firstGearKph: 85, topGearKph: 300,
    ...over,
  };
}

export const CAR_MODELS: CarModel[] = [
  { id: 'f1-2026', name: 'Formula 2026', brand: 'F1', cls: 'F1', input: F1_INPUT, placeholder: true },
  { id: 'ferrari-gt', name: '296 GT3', brand: 'Ferrari', cls: 'GT', placeholder: true, input: gt('ferrari-gt', { powerW: 420_000, mass: 1270, weightRear: 0.56 }) },
  { id: 'porsche-gt', name: '911 GT3 R', brand: 'Porsche', cls: 'GT', placeholder: true, input: gt('porsche-gt', { powerW: 405_000, mass: 1260, weightRear: 0.62, peakSlip: 0.11 }) },
  { id: 'lambo-gt', name: 'Huracán GT3', brand: 'Lamborghini', cls: 'GT', placeholder: true, input: gt('lambo-gt', { powerW: 430_000, mass: 1290, weightRear: 0.52, redline: 8200 }) },
  { id: 'mclaren-gt', name: '720S GT3', brand: 'McLaren', cls: 'GT', placeholder: true, input: gt('mclaren-gt', { powerW: 415_000, mass: 1250, clA: 1.7 }) },
  { id: 'mercedes-gt', name: 'AMG GT3', brand: 'Mercedes', cls: 'GT', placeholder: true, input: gt('mercedes-gt', { powerW: 420_000, mass: 1285, weightRear: 0.5 }) },
  { id: 'bmw-gt', name: 'M4 GT3', brand: 'BMW', cls: 'GT', placeholder: true, input: gt('bmw-gt', { powerW: 410_000, mass: 1265 }) },
  { id: 'nissan-gt', name: 'GT-R Nismo GT3', brand: 'Nissan', cls: 'GT', placeholder: true, input: gt('nissan-gt', { powerW: 405_000, mass: 1310, weightRear: 0.46, rearDrive: 0.8 }) },
  { id: 'toyota-gt', name: 'GR Supra GT', brand: 'Toyota', cls: 'GT', placeholder: true, input: gt('toyota-gt', { powerW: 395_000, mass: 1275, redline: 7200 }) },
];

export const CAR_MODEL_BY_ID: Record<string, CarModel> = Object.fromEntries(CAR_MODELS.map((c) => [c.id, c]));

const specCache = new Map<string, CarSpec>();
/** Špecifikácia auta; `tier` jemne posúva výkon tímu (0.5 = priemer). */
export function specFor(modelId: string, tier = 0.8): CarSpec {
  const key = `${modelId}:${tier.toFixed(3)}`;
  let s = specCache.get(key);
  if (!s) {
    const m = CAR_MODEL_BY_ID[modelId];
    const k = tier - 0.8;
    s = buildSpec({ ...m.input, powerW: m.input.powerW * (1 + 0.07 * k), clA: m.input.clA * (1 + 0.1 * k), mu: m.input.mu * (1 + 0.04 * k) });
    specCache.set(key, s);
  }
  return s;
}

// ------------------------------------------------------------------ tímy F1 (sezóna 2026)
const T = (id: string, name: string, brand: string, color: string, color2: string, tier: number): Team =>
  ({ id, name, brand, cls: 'F1', color, color2, tier, car: 'f1-2026' });

export const TEAMS: Team[] = [
  T('mercedes', 'Mercedes-AMG Petronas F1 Team', 'Mercedes', '#00d2be', '#111418', 0.98),
  T('mclaren', 'McLaren Mastercard F1 Team', 'McLaren', '#ff8000', '#1a2a4a', 0.96),
  T('ferrari', 'Scuderia Ferrari HP', 'Ferrari', '#e10600', '#ffd400', 0.95),
  T('redbull', 'Oracle Red Bull Racing', 'Red Bull', '#1e3cff', '#ffcc00', 0.93),
  T('williams', 'Atlassian Williams F1 Team', 'Williams', '#2f7bff', '#ffffff', 0.8),
  T('alpine', 'BWT Alpine F1 Team', 'Alpine', '#ff62c0', '#1d63ff', 0.78),
  T('aston', 'Aston Martin Aramco F1 Team', 'Aston Martin', '#00826b', '#c7f000', 0.76),
  T('rb', 'Visa Cash App Racing Bulls F1 Team', 'Racing Bulls', '#6692ff', '#ffffff', 0.75),
  T('audi', 'Audi Revolut F1 Team', 'Audi', '#c0c4c8', '#e2001a', 0.72),
  T('haas', 'TGR Haas F1 Team', 'Haas', '#e8e8e8', '#e10600', 0.7),
  T('cadillac', 'Cadillac Formula 1 Team', 'Cadillac', '#2a2d33', '#d4af37', 0.66),
];

export const CHASSIS: Record<string, string> = {
  mercedes: 'F1 W17', mclaren: 'MCL40', ferrari: 'SF-26', redbull: 'RB22', williams: 'FW48', alpine: 'A526',
  aston: 'AMR26', rb: 'VCARB 03', audi: 'R26', haas: 'VF-26', cadillac: 'MAC-26',
};

const D = (id: string, name: string, code: string, number: number, nat: string, team: string, skill: number, reserve = false): Driver =>
  ({ id, name, code, number, nat, team, skill, real: true, reserve });

export const F1_DRIVERS: Driver[] = [
  D('antonelli', 'Kimi Antonelli', 'ANT', 12, 'IT', 'mercedes', 0.94),
  D('russell', 'George Russell', 'RUS', 63, 'GB', 'mercedes', 0.95),
  D('norris', 'Lando Norris', 'NOR', 1, 'GB', 'mclaren', 0.96),
  D('piastri', 'Oscar Piastri', 'PIA', 81, 'AU', 'mclaren', 0.94),
  D('leclerc', 'Charles Leclerc', 'LEC', 16, 'MC', 'ferrari', 0.95),
  D('hamilton', 'Lewis Hamilton', 'HAM', 44, 'GB', 'ferrari', 0.93),
  D('verstappen', 'Max Verstappen', 'VER', 3, 'NL', 'redbull', 0.99),
  D('hadjar', 'Isack Hadjar', 'HAD', 6, 'FR', 'redbull', 0.85),
  D('albon', 'Alexander Albon', 'ALB', 23, 'TH', 'williams', 0.89),
  D('sainz', 'Carlos Sainz Jr.', 'SAI', 55, 'ES', 'williams', 0.9),
  D('gasly', 'Pierre Gasly', 'GAS', 10, 'FR', 'alpine', 0.88),
  D('colapinto', 'Franco Colapinto', 'COL', 43, 'AR', 'alpine', 0.79),
  D('alonso', 'Fernando Alonso', 'ALO', 14, 'ES', 'aston', 0.92),
  D('stroll', 'Lance Stroll', 'STR', 18, 'CA', 'aston', 0.8),
  D('lawson', 'Liam Lawson', 'LAW', 30, 'NZ', 'rb', 0.84),
  D('lindblad', 'Arvid Lindblad', 'LIN', 41, 'GB', 'rb', 0.8),
  D('tsunoda', 'Yuki Tsunoda', 'TSU', 22, 'JP', 'rb', 0.86, true),
  D('hulkenberg', 'Nico Hülkenberg', 'HUL', 27, 'DE', 'audi', 0.86),
  D('bortoleto', 'Gabriel Bortoleto', 'BOR', 5, 'BR', 'audi', 0.82),
  D('ocon', 'Esteban Ocon', 'OCO', 31, 'FR', 'haas', 0.86),
  D('bearman', 'Oliver Bearman', 'BEA', 87, 'GB', 'haas', 0.85),
  D('hirakawa', 'Ryo Hirakawa', 'HIR', 50, 'JP', 'haas', 0.75, true),
  D('camara', 'Rafael Câmara', 'CAM', 51, 'BR', 'haas', 0.74, true),
  D('perez', 'Sergio Pérez', 'PER', 11, 'MX', 'cadillac', 0.84),
  D('bottas', 'Valtteri Bottas', 'BOT', 77, 'FI', 'cadillac', 0.83),
];

export const TEAM_BY_ID: Record<string, Team> = Object.fromEntries(TEAMS.map((t) => [t.id, t]));

// ------------------------------------------------------------------ GT tímy a fiktívni jazdci
const G = (id: string, brand: string, color: string, color2: string, car: string, tier: number): Team =>
  ({ id, name: `${brand} Racing`, brand, cls: 'GT', color, color2, tier, car });

export const GT_TEAMS: Team[] = [
  G('gt-ferrari', 'Ferrari', '#d40000', '#ffe600', 'ferrari-gt', 0.9),
  G('gt-porsche', 'Porsche', '#e8e8e8', '#c8102e', 'porsche-gt', 0.9),
  G('gt-lambo', 'Lamborghini', '#8bd400', '#111111', 'lambo-gt', 0.88),
  G('gt-mclaren', 'McLaren', '#ff8000', '#101820', 'mclaren-gt', 0.88),
  G('gt-mercedes', 'Mercedes', '#00d2be', '#c0c0c0', 'mercedes-gt', 0.9),
  G('gt-bmw', 'BMW', '#1c69d4', '#e22718', 'bmw-gt', 0.86),
  G('gt-nissan', 'Nissan', '#b3002d', '#0a0a0a', 'nissan-gt', 0.82),
  G('gt-toyota', 'Toyota', '#eb0a1e', '#ffffff', 'toyota-gt', 0.8),
];
for (const t of GT_TEAMS) TEAM_BY_ID[t.id] = t;

/** Fiktívni jazdci pre výplň štartového poľa (nepoužívajú mená reálnych osôb). */
export const FICT_NAMES = [
  'Marek Hlinka', 'Tomáš Rybár', 'Lukas Brandt', 'Elena Vasquez', 'Jonas Keller', 'Mia Okafor', 'Daniel Novotný',
  'Sofia Lindqvist', 'Rafael Moreau', 'Anna Kováčová', 'Peter Šimko', 'Kenji Mori', 'Olivia Hart', 'Matej Urban',
  'Diego Santos', 'Ingrid Berg', 'Viktor Horák', 'Noah Fischer', 'Lucia Ferrari-Conti', 'Samuel Mráz', 'Hana Dvořáková',
  'Ethan Cole', 'Zuzana Polák', 'Adrián Tóth', 'Greta Hoff', 'Jakub Marek', 'Luca Bianchi', 'Ivana Kubiš', 'Oskar Dahl', 'Emil Sedlák',
];
export function fictionalDriver(i: number, team: string, skill: number): Driver {
  const name = FICT_NAMES[i % FICT_NAMES.length];
  const parts = name.split(' ');
  const code = (parts[parts.length - 1].replace(/[^A-Za-z]/g, '').slice(0, 3) || 'XXX').toUpperCase();
  return { id: `fx-${i}`, name, code, number: 100 + i, nat: 'SK', team, skill, real: false };
}

// ------------------------------------------------------------------ trate
const TI = (id: string, name: string, gp: string, country: string, round: number | null, placeholder: boolean, fictional = false): TrackInfo =>
  ({ id, name, gp, country, round, placeholder, fictional });

export const TRACKS: TrackInfo[] = [
  TI('horizon-park', 'Horizon Park', 'Race Horizon Cup', 'Slovensko (fiktívna trať)', null, false, true),
  TI('melbourne', 'Albert Park Circuit', 'Veľká cena Austrálie', 'Austrália', 1, false),
  TI('shanghai', 'Shanghai International Circuit', 'Veľká cena Číny', 'Čína', 2, false),
  TI('suzuka', 'Suzuka Circuit', 'Veľká cena Japonska', 'Japonsko', 3, false),
  TI('miami', 'Miami International Autodrome', 'Veľká cena Miami', 'USA', 4, true),
  TI('montreal', 'Circuit Gilles Villeneuve', 'Veľká cena Kanady', 'Kanada', 5, false),
  TI('monaco', 'Circuit de Monaco', 'Veľká cena Monaka', 'Monako', 6, true),
  TI('barcelona', 'Circuit de Barcelona-Catalunya', 'Veľká cena Barcelony-Katalánska', 'Španielsko', 7, false),
  TI('spielberg', 'Red Bull Ring', 'Veľká cena Rakúska', 'Rakúsko', 8, false),
  TI('silverstone', 'Silverstone Circuit', 'Veľká cena Británie', 'Spojené kráľovstvo', 9, false),
  TI('spa', 'Circuit de Spa-Francorchamps', 'Veľká cena Belgicka', 'Belgicko', 10, false),
  TI('hungaroring', 'Hungaroring', 'Veľká cena Maďarska', 'Maďarsko', 11, false),
  TI('zandvoort', 'Circuit Zandvoort', 'Veľká cena Holandska', 'Holandsko', 12, false),
  TI('monza', 'Autodromo Nazionale Monza', 'Veľká cena Talianska', 'Taliansko', 13, false),
  TI('madring', 'Madring', 'Veľká cena Španielska', 'Španielsko', 14, true),
  TI('baku', 'Baku City Circuit', 'Veľká cena Azerbajdžanu', 'Azerbajdžan', 15, true),
  TI('sepang', 'Sepang International Circuit', 'Bahrajnská VC v Malajzii', 'Malajzia', 16, false),
  TI('singapore', 'Marina Bay Street Circuit', 'Veľká cena Singapuru', 'Singapur', 17, true),
  TI('cota', 'Circuit of the Americas', 'Veľká cena USA', 'USA', 18, false),
  TI('mexico', 'Autódromo Hermanos Rodríguez', 'Veľká cena Mexika', 'Mexiko', 19, false),
  TI('interlagos', 'Autódromo José Carlos Pace', 'Veľká cena São Paula', 'Brazília', 20, false),
  TI('vegas', 'Las Vegas Strip Circuit', 'Veľká cena Las Vegas', 'USA', 21, true),
  TI('lusail', 'Lusail International Circuit', 'Veľká cena Kataru', 'Katar', 22, true),
  TI('yasmarina', 'Yas Marina Circuit', 'Veľká cena Abú Zabí', 'SAE', 23, false),
];
export const TRACK_BY_ID: Record<string, TrackInfo> = Object.fromEntries(TRACKS.map((t) => [t.id, t]));
