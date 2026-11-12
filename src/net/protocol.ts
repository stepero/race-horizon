/**
 * Spoločný protokol klient ↔ server (online preteky). Správy sú JSON objekty s poľom `t`.
 *
 * Model synchronizácie: každý klient simuluje VLASTNÉ auto (fyzika beží lokálne bez oneskorenia)
 * a ~20× za sekundu posiela jeho stav (`NetSnap`). Server drží miestnosti, štartovú sekvenciu,
 * chat a poradie a stavy áut preposiela ostatným hráčom v miestnosti. Cudzie autá sa u klienta
 * len interpolujú (nemajú fyziku) a pri zrážke sa správajú ako nepohyblivá prekážka.
 *
 * Súbor je čistý TypeScript bez závislostí – importuje ho klient (Vite) aj server (Node).
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8787;

export const LIMITS = {
  name: 18,
  roomName: 28,
  chat: 200,
  minPlayers: 2,
  maxPlayers: 12,
  maxRooms: 50,
  maxLaps: 20,
  /** Max. veľkosť jednej správy v bajtoch. */
  message: 16 * 1024,
} as const;

/** Frekvencia odosielania stavu auta klientom a preposielania serverom [Hz]. */
export const SNAP_HZ = 20;

export type NetWeather = 'dry' | 'dynamic' | 'rain';
export type NetClass = 'F1' | 'GT';
export type NetPit = 'none' | 'lane' | 'service' | 'exit';

export interface RoomSettings {
  trackId: string;
  laps: number;
  weather: NetWeather;
  cls: NetClass;
  maxPlayers: number;
}

export type RoomStatus = 'lobby' | 'loading' | 'racing';

/** Stav auta odoslaný jeho vlastníkom. `T` = čas simulácie odosielateľa (race.clock) [s]. */
export interface NetSnap {
  T: number;
  x: number; y: number; h: number;
  vx: number; vy: number; r: number;
  st: number; th: number; br: number;
  g: number; rpm: number;
  /** Prejdená vzdialenosť od štartu [m], dokončené kolá, cieľ. */
  prog: number; laps: number;
  fin: boolean; finT: number | null;
  best: number | null; last: number | null;
  pit: NetPit;
  dmg: [number, number, number, number];
}

export interface LobbyPlayer { id: string; name: string; teamId: string; ready: boolean }

export interface StandingRow {
  id: string; name: string; teamId: string;
  pos: number; laps: number; prog: number;
  fin: boolean; finT: number | null; best: number | null;
  /** Hráč odišiel z pretekov (DNF). */
  left: boolean;
}

export interface RoomInfo {
  id: string;
  name: string;
  hostId: string;
  settings: RoomSettings;
  status: RoomStatus;
  players: LobbyPlayer[];
  lastResults: StandingRow[] | null;
}

export interface RoomSummary { id: string; name: string; settings: RoomSettings; players: number; status: RoomStatus }

export interface GridSlot { id: string; name: string; teamId: string }

/** Správy klient → server. */
export type C2S =
  | { t: 'hello'; name: string; ver: number }
  | { t: 'list' }
  | { t: 'create'; name: string; settings: RoomSettings; teamId: string }
  | { t: 'join'; roomId: string; teamId: string }
  | { t: 'leave' }
  | { t: 'team'; teamId: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'start' }
  | { t: 'loaded' }
  | { t: 'state'; s: NetSnap }
  | { t: 'chat'; text: string };

/** Správy server → klient. Systémové správy chatu majú `from: null` a lokalizačný kľúč `key`. */
export type S2C =
  | { t: 'welcome'; id: string }
  | { t: 'rooms'; rooms: RoomSummary[] }
  | { t: 'room'; room: RoomInfo | null }
  | { t: 'chat'; from: string | null; name: string; text: string; key?: string; params?: Record<string, string | number> }
  | { t: 'start'; seed: number; settings: RoomSettings; grid: GridSlot[] }
  | { t: 'go' }
  | { t: 'states'; list: [string, NetSnap][] }
  | { t: 'left'; id: string }
  | { t: 'standings'; list: StandingRow[] }
  | { t: 'results'; list: StandingRow[] }
  | { t: 'error'; key: string };

// ------------------------------------------------------------------ validácia (server aj klient)
const ID_RE = /^[a-z0-9-]{1,40}$/;

/** Odstráni riadiace znaky, zlúči medzery a skráti text. */
export function sanitizeText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function validId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const optNum = (v: unknown, lo: number, hi: number) => v === null || num(v, lo, hi);

export function sanitizeSettings(v: unknown): RoomSettings | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (!validId(s.trackId)) return null;
  const weather = s.weather === 'rain' || s.weather === 'dynamic' ? s.weather : 'dry';
  const cls = s.cls === 'GT' ? 'GT' : 'F1';
  const laps = num(s.laps, 1, LIMITS.maxLaps) ? Math.round(s.laps) : 3;
  const maxPlayers = num(s.maxPlayers, LIMITS.minPlayers, LIMITS.maxPlayers) ? Math.round(s.maxPlayers) : 8;
  return { trackId: s.trackId, laps, weather, cls, maxPlayers };
}

const PITS: ReadonlySet<string> = new Set(['none', 'lane', 'service', 'exit']);

/** Overí stav auta od klienta (všetky čísla konečné a v rozumnom rozsahu). */
export function validSnap(v: unknown): v is NetSnap {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  const B = 1e6;
  if (!(num(s.T, 0, 1e6) && num(s.x, -B, B) && num(s.y, -B, B) && num(s.h, -1e4, 1e4) && num(s.vx, -500, 500) && num(s.vy, -500, 500)
    && num(s.r, -100, 100) && num(s.st, -2, 2) && num(s.th, 0, 1) && num(s.br, 0, 1) && num(s.g, -1, 12) && num(s.rpm, 0, 30000)
    && num(s.prog, -1e4, 1e7) && num(s.laps, 0, 10000))) return false;
  if (typeof s.fin !== 'boolean' || !optNum(s.finT, 0, 1e6) || !optNum(s.best, 0, 1e5) || !optNum(s.last, 0, 1e5)) return false;
  if (typeof s.pit !== 'string' || !PITS.has(s.pit)) return false;
  return Array.isArray(s.dmg) && s.dmg.length === 4 && s.dmg.every((d) => num(d, 0, 1));
}

/** Poradie podľa stavu áut: v cieli podľa času, potom podľa prejdenej vzdialenosti, odídení na koniec. */
export function rankStandings(rows: Omit<StandingRow, 'pos'>[]): StandingRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.left !== b.left) return a.left ? 1 : -1;
    if (a.fin && b.fin) return (a.finT ?? 0) - (b.finT ?? 0);
    if (a.fin !== b.fin) return a.fin ? -1 : 1;
    return b.prog - a.prog;
  });
  return sorted.map((r, i) => ({ ...r, pos: i + 1 }));
}
