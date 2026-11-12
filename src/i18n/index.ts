import { sk } from './sk';

/** Lokalizácia. Ďalší jazyk = nový súbor (napr. en.ts) so zhodnými kľúčmi a zápis do `LOCALES`. */
export type Dict = Record<string, string>;

export const LOCALES: Record<string, Dict> = { sk };
let current = 'sk';

export function setLocale(code: string): void {
  if (LOCALES[code]) current = code;
}
export function getLocale(): string {
  return current;
}

export function t(key: string, params?: Record<string, string | number>): string {
  let s = LOCALES[current]?.[key] ?? LOCALES.sk[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
