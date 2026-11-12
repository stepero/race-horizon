import type { Difficulty } from './sim/ai';
import type { WeatherMode } from './sim/weather';
import type { RoomSettings } from './net/protocol';

/** Mapovanie osi volantu/pedálov: normalizácia z hodnôt `rest` → `full`. */
export interface AxisMap {
  axis: number; // -1 = nepriradené
  rest: number;
  full: number;
}

export interface WheelSettings {
  enabled: boolean;
  deviceId: string;
  steer: AxisMap;
  throttle: AxisMap;
  brake: AxisMap;
  /** Tlačidlá (indexy) pre radenie; -1 = nepriradené. */
  up: number;
  down: number;
}

export interface RaceSetup {
  cls: 'F1' | 'GT';
  teamId: string;
  trackId: string;
  laps: number;
  opponents: number;
  difficulty: Difficulty;
  weather: WeatherMode;
  gridPos: number;
  consumption: number;
}

export interface WorldSetup {
  worldId: string;
  traffic: boolean;
  trafficCount: number;
  cls: 'F1' | 'GT';
  teamId: string;
  weather: WeatherMode;
}

export interface EnduranceSetup {
  cls: 'F1' | 'GT';
  teamId: string;
  trackId: string;
  difficulty: Difficulty;
  weather: WeatherMode;
}

export interface OnlineSetup {
  /** Adresa WebSocket servera; prázdne = predvolená (rovnaký počítač, port 8787). */
  server: string;
  roomName: string;
  room: RoomSettings;
  teamF1: string;
  teamGT: string;
}

export interface Settings {
  name: string;
  autoGear: boolean;
  abs: boolean;
  tc: 0 | 1 | 2;
  steerAssist: 0 | 1 | 2;
  minimap: boolean;
  camera: 'chase' | 'cockpit';
  steerSens: number;
  volume: number;
  wheel: WheelSettings;
  setup: RaceSetup;
  world: WorldSetup;
  endurance: EnduranceSetup;
  online: OnlineSetup;
}

const none = (): AxisMap => ({ axis: -1, rest: 0, full: 1 });

export const DEFAULT_SETTINGS: Settings = {
  name: 'Hráč',
  autoGear: true,
  abs: true,
  tc: 1,
  steerAssist: 1,
  minimap: true,
  camera: 'chase',
  steerSens: 1,
  volume: 0.5,
  wheel: { enabled: false, deviceId: '', steer: none(), throttle: none(), brake: none(), up: -1, down: -1 },
  setup: {
    cls: 'F1', teamId: 'ferrari', trackId: 'horizon-park', laps: 3, opponents: 11,
    difficulty: 'medium', weather: 'dry', gridPos: 8, consumption: 3,
  },
  world: { worldId: 'world-coast', traffic: true, trafficCount: 14, cls: 'GT', teamId: 'gt-porsche', weather: 'dry' },
  endurance: { cls: 'GT', teamId: 'gt-porsche', trackId: 'horizon-park', difficulty: 'medium', weather: 'dynamic' },
  online: {
    server: '', roomName: '', teamF1: 'ferrari', teamGT: 'gt-porsche',
    room: { trackId: 'horizon-park', laps: 3, weather: 'dry', cls: 'F1', maxPlayers: 8 },
  },
};

const KEY = 'race-horizon.settings.v1';

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    if (!(k in out)) continue;
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : typeof b === typeof v ? v : b;
  }
  return out as T;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
  } catch { /* súkromný režim – ignoruj */ }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignoruj */ }
}
