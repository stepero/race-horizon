import { describe, expect, it } from 'vitest';
import {
  acceptOffer, applyResult, buyUpgrade, createCareer, endSeason, eventChamp, eventQual, forfeit, leaderboard, normalizeCareer,
  resolvePending, standingsRows, startChamp,
} from '../src/career/career';
import { CareerStore, type KV } from '../src/career/store';
import {
  CHAMP_RACES, MAX_LEVEL, champLevelBonus, levelDelta, racePoints, SERIES_BY_ID, unlockedSeries, upgradeEffects, upgradePrice,
} from '../src/career/rules';
import type { ResultRow } from '../src/career/types';

const profile = { name: 'Test Hráč', nickname: 'Tester', country: 'SK', avatar: 0 };
const mem = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };

function rows(n: number, playerPos: number): ResultRow[] {
  const out: ResultRow[] = [];
  let k = 0;
  for (let p = 1; p <= n; p++) {
    if (p === playerPos) out.push({ id: 'player', name: 'Tester', team: 'T', color: '#fff', pos: p, isPlayer: true });
    else out.push({ id: `d${k}`, name: `Jazdec ${k}`, team: 'X', color: '#888', pos: p, isPlayer: false }), k++;
  }
  return out;
}

describe('level a body', () => {
  it('víťazstvo pridáva, posledné miesto uberá, stred ~0', () => {
    const s = SERIES_BY_ID.gt1;
    expect(levelDelta(1, 20, 36, 100, s)).toBe(36);
    expect(levelDelta(20, 20, 36, 100, s)).toBeLessThan(0);
    expect(Math.abs(levelDelta(10, 19, 36, 100, s))).toBe(0);
  });
  it('nad stropom série zisky klesajú', () => {
    const s = SERIES_BY_ID.gt1;
    expect(levelDelta(1, 20, 36, 700, s)).toBeLessThan(levelDelta(1, 20, 36, 100, s));
  });
  it('level je v rozsahu 0..1000', () => {
    const c = createCareer(profile, 'gt-porsche');
    for (let i = 0; i < 80; i++) applyResult(c, eventQual(c, 'gt1'), rows(20, 20));
    expect(c.level).toBe(0);
    c.level = 999;
    for (let i = 0; i < 20; i++) applyResult(c, { ...eventQual(c, 'gt1'), kind: 'regular' }, rows(20, 1));
    expect(c.level).toBeLessThanOrEqual(MAX_LEVEL);
  });
  it('body F1 systému', () => { expect(racePoints(1)).toBe(25); expect(racePoints(10)).toBe(1); expect(racePoints(11)).toBe(0); });
});

describe('kariéra', () => {
  it('tím určuje auto a kariéra začína na leveli 0', () => {
    const c = createCareer(profile, 'haas');
    expect(c.level).toBe(0); expect(c.teamId).toBe('haas');
  });
  it('kvalifikácia: postup len prvých 5 a nedá sa opakovať', () => {
    const c = createCareer(profile, 'gt-toyota');
    const out = applyResult(c, eventQual(c, 'gt1'), rows(20, 4));
    expect(c.qual.gt1).toBe('passed');
    expect(out.coins).toBeGreaterThan(0);
    const c2 = createCareer(profile, 'gt-toyota');
    applyResult(c2, eventQual(c2, 'gt1'), rows(20, 6));
    expect(c2.qual.gt1).toBe('failed');
  });
  it('šampionát: 10 pretekov, súčet bodov, bonus podľa poradia', () => {
    const c = createCareer(profile, 'gt-toyota');
    c.qual.gt1 = 'passed';
    startChamp(c, 'gt1');
    expect(c.champ?.tracks.length).toBe(CHAMP_RACES);
    let last;
    for (let i = 0; i < CHAMP_RACES; i++) { const ev = eventChamp(c)!; last = applyResult(c, ev, rows(20, 1)); }
    expect(c.champ!.done).toBe(true);
    expect(c.champ!.finalPos).toBe(1);
    expect(c.champ!.points.player).toBe(250);
    expect(last!.notes.some((n) => n.key === 'note.champDone')).toBe(true);
    expect(standingsRows(c.champ!, c)[0].isPlayer).toBe(true);
    expect(eventChamp(c)).toBeNull();
  });
  it('odomykanie sérií podľa levelu', () => {
    expect(unlockedSeries('GT', 0).map((s) => s.id)).toEqual(['gt1']);
    expect(unlockedSeries('GT', 450).map((s) => s.id)).toEqual(['gt1', 'gt2', 'gt3']);
  });
  it('odstúpenie sa počíta ako posledné miesto bez bodov', () => {
    const c = createCareer(profile, 'gt-toyota');
    c.level = 100;
    c.qual.gt1 = 'passed'; startChamp(c, 'gt1');
    const out = applyResult(c, eventChamp(c)!, rows(20, 3), true);
    expect(out.pos).toBe(20); expect(out.levelDelta).toBeLessThan(0); expect(c.champ!.points.player).toBe(0);
  });
  it('rozohrané preteky sa pri načítaní zapíšu ako odstúpenie', () => {
    const c = createCareer(profile, 'gt-toyota');
    c.qual.gt1 = 'passed'; startChamp(c, 'gt1');
    c.level = 100;
    applyResult(c, eventChamp(c)!, rows(20, 2));
    c.pending = eventChamp(c)!;
    const before = c.champ!.round;
    const out = resolvePending(c);
    expect(out?.retired).toBe(true); expect(c.champ!.round).toBe(before + 1); expect(c.pending).toBeNull();
    expect(forfeit).toBeTypeOf('function');
  });
});

describe('vylepšenia', () => {
  it('nákup stojí mince, zvyšuje úroveň a končí na maxime', () => {
    const c = createCareer(profile, 'gt-bmw');
    expect(buyUpgrade(c, 'engine')).toBe(false);
    c.coins = 1_000_000;
    for (let i = 0; i < 10; i++) buyUpgrade(c, 'engine');
    expect(c.upgrades['gt-bmw'].engine).toBe(5);
    expect(upgradePrice('engine', 5, 'GT')).toBeNull();
    expect(upgradePrice('engine', 2, 'F1')!).toBeGreaterThan(upgradePrice('engine', 2, 'GT')!);
    expect(upgradeEffects('engine', 2)[0].pct).toBeCloseTo(6, 5);
  });
  it('vylepšenia sú viazané na auto/tím', () => {
    const c = createCareer(profile, 'gt-bmw');
    c.coins = 5000; buyUpgrade(c, 'tyres');
    c.offers = [{ kind: 'side', teamId: 'gt-nissan', signing: 0, goal: c.goal }];
    acceptOffer(c, 0);
    expect(c.upgrades['gt-nissan'].tyres).toBe(0);
    expect(c.upgrades['gt-bmw'].tyres).toBe(1);
  });
});

describe('sezóna a ponuky', () => {
  it('po sezóne prídu ponuky a po prijatí začne nová sezóna s novým cieľom', () => {
    const c = createCareer(profile, 'cadillac');
    c.level = 600; c.qual.f1 = 'passed'; startChamp(c, 'f1');
    for (let i = 0; i < CHAMP_RACES; i++) applyResult(c, eventChamp(c)!, rows(20, 1));
    const offers = endSeason(c);
    expect(offers[0].kind).toBe('stay');
    expect(offers.some((o) => o.kind === 'up')).toBe(true);
    const upIdx = offers.findIndex((o) => o.kind === 'up');
    const target = offers[upIdx].teamId;
    acceptOffer(c, upIdx);
    expect(c.teamId).toBe(target); expect(c.season).toBe(2); expect(c.champ).toBeNull(); expect(c.offers).toBeNull(); expect(c.qual).toEqual({});
  });
  it('slabý level a zlé výsledky neprinesú lepšie tímy', () => {
    const c = createCareer(profile, 'cadillac');
    c.champ = null;
    const offers = endSeason(c);
    expect(offers.some((o) => o.kind === 'up')).toBe(false);
  });
  it('bonus za šampionát klesá s poradím', () => {
    const s = SERIES_BY_ID.f1;
    expect(champLevelBonus(1, s)).toBeGreaterThan(champLevelBonus(5, s));
    expect(champLevelBonus(11, s)).toBe(0);
  });
});

describe('ukladanie a rebríček', () => {
  it('viac slotov, načítanie, mazanie', () => {
    const store = new CareerStore(mem());
    const a = createCareer(profile, 'gt-bmw'); const b = createCareer({ ...profile, nickname: 'B' }, 'haas');
    store.save(a); store.save(b);
    expect(store.list().length).toBe(2);
    expect(store.load(a.id)?.teamId).toBe('gt-bmw');
    store.delete(a.id);
    expect(store.list().map((m) => m.id)).toEqual([b.id]);
    expect(store.load(a.id)).toBeNull();
  });
  it('poškodené uloženie sa odmietne', () => {
    expect(normalizeCareer({ v: 1, id: 'x', profile, teamId: 'neexistuje' })).toBeNull();
    expect(normalizeCareer(null)).toBeNull();
  });
  it('rebríček je zoradený podľa levelu a obsahuje hráča', () => {
    const a = createCareer(profile, 'gt-bmw'); a.level = 1000;
    const lb = leaderboard([{ name: 'Tester', country: 'SK', level: 1000, teamId: a.teamId, id: a.id }], a.id);
    expect(lb[0].level).toBe(1000);
    for (let i = 1; i < lb.length; i++) expect(lb[i - 1].level).toBeGreaterThanOrEqual(lb[i].level);
    expect(lb.some((r) => r.self)).toBe(true);
  });
});

describe('24-hodinovka v kariére', () => {
  it('sezónny pretek sa dá odjazdiť raz za sezónu, ďalšia sezóna ho odomkne', async () => {
    const m = await import('../src/career/career');
    const c = m.createCareer({ name: 'T', nickname: 'T', country: 'SK', avatar: 0 }, 'gt-porsche');
    expect(c.endurance.done).toBe(false);
    const ev = m.eventEndurance(c);
    expect(ev.kind).toBe('endurance');
    expect(ev.opponents).toBe(29);
    const cfg = m.raceConfig(c, ev, 1);
    expect(cfg.durationS).toBe(24 * 60);
    expect(cfg.mixed).toBe(true);
    expect(cfg.mandatoryStops).toBe(1);
    const n = m.enduranceClassSize('GT');
    const rows = Array.from({ length: n }, (_, i) => ({ id: i === 2 ? 'player' : `x${i}`, name: `x${i}`, team: '', color: '#888', pos: i + 1, isPlayer: i === 2 }));
    const out = m.applyResult(c, ev, rows);
    expect(out.n).toBe(n);
    expect(out.pos).toBe(3);
    expect(c.endurance.done).toBe(true);
    expect(c.stats.races).toBe(1);
  });

  it('odstúpenie spotrebuje sezónnu 24-hodinovku', async () => {
    const m = await import('../src/career/career');
    const c = m.createCareer({ name: 'T', nickname: 'T', country: 'SK', avatar: 0 }, 'gt-porsche');
    const ev = m.eventEndurance(c);
    const out = m.forfeit(c, ev);
    expect(out.retired).toBe(true);
    expect(c.endurance.done).toBe(true);
    expect(out.n).toBe(m.enduranceClassSize('GT'));
  });

  it('samostatná 24-hodinovka dá menšiu odmenu a nemení sezónny príznak', async () => {
    const m = await import('../src/career/career');
    const c = m.createCareer({ name: 'T', nickname: 'T', country: 'SK', avatar: 0 }, 'gt-porsche');
    c.level = 100;
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i === 0 ? 'player' : `x${i}`, name: `x${i}`, team: '', color: '#888', pos: i + 1, isPlayer: i === 0 }));
    const before = c.coins;
    const out = m.applyStandaloneEndurance(c, rows);
    expect(out.coins).toBeGreaterThan(0);
    expect(c.coins).toBe(before + out.coins);
    expect(c.endurance.done).toBe(false);
    const ev = m.eventEndurance(c);
    const full = m.applyResult(m.createCareer({ name: 'T', nickname: 'T', country: 'SK', avatar: 0 }, 'gt-porsche'), ev, rows);
    expect(out.coins).toBeLessThan(full.coins);
  });
});
