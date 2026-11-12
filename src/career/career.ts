import { FICT_NAMES, GT_TEAMS, TEAMS, TEAM_BY_ID, TRACKS, type Team } from '../data/catalog';
import type { RaceConfig } from '../sim/race';
import { clamp, mulberry32 } from '../sim/math';
import type { WeatherMode } from '../sim/weather';
import { COUNTRIES } from './profileData';
import {
  topSeries, CHAMP_RACES, EVENT_WEIGHT, FIELD, MAX_LEVEL, QUAL_ADVANCE, SERIES_BY_ID, SERIES, TOURNAMENTS,
  champLevelBonus, champPrize, emptyUpgrades, goalReward, levelDelta, newlyUnlocked, qualBonus, raceCoins, racePoints,
  MAX_UPGRADE, teamPrestige, teamStrength, tournLevelBonus, tournPrize, unlockedSeries, upgradePrice, type UpgradeKey,
} from './rules';
import type {
  Career, CareerEvent, ChampState, EventKind, Goal, GoalKind, Note, Offer, Profile, RaceOutcome, ResultRow, SeriesId, Standings, TournState,
} from './types';

const WEATHERS: WeatherMode[] = ['dry', 'dry', 'dynamic', 'dynamic', 'rain'];

const REAL_TRACKS = TRACKS.filter((t) => t.round != null).sort((a, b) => (a.round ?? 0) - (b.round ?? 0)).map((t) => t.id);

export const teamOf = (c: Career): Team => TEAM_BY_ID[c.teamId];
export const clsOf = (c: Career) => teamOf(c).cls;
const clsOfSeries = (sid: SeriesId) => SERIES_BY_ID[sid].cls;

// ------------------------------------------------------------------ vytvorenie
export function makeGoal(team: Team, level: number, rnd: () => number, retry = false): Goal {
  const s = teamStrength(team);
  const kinds: GoalKind[] = ['champPos', 'wins', 'podiums', 'points'];
  const kind = kinds[Math.floor(rnd() * kinds.length)];
  let target: number;
  switch (kind) {
    case 'champPos': target = Math.round(10 - 8 * s); break;
    case 'wins': target = Math.round(1 + 3 * s); break;
    case 'podiums': target = Math.round(2 + 4 * s); break;
    default: target = Math.round((40 + 130 * s) / 10) * 10; break;
  }
  return { kind, target, reward: goalReward(team.cls, level), retry, done: false };
}

export function createCareer(profile: Profile, teamId: string, now = Date.now(), seed = (Math.random() * 1e9) | 0): Career {
  const team = TEAM_BY_ID[teamId];
  if (!team) throw new Error(`Neznámy tím ${teamId}`);
  const rnd = mulberry32(seed);
  return {
    v: 1, id: `c${now.toString(36)}${Math.floor(rnd() * 1e6).toString(36)}`, created: now, updated: now,
    profile: { ...profile }, teamId, level: 0, coins: 0, season: 1, seed,
    upgrades: { [teamId]: emptyUpgrades() }, qual: {}, champ: null, tourn: null,
    goal: makeGoal(team, 0, rnd), stats: { races: 0, wins: 0, podiums: 0, points: 0 },
    offers: null, history: [], pending: null, last: null, endurance: { done: false },
    totals: { races: 0, wins: 0, podiums: 0 },
  };
}

/** Doplní chýbajúce polia pri načítaní staršieho/poškodeného uloženia. */
export function normalizeCareer(raw: unknown): Career | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Career;
  if (c.v !== 1 || !c.id || !c.profile || !TEAM_BY_ID[c.teamId]) return null;
  c.upgrades ??= {};
  c.upgrades[c.teamId] ??= emptyUpgrades();
  c.qual ??= {};
  c.history ??= [];
  c.stats ??= { races: 0, wins: 0, podiums: 0, points: 0 };
  c.totals ??= { races: 0, wins: 0, podiums: 0 };
  c.endurance ??= { done: false };
  c.level = clamp(Math.round(c.level ?? 0), 0, MAX_LEVEL);
  c.coins = Math.max(0, Math.round(c.coins ?? 0));
  return c;
}

// ------------------------------------------------------------------ udalosti
function gridFor(c: Career, n: number, salt: number): number {
  const rnd = mulberry32(c.seed + c.totals.races * 31 + salt);
  const expected = 1 + (1 - teamStrength(teamOf(c))) * (n - 1) * 0.75;
  return clamp(Math.round(expected + (rnd() - 0.5) * 4), 1, n);
}

function pickWeather(rnd: () => number): WeatherMode { return WEATHERS[Math.floor(rnd() * WEATHERS.length)]; }

export function qualTrack(c: Career, sid: SeriesId): string {
  const rnd = mulberry32(c.seed + c.season * 131 + SERIES.findIndex((s) => s.id === sid) * 17);
  return REAL_TRACKS[Math.floor(rnd() * REAL_TRACKS.length)];
}

function event(c: Career, kind: EventKind, sid: SeriesId, trackId: string, weather: WeatherMode, opponents: number, laps?: number): CareerEvent {
  const s = SERIES_BY_ID[sid];
  return { kind, seriesId: sid, trackId, laps: laps ?? s.laps, weather, opponents, difficulty: s.difficulty, gridPos: gridFor(c, opponents + 1, kind.length * 7 + trackId.length) };
}

export const eventQual = (c: Career, sid: SeriesId) => event(c, 'qual', sid, qualTrack(c, sid), 'dry', FIELD - 1, 3);
export const eventRegular = (c: Career, sid: SeriesId, trackId: string, weather: WeatherMode) => event(c, 'regular', sid, trackId, weather, 13);
export const eventBase = (c: Career) => event(c, 'base', unlockedSeries(clsOf(c), c.level)[0].id, 'horizon-park', 'dry', 11, 3);

/** 24-hodinovka: zmiešané pole (~30 áut), jeden okruh zo seedu, séria podľa najvyššie odomknutej úrovne. */
export const ENDURANCE_MIN = 24;
export function eventEndurance(c: Career): CareerEvent {
  const sid = topSeries(clsOf(c), c.level).id;
  const rnd = mulberry32(c.seed + c.season * 6151 + 77);
  const track = REAL_TRACKS[Math.floor(rnd() * REAL_TRACKS.length)];
  return { ...event(c, 'endurance', sid, track, pickWeather(rnd), ENDURANCE_OPPONENTS, 0), gridPos: 1 + Math.floor(rnd() * 3) };
}
export const ENDURANCE_OPPONENTS = 29;
/** Počet áut v triede hráča v 24-hodinovke (1/3 poľa je F1, zvyšok GT), vrátane hráča. */
export const enduranceClassSize = (cls: 'F1' | 'GT'): number => {
  const total = ENDURANCE_OPPONENTS + 1, f1 = Math.max(2, Math.round(total / 3));
  return cls === 'F1' ? f1 : total - f1;
};

/** Samostatná 24-hodinovka (z hlavného menu) prináša menšiu odmenu do najnovšej kariéry; sezónny príznak sa nemení. */
export const STANDALONE_ENDURANCE_SHARE = 0.3;
export function applyStandaloneEndurance(c: Career, rows: ResultRow[], retired = false): RaceOutcome {
  const series = SERIES_BY_ID[topSeries(clsOf(c), c.level).id];
  const me = rows.find((r) => r.isPlayer);
  const n = Math.max(2, rows.length);
  const pos = retired || !me ? n : me.pos;
  const before = c.level;
  const delta = Math.round(levelDelta(pos, n, EVENT_WEIGHT.endurance, c.level, series) * STANDALONE_ENDURANCE_SHARE);
  const coins = Math.round(raceCoins(pos, series, 'endurance', retired) * STANDALONE_ENDURANCE_SHARE / 5) * 5;
  c.level = clamp(before + delta, 0, MAX_LEVEL);
  c.coins += coins;
  const notes: Note[] = [{ key: 'note.standaloneEndurance', params: { pct: Math.round(STANDALONE_ENDURANCE_SHARE * 100) } }];
  for (const s of newlyUnlocked(clsOf(c), before, c.level)) notes.push({ key: 'note.unlock', params: { series: s.id } });
  c.updated = Date.now();
  return { kind: 'endurance', seriesId: series.id, trackId: '', pos, n, retired, levelBefore: before, levelDelta: c.level - before, levelAfter: c.level, coins, points: 0, notes };
}

export function eventChamp(c: Career): CareerEvent | null {
  const ch = c.champ;
  if (!ch || ch.done) return null;
  return event(c, 'champ', ch.seriesId, ch.tracks[ch.round], ch.weather[ch.round], FIELD - 1);
}
export function eventTourn(c: Career): CareerEvent | null {
  const tn = c.tourn;
  if (!tn || tn.done) return null;
  return event(c, 'tourn', tn.seriesId, tn.tracks[tn.round], tn.weather[tn.round], 15);
}

export function raceConfig(c: Career, ev: CareerEvent, seed = (Math.random() * 1e6) | 0): RaceConfig {
  const team = teamOf(c);
  const base: RaceConfig = {
    trackId: ev.trackId, laps: ev.laps, playerTeamId: c.teamId, playerName: c.profile.nickname || c.profile.name,
    opponents: ev.opponents, difficulty: ev.difficulty, weather: ev.weather, gridPos: ev.gridPos,
    consumption: 1 + 1.5 * SERIES_BY_ID[ev.seriesId].tier, seed, upgrades: c.upgrades[c.teamId] ?? emptyUpgrades(), playerTier: team.tier,
  };
  return ev.kind === 'endurance' ? enduranceConfig(base) : base;
}

/** Úprava základnej konfigurácie na 24-hodinovku (sdíleté s voľným režimom). */
export function enduranceConfig(base: RaceConfig): RaceConfig {
  return { ...base, laps: 0, durationS: base.durationS ?? ENDURANCE_MIN * 60, mandatoryStops: 1, mixed: true };
}

// ------------------------------------------------------------------ šampionát a turnaj
function newStandings(c: Career, sid: SeriesId, tracks: string[], salt: number): Standings {
  const rnd = mulberry32(c.seed + c.season * 977 + salt);
  return {
    seriesId: sid, tracks, weather: tracks.map(() => pickWeather(rnd)), round: 0,
    points: {}, wins: {}, names: {}, results: [], done: false, finalPos: null,
  };
}

export function champTracks(c: Career, sid: SeriesId): string[] {
  const rnd = mulberry32(c.seed + c.season * 4001 + SERIES.findIndex((s) => s.id === sid) * 13);
  const a = [...REAL_TRACKS];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, CHAMP_RACES).sort((x, y) => REAL_TRACKS.indexOf(x) - REAL_TRACKS.indexOf(y));
}

export function canQualify(c: Career, sid: SeriesId): boolean {
  return c.qual[sid] === undefined && unlockedSeries(clsOf(c), c.level).some((s) => s.id === sid);
}
export function canStartChamp(c: Career, sid: SeriesId): boolean {
  return !c.champ && c.qual[sid] === 'passed' && unlockedSeries(clsOf(c), c.level).some((s) => s.id === sid);
}
export function startChamp(c: Career, sid: SeriesId): void {
  if (!canStartChamp(c, sid)) return;
  c.champ = { kind: 'champ', ...newStandings(c, sid, champTracks(c, sid), 1) } as ChampState;
}
export function startTourn(c: Career, id: string, sid: SeriesId): void {
  const def = TOURNAMENTS.find((x) => x.id === id);
  if (!def || !unlockedSeries(clsOf(c), c.level).some((s) => s.id === sid)) return;
  c.tourn = { kind: 'tourn', id, ...newStandings(c, sid, def.tracks, 2 + id.length) } as TournState;
}

export interface StandRow { id: string; name: string; team: string; color: string; points: number; wins: number; isPlayer: boolean; pos: number }

export function standingsRows(st: Standings, c: Career): StandRow[] {
  const ids = new Set([...Object.keys(st.points), ...Object.keys(st.names), 'player']);
  const rows = [...ids].map((id) => {
    const tag = st.names[id];
    const team = teamOf(c);
    return {
      id, name: id === 'player' ? (c.profile.nickname || c.profile.name) : (tag?.name ?? id), team: id === 'player' ? team.name : (tag?.team ?? ''),
      color: id === 'player' ? team.color : (tag?.color ?? '#888'), points: st.points[id] ?? 0, wins: st.wins[id] ?? 0, isPlayer: id === 'player', pos: 0,
    };
  });
  rows.sort((a, b) => b.points - a.points || b.wins - a.wins || Number(a.isPlayer) - Number(b.isPlayer) || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.pos = i + 1; });
  return rows;
}

function addToStandings(st: Standings, rows: ResultRow[], retired: boolean): void {
  for (const r of rows) {
    st.names[r.id] = { name: r.name, team: r.team, color: r.color };
    const p = r.isPlayer && retired ? 0 : racePoints(r.pos);
    st.points[r.id] = (st.points[r.id] ?? 0) + p;
    if (r.pos === 1 && !(r.isPlayer && retired)) st.wins[r.id] = (st.wins[r.id] ?? 0) + 1;
  }
  st.points.player ??= 0;
}

// ------------------------------------------------------------------ výsledok pretekov
export function playerLast(rows: ResultRow[]): ResultRow[] {
  const others = rows.filter((r) => !r.isPlayer).sort((a, b) => a.pos - b.pos);
  const me = rows.find((r) => r.isPlayer);
  const out = others.map((r, i) => ({ ...r, pos: i + 1 }));
  if (me) out.push({ ...me, pos: out.length + 1 });
  return out;
}

export function applyResult(c: Career, ev: CareerEvent, rowsIn: ResultRow[], retired = false): RaceOutcome {
  const series = SERIES_BY_ID[ev.seriesId];
  const rows = retired ? playerLast(rowsIn) : rowsIn;
  const me = rows.find((r) => r.isPlayer);
  const n = ev.kind === 'endurance' ? Math.max(2, rows.length + (me ? 0 : 1)) : Math.max(rows.length, ev.opponents + 1);
  const pos = retired || !me ? n : me.pos;
  const notes: Note[] = [];
  const levelBefore = c.level;
  let delta = levelDelta(pos, n, EVENT_WEIGHT[ev.kind], c.level, series);
  let coins = raceCoins(pos, series, ev.kind, retired);
  let points = 0;

  if (ev.kind !== 'qual' && ev.kind !== 'base') {
    c.stats.races++;
    if (!retired && pos === 1) c.stats.wins++;
    if (!retired && pos <= 3) c.stats.podiums++;
  }
  c.totals.races++;
  if (!retired && pos === 1) c.totals.wins++;
  if (!retired && pos <= 3) c.totals.podiums++;

  if (ev.kind === 'qual') {
    const ok = !retired && pos <= QUAL_ADVANCE;
    c.qual[ev.seriesId] = ok ? 'passed' : 'failed';
    if (ok) { coins += qualBonus(series); notes.push({ key: 'note.qualPassed', params: { series: ev.seriesId } }); }
    else notes.push({ key: 'note.qualFailed', params: { series: ev.seriesId } });
  }

  if (ev.kind === 'endurance') c.endurance = { done: true };
  const st = ev.kind === 'champ' ? c.champ : ev.kind === 'tourn' ? c.tourn : null;
  if (st) {
    points = retired ? 0 : racePoints(pos);
    addToStandings(st, rows, retired);
    st.results.push(pos);
    st.round++;
    if (ev.kind === 'champ') c.stats.points = st.points.player ?? 0;
    if (st.round >= st.tracks.length) {
      st.done = true;
      const final = standingsRows(st, c).find((r) => r.isPlayer)!.pos;
      st.finalPos = final;
      if (ev.kind === 'champ') {
        const bonus = champLevelBonus(final, series), prize = champPrize(final, series);
        delta += bonus; coins += prize;
        notes.push({ key: 'note.champDone', params: { pos: final, level: bonus, coins: prize } });
      } else {
        const bonus = tournLevelBonus(final), prize = tournPrize(final, series);
        delta += bonus; coins += prize;
        notes.push({ key: 'note.tournDone', params: { pos: final, level: bonus, coins: prize } });
      }
    }
  }

  c.level = clamp(levelBefore + delta, 0, MAX_LEVEL);
  c.coins += coins;
  for (const s of newlyUnlocked(clsOf(c), levelBefore, c.level)) notes.push({ key: 'note.unlock', params: { series: s.id } });
  notes.push(...checkGoal(c));
  c.pending = null;
  const out: RaceOutcome = {
    kind: ev.kind, seriesId: ev.seriesId, trackId: ev.trackId, pos, n, retired, levelBefore, levelDelta: c.level - levelBefore, levelAfter: c.level,
    coins, points, notes,
  };
  c.last = out;
  c.updated = Date.now();
  return out;
}

/** Odstúpenie / zatvorenie hry počas pretekov – bez výsledkov súperov sa použijú syntetické. */
export function forfeit(c: Career, ev: CareerEvent, rows?: ResultRow[]): RaceOutcome {
  let r = rows;
  if (!r) {
    const st = ev.kind === 'champ' ? c.champ : ev.kind === 'tourn' ? c.tourn : null;
    const rnd = mulberry32(c.seed + c.totals.races * 53);
    const known = st ? Object.keys(st.names).filter((id) => id !== 'player') : [];
    if (st && known.length) {
      const order = known.map((id) => ({ id, k: (st.points[id] ?? 0) + rnd() * 30 })).sort((a, b) => b.k - a.k);
      r = order.map((o, i) => ({ id: o.id, name: st.names[o.id].name, team: st.names[o.id].team, color: st.names[o.id].color, pos: i + 1, isPlayer: false }));
    } else {
      r = Array.from({ length: ev.kind === 'endurance' ? enduranceClassSize(clsOfSeries(ev.seriesId)) - 1 : ev.opponents }, (_, i) => ({ id: `fx-${i}`, name: FICT_NAMES[i % FICT_NAMES.length], team: '', color: '#888', pos: i + 1, isPlayer: false }));
    }
  }
  return applyResult(c, ev, r, true);
}

/** Pri načítaní uloženia: rozohrané preteky sa berú ako odstúpenie (nedá sa „save-scumovať“). */
export function resolvePending(c: Career): RaceOutcome | null {
  const ev = c.pending;
  if (!ev) return null;
  return forfeit(c, ev);
}

// ------------------------------------------------------------------ ciele
function goalProgress(c: Career, g: Goal): { value: number; ok: boolean } {
  switch (g.kind) {
    case 'champPos': return { value: c.champ?.done ? (c.champ.finalPos ?? 99) : 99, ok: !!c.champ?.done && (c.champ.finalPos ?? 99) <= g.target };
    case 'wins': return { value: c.stats.wins, ok: c.stats.wins >= g.target };
    case 'podiums': return { value: c.stats.podiums, ok: c.stats.podiums >= g.target };
    case 'points': return { value: c.champ?.points.player ?? 0, ok: (c.champ?.points.player ?? 0) >= g.target };
  }
}
export const goalState = goalProgress;

function checkGoal(c: Career): Note[] {
  if (c.goal.done) return [];
  if (goalProgress(c, c.goal).ok) {
    c.goal.done = true;
    c.coins += c.goal.reward;
    return [{ key: 'note.goalDone', params: { coins: c.goal.reward } }];
  }
  return [];
}

// ------------------------------------------------------------------ koniec sezóny a ponuky
export const canEndSeason = (c: Career): boolean => !c.offers && !c.pending;

const posBonus = (p: number | null) => (p == null ? -80 : p === 1 ? 120 : p <= 3 ? 80 : p <= 5 ? 40 : p <= 10 ? 0 : -40);

export function makeOffers(c: Career, finalPos: number | null): Offer[] {
  const cur = teamOf(c);
  const pool = (cur.cls === 'F1' ? TEAMS : GT_TEAMS).filter((t) => t.id !== cur.id);
  const rnd = mulberry32(c.seed + c.season * 7919);
  const reach = c.level + posBonus(finalPos);
  const mult = SERIES_BY_ID[unlockedSeries(cur.cls, c.level).slice(-1)[0].id].mult;
  const mk = (kind: Offer['kind'], team: Team, signing: number, retry = false): Offer =>
    ({ kind, teamId: team.id, signing: Math.round(signing / 10) * 10, goal: makeGoal(team, c.level, rnd, retry) });
  const offers: Offer[] = [];
  const stayGoal = c.goal.done ? makeGoal(cur, c.level, rnd) : { ...c.goal, done: false, retry: true, reward: goalReward(cur.cls, c.level) };
  offers.push({ kind: 'stay', teamId: cur.id, signing: 0, goal: stayGoal });
  // lepšie tímy, ktoré si hráč svojou úrovňou a výsledkom „zaslúži“
  const up = pool.filter((t) => t.tier > cur.tier + 0.001 && teamPrestige(t) <= reach).sort((a, b) => b.tier - a.tier);
  for (const t of up.slice(0, 2)) offers.push(mk('up', t, 250 * mult));
  const side = pool.filter((t) => Math.abs(t.tier - cur.tier) <= 0.025 && !up.includes(t));
  if (side.length) offers.push(mk('side', side[Math.floor(rnd() * side.length)], 150 * mult));
  if (finalPos == null || finalPos > 10) {
    const down = pool.filter((t) => t.tier < cur.tier - 0.001).sort((a, b) => b.tier - a.tier);
    if (down.length) offers.push(mk('down', down[0], 100 * mult));
  }
  return offers;
}

export function endSeason(c: Career): Offer[] {
  const finalPos = c.champ?.done ? c.champ.finalPos : null;
  c.history.push({ season: c.season, teamId: c.teamId, seriesId: c.champ?.seriesId ?? null, finalPos, levelEnd: c.level, goalDone: c.goal.done });
  c.offers = makeOffers(c, finalPos);
  c.updated = Date.now();
  return c.offers;
}

export function acceptOffer(c: Career, index: number): void {
  const o = c.offers?.[index];
  if (!o) return;
  c.teamId = o.teamId;
  c.upgrades[o.teamId] ??= emptyUpgrades();
  c.coins += o.signing;
  c.goal = o.goal;
  c.season++;
  c.qual = {};
  c.champ = null;
  c.tourn = null;
  c.stats = { races: 0, wins: 0, podiums: 0, points: 0 };
  c.endurance = { done: false };
  c.offers = null;
  c.last = null;
  c.updated = Date.now();
}

// ------------------------------------------------------------------ vylepšenia
export function buyUpgrade(c: Career, key: UpgradeKey): boolean {
  const up = (c.upgrades[c.teamId] ??= emptyUpgrades());
  const price = upgradePrice(key, up[key], clsOf(c));
  if (price == null || up[key] >= MAX_UPGRADE || c.coins < price) return false;
  c.coins -= price;
  up[key]++;
  c.updated = Date.now();
  return true;
}

// ------------------------------------------------------------------ rebríček
export interface BoardRow { name: string; country: string; level: number; team: string; self: boolean }

/** Pevná skupina „ostatných hráčov“ – lokálna napodobenina rebríčka (online verzia príde s etapou 5). */
export function rivalBoard(): BoardRow[] {
  return FICT_NAMES.map((name, i) => {
    const r = mulberry32(i * 977 + 5);
    const level = Math.round(1000 * Math.pow(r(), 1.7));
    const team = [...TEAMS, ...GT_TEAMS][Math.floor(r() * (TEAMS.length + GT_TEAMS.length))];
    return { name, country: COUNTRIES[Math.floor(r() * COUNTRIES.length)].code, level, team: team.cls === 'F1' ? team.brand : team.brand + ' GT', self: false };
  });
}

export function leaderboard(own: { name: string; country: string; level: number; teamId: string; id: string }[], selfId: string | null): (BoardRow & { rank: number })[] {
  const mine: BoardRow[] = own.map((o) => {
    const tm = TEAM_BY_ID[o.teamId];
    return { name: o.name, country: o.country, level: o.level, team: tm ? (tm.cls === 'F1' ? tm.brand : tm.brand + ' GT') : '', self: o.id === selfId };
  });
  const all = [...mine, ...rivalBoard()].sort((a, b) => b.level - a.level || Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
  return all.map((r, i) => ({ ...r, rank: i + 1 }));
}
