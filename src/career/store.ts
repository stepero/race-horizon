import type { Career, CareerMeta } from './types';
import { normalizeCareer } from './career';

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const INDEX = 'race-horizon.careers.v1';
const SLOT = (id: string) => `race-horizon.career.v1.${id}`;
export const MAX_SLOTS = 8;

class MemoryKV implements KV {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

/** Viac uložených kariér (sloty). Pri nedostupnom localStorage (súkromný režim) ostane len pamäť. */
export class CareerStore {
  constructor(private kv: KV = defaultKV()) {}

  list(): CareerMeta[] {
    try {
      const raw = this.kv.getItem(INDEX);
      const arr = raw ? (JSON.parse(raw) as CareerMeta[]) : [];
      return Array.isArray(arr) ? arr.filter((m) => m && m.id).sort((a, b) => b.updated - a.updated) : [];
    } catch { return []; }
  }

  load(id: string): Career | null {
    try {
      const raw = this.kv.getItem(SLOT(id));
      return raw ? normalizeCareer(JSON.parse(raw)) : null;
    } catch { return null; }
  }

  save(c: Career): boolean {
    try {
      c.updated = Date.now();
      this.kv.setItem(SLOT(c.id), JSON.stringify(c));
      const meta: CareerMeta = { id: c.id, nickname: c.profile.nickname, name: c.profile.name, level: c.level, season: c.season, teamId: c.teamId, updated: c.updated };
      const rest = this.list().filter((m) => m.id !== c.id);
      this.kv.setItem(INDEX, JSON.stringify([meta, ...rest]));
      return true;
    } catch { return false; }
  }

  delete(id: string): void {
    try {
      this.kv.removeItem(SLOT(id));
      this.kv.setItem(INDEX, JSON.stringify(this.list().filter((m) => m.id !== id)));
    } catch { /* ignoruj */ }
  }

  get full(): boolean { return this.list().length >= MAX_SLOTS; }
}

function defaultKV(): KV {
  try { if (typeof localStorage !== 'undefined') { localStorage.getItem('x'); return localStorage; } } catch { /* pamäť */ }
  return new MemoryKV();
}
