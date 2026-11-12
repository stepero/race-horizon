import {
  PHYS_DT, createVehicleState, shiftGear, stepVehicle, applyUpgrades, NO_UPGRADES,
  type Assists, type CarSpec, type DriveInput, type Upgrades, type VehicleEnv, type VehicleState,
} from './vehicle';
import { PIT_LIMIT, Track, type TrackQuery } from './track';
import { DIFF_PACE, driveAI, type AIState, type Difficulty } from './ai';
import { Weather, type WeatherMode } from './weather';
import { clamp, lerp, mulberry32, smoothstep } from './math';
import { carCollisions, wallCollision } from './collide';
import {
  F1_DRIVERS, GT_TEAMS, TEAMS, TEAM_BY_ID, fictionalDriver, specFor,
  type CarClass, type Driver, type Team,
} from '../data/catalog';
import { lapsLeftOf } from './sim';
import type { GridSlot } from '../net/protocol';

export interface RaceConfig {
  trackId: string;
  laps: number;
  playerTeamId: string;
  playerName: string;
  opponents: number;
  difficulty: Difficulty;
  weather: WeatherMode;
  /** Štartová pozícia hráča (1 = pole position). */
  gridPos: number;
  /** Násobok spotreby paliva a opotrebenia pneumatík (1 = štandard). */
  consumption: number;
  seed: number;
  upgrades?: Upgrades;
  /** Výkonnosť hráčovho auta 0..1 (kariéra: podľa tímu). Predvolene 0.8 – rovnaké pre všetky tímy. */
  playerTier?: number;
  /** Vytrvalostný pretek: dĺžka v sekundách herného času namiesto počtu kôl. Po uplynutí končí každé auto prejazdom cez cieľ. */
  durationS?: number;
  /** Povinný počet zastávok v boxoch (vytrvalostný pretek); bez nich je auto v cieli zaradené na koniec. */
  mandatoryStops?: number;
  /** Zmiešané pole F1 + GT. `gridPos` potom znamená pozíciu v rámci vlastnej triedy. */
  mixed?: boolean;
  /**
   * Online preteky: štartový rošt tvoria len ľudia (poradie určil server). Auto s `selfId` ovláda hráč,
   * ostatné sú vzdialené (`Racer.remote`) – nemajú fyziku, ich stav prichádza zo siete.
   */
  online?: { selfId: string; grid: GridSlot[] };
}

export type RacePhase = 'grid' | 'lights' | 'racing';
export type PitPhase = 'none' | 'lane' | 'service' | 'exit';

export interface PitState {
  phase: PitPhase;
  slot: number;
  boxS: number;
  boxLat: number;
  /** Uplynutý čas servisu [s] a plán prác. */
  t: number;
  plan: { tyres: number; fuel: number; repair: number };
  total: number;
  /** Servis už prebehol pri tomto vjazde (zabráni opakovaniu v tom istom boxe). */
  served: boolean;
  stops: number;
  startFuel: number;
  startDamage: [number, number, number, number];
}

export interface Racer {
  idx: number;
  id: string;
  name: string;
  code: string;
  number: number;
  color: string;
  color2: string;
  teamName: string;
  modelId: string;
  isPlayer: boolean;
  real: boolean;
  /** Trieda auta (F1 / GT) – pri zmiešanom poli sa poradie v triede počíta zvlášť. */
  cls: CarClass;
  /** Dojazd bez povinnej zastávky (vytrvalostný pretek) – radí sa na koniec. */
  dq: boolean;
  spec: CarSpec;
  st: VehicleState;
  ai: AIState;
  input: DriveInput;
  q: TrackQuery;
  hint: number;
  lastS: number;
  /** Prejdená vzdialenosť od štartovej čiary (môže byť záporná na štartovom rošte). */
  prog: number;
  lapsDone: number;
  lapStartT: number;
  lapTimes: number[];
  bestLap: number | null;
  lastLap: number | null;
  finished: boolean;
  finishT: number | null;
  finishOrder: number;
  pos: number;
  gapLeader: number;
  gapAhead: number;
  pit: PitState;
  fuelPerM: number;
  stuckT: number;
  auto: boolean;
  /** Počítadlo kolízií (pre štatistiku). */
  hits: number;
  surface: TrackQuery['surface'];
  /** Civilné auto otvoreného sveta: pevná bočná stopa a strop rýchlosti. */
  traffic?: { lateral: number; speedCap: number };
  /** Online: auto iného hráča – stav ide zo siete, lokálna fyzika sa naň nevzťahuje. */
  remote?: boolean;
  /** Online: hráč odišiel – auto sa nekreslí, nekoliduje a nepočíta sa do poradia. */
  hidden?: boolean;
}

export interface PlayerInput extends DriveInput {
  shiftUp: boolean;
  shiftDown: boolean;
}

export interface RaceEvent {
  type: 'lap' | 'bestLap' | 'finish' | 'pitIn' | 'pitDone' | 'hit' | 'reset' | 'lights' | 'go';
  racer?: Racer;
  value?: number;
}

const GRID_GAP = 8;

export class Race {
  readonly track: Track;
  readonly weather: Weather;
  readonly racers: Racer[] = [];
  readonly player: Racer;
  readonly cfg: RaceConfig;
  assists: Assists = { abs: true, tc: 1, steer: 1, autoGear: true };
  playerInput: PlayerInput = { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false };

  phase: RacePhase = 'grid';
  clock = 0;
  time = 0;
  /** Počet rozsvietených červených svetiel (0..5). */
  lights = 0;
  goAt = 0;
  finishCount = 0;
  events: RaceEvent[] = [];
  playerFinishedAt: number | null = null;
  bestLapOverall: { t: number; racer: Racer } | null = null;
  /** Čas od posledného rozjazdu mimo trate pre hráča (pre trénera). */
  private acc = 0;
  private step = 0;
  private rnd: () => number;
  private goDelay: number;
  /** Online: čaká sa na signál servera; kým je zapnutý, čas ani štartová sekvencia nebežia. */
  gate = false;

  /**
   * `free` = otvorený svet: bez štartových svetiel, bez kôl a cieľa, auto štartuje na trati.
   * Civilné autá (premávka) sa pridajú cez `addTraffic`.
   */
  readonly free: boolean;

  constructor(cfg: RaceConfig, track: Track, opts: { free?: boolean } = {}) {
    this.cfg = cfg;
    this.track = track;
    this.free = !!opts.free;
    this.rnd = mulberry32(cfg.seed * 7919 + 13);
    this.goDelay = 0.6 + this.rnd() * 1.1;
    const mode = cfg.weather;
    this.weather = new Weather(mode, cfg.seed + 5, mode === 'dynamic' ? 4 : 1);
    if (this.free) {
      this.phase = 'racing';
      this.player = this.addPlayerFree(cfg);
    } else if (cfg.online) {
      this.gate = true;
      cfg.online.grid.forEach((g, i) => this.addRacer(this.onlineEntry(g, i, cfg.online!.selfId), i, cfg));
      this.player = this.racers.find((r) => r.isPlayer) ?? this.racers[0];
      this.assignBoxes();
    } else {
      const grid = this.buildGrid(cfg);
      grid.forEach((g, i) => this.addRacer(g, i, cfg));
      this.player = this.racers.find((r) => r.isPlayer)!;
      this.assignBoxes();
    }
    this.updatePositions();
  }

  /** Hráč v otvorenom svete: stojí na trati v štarte okruhu (s = 0), žiadny rošt. */
  private addPlayerFree(cfg: RaceConfig): Racer {
    const g: GridEntry = {
      driver: { id: 'player', name: cfg.playerName || 'Hráč', code: 'HRA', number: 99, nat: 'SK', team: cfg.playerTeamId, skill: 1, real: false },
      team: TEAM_BY_ID[cfg.playerTeamId] ?? TEAMS[0], player: true,
    };
    this.addRacer(g, 0, cfg);
    const r = this.racers[0];
    r.auto = false;
    r.pit.served = true;
    return r;
  }

  /**
   * Civilné auto na trati (len otvorený svet). Jazdí AI po pevnej bočnej stope `lateral`
   * a drží maximálnu rýchlosť `speedCap` – nekončí, nemá kolá ani boxy.
   */
  addTraffic(i: number, modelId: string, spec: CarSpec, st: VehicleState, ai: AIState, lateral: number, speedCap: number): Racer {
    const q = this.track.query(st.x, st.y, -2);
    const r: Racer = {
      idx: this.racers.length, id: `traffic-${i}`, name: `Civil ${i + 1}`, code: 'CIV', number: 0,
      color: '#c9ced6', color2: '#2a2f38', teamName: 'Premávka', modelId, isPlayer: false, real: false, cls: 'GT', dq: false,
      spec, st, ai, input: { steer: 0, throttle: 0, brake: 0 },
      q, hint: q.i, lastS: q.s, prog: this.track.rel(q.s), lapsDone: 0, lapStartT: 0, lapTimes: [], bestLap: null, lastLap: null,
      finished: false, finishT: null, finishOrder: 0, pos: 0, gapLeader: 0, gapAhead: 0,
      pit: { phase: 'none', slot: 0, boxS: 0, boxLat: 0, t: 0, plan: { tyres: 0, fuel: 0, repair: 0 }, total: 0, served: true, stops: 0, startFuel: 0, startDamage: [0, 0, 0, 0] },
      fuelPerM: 0, stuckT: 0, auto: true, hits: 0, surface: q.surface,
    };
    r.traffic = { lateral, speedCap };
    this.racers.push(r);
    return r;
  }

  // ------------------------------------------------------------ zostavenie štartového poľa
  private onlineEntry(g: GridSlot, i: number, selfId: string): GridEntry {
    const team = TEAM_BY_ID[g.teamId] ?? TEAMS[0];
    const letters = g.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
    return {
      driver: { id: g.id, name: g.name, code: letters, number: i + 1, nat: 'SK', team: team.id, skill: 1, real: false },
      team, player: g.id === selfId, remote: g.id !== selfId,
    };
  }

  private playerDriver(cfg: RaceConfig, pteam: Team): Driver {
    return {
      id: 'player', name: cfg.playerName || 'Hráč', code: (cfg.playerName || 'HRA').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X'),
      number: 99, nat: 'SK', team: pteam.id, skill: 1, real: false,
    };
  }

  /** Reálni jazdci F1 2026 (bez náhradných); hráč nahrádza jedného jazdca svojho tímu. Vyberie `n` rovnomerne podľa sily. */
  private f1Others(pteam: Team, n: number): GridEntry[] {
    const pool = F1_DRIVERS.filter((d) => !d.reserve);
    let skipped = false;
    const others = pool.filter((d) => {
      if (!skipped && d.team === pteam.id) { skipped = true; return false; }
      return true;
    });
    others.sort((a, b) => TEAM_BY_ID[b.team].tier * b.skill - TEAM_BY_ID[a.team].tier * a.skill);
    return thin(others, n).map((d) => ({ driver: d, team: TEAM_BY_ID[d.team] }));
  }

  private gtOthers(n: number): GridEntry[] {
    const out: GridEntry[] = [];
    for (let i = 0; i < n; i++) {
      const team = GT_TEAMS[i % GT_TEAMS.length];
      const skill = clamp(0.92 - 0.012 * i - 0.05 * this.rnd(), 0.55, 0.95);
      out.push({ driver: fictionalDriver(i, team.id, skill), team });
    }
    return out;
  }

  private buildGrid(cfg: RaceConfig): GridEntry[] {
    const pteam = TEAM_BY_ID[cfg.playerTeamId] ?? TEAMS[0];
    if (cfg.mixed) return this.buildMixedGrid(cfg, pteam);
    const n = clamp(cfg.opponents, 1, pteam.cls === 'F1' ? 21 : 29);
    const list = pteam.cls === 'F1' ? this.f1Others(pteam, n) : this.gtOthers(n);
    const at = clamp(cfg.gridPos - 1, 0, list.length);
    list.splice(at, 0, { driver: this.playerDriver(cfg, pteam), team: pteam, player: true });
    return list;
  }

  /** Zmiešané pole: ~1/3 F1 vpredu, zvyšok GT. Hráč je zaradený do bloku svojej triedy. */
  private buildMixedGrid(cfg: RaceConfig, pteam: Team): GridEntry[] {
    const total = clamp(cfg.opponents, 3, 29) + 1;
    const nF1 = Math.max(2, Math.round(total / 3));
    const playerF1 = pteam.cls === 'F1';
    const f1 = this.f1Others(pteam, nF1 - (playerF1 ? 1 : 0));
    const gt = this.gtOthers(total - nF1 - (playerF1 ? 0 : 1));
    const list = [...f1, ...gt];
    const classOthers = playerF1 ? f1.length : gt.length;
    const at = (playerF1 ? 0 : f1.length) + clamp(cfg.gridPos - 1, 0, classOthers);
    list.splice(at, 0, { driver: this.playerDriver(cfg, pteam), team: pteam, player: true });
    return list;
  }

  private addRacer(g: GridEntry, i: number, cfg: RaceConfig): void {
    const { track } = this;
    const baseSpec = specFor(g.team.car, g.player ? (cfg.playerTier ?? 0.8) : g.team.tier);
    const spec = g.player && cfg.upgrades ? applyUpgrades(baseSpec, cfg.upgrades) : baseSpec;
    const s = -6 - i * GRID_GAP;
    const lat = i % 2 === 0 ? 2.3 : -2.3;
    const p = track.at(s, lat);
    const st = createVehicleState(spec, p.x, p.y, p.h);
    const skill = g.driver.skill;
    const diffPace = DIFF_PACE[cfg.difficulty];
    const ai: AIState = {
      pace: diffPace * (0.92 + 0.08 * skill), offset: 0, offsetTarget: 0, wantsPit: false,
      mistakeT: 15 + this.rnd() * 40, rnd: mulberry32(cfg.seed * 31 + i * 101 + 7),
    };
    const q = track.query(st.x, st.y, -2);
    const fuelPerM = (spec.fuelCapacity / (22 * track.length)) * cfg.consumption;
    const r: Racer = {
      idx: i, id: g.driver.id, name: g.driver.name, code: g.driver.code, number: g.driver.number,
      color: g.team.color, color2: g.team.color2, teamName: g.team.name, modelId: g.team.car,
      isPlayer: !!g.player, real: g.driver.real, cls: g.team.cls, dq: false, spec, st, ai, input: { steer: 0, throttle: 0, brake: 0 },
      q, hint: q.i, lastS: q.s, prog: track.rel(q.s), lapsDone: 0, lapStartT: 0, lapTimes: [], bestLap: null, lastLap: null,
      finished: false, finishT: null, finishOrder: 0, pos: i + 1, gapLeader: 0, gapAhead: 0,
      pit: { phase: 'none', slot: 0, boxS: 0, boxLat: 0, t: 0, plan: { tyres: 0, fuel: 0, repair: 0 }, total: 0, served: false, stops: 0, startFuel: 0, startDamage: [0, 0, 0, 0] },
      fuelPerM, stuckT: 0, auto: !g.player, hits: 0, surface: q.surface,
    };
    if (g.remote) r.remote = true;
    this.racers.push(r);
  }

  private assignBoxes(): void {
    // hráč má box v strede rovinky, ostatní sa radia okolo
    const total = this.racers.length;
    if (this.cfg.online) {
      // online: box podľa štartovej pozície – u všetkých klientov rovnaký
      this.racers.forEach((r, k) => {
        const bp = this.track.boxPosition(k);
        r.pit.slot = k; r.pit.boxS = bp.s; r.pit.boxLat = bp.lateral;
      });
      return;
    }
    const slots = Array.from({ length: total }, (_, k) => k);
    const mid = Math.min(3, total - 1);
    const order = [mid, ...slots.filter((k) => k !== mid)];
    const sorted = [this.player, ...this.racers.filter((r) => r !== this.player)];
    sorted.forEach((r, k) => {
      const bp = this.track.boxPosition(order[k]);
      r.pit.slot = order[k];
      r.pit.boxS = bp.s;
      r.pit.boxLat = bp.lateral;
    });
  }

  // ------------------------------------------------------------ hlavný cyklus
  /** Posunie simuláciu o `dt` sekúnd reálneho času (fixný krok fyziky). */
  advance(dt: number, maxSteps = 40): void {
    this.acc += dt;
    let n = 0;
    while (this.acc >= PHYS_DT && n < maxSteps) {
      this.stepOnce();
      this.acc -= PHYS_DT;
      n++;
    }
    if (this.acc > PHYS_DT * 4) this.acc = 0;
  }

  setPlayerAuto(on: boolean): void {
    this.player.auto = on;
    if (on) { this.player.ai.pace = DIFF_PACE.medium; }
  }

  /** Online: spustí štartovú sekvenciu (signál servera, že sú všetci pripravení). */
  release(): void {
    this.gate = false;
    this.clock = 0;
  }

  private stepOnce(): void {
    if (this.gate) return;
    const dt = PHYS_DT;
    this.step++;
    this.clock += dt;
    this.weather.update(dt);

    if (this.free) {
      // otvorený svet: bez svetiel, čas beží od začiatku
    } else if (this.phase === 'grid') {
      if (this.clock > 3) { this.phase = 'lights'; }
    } else if (this.phase === 'lights') {
      const k = Math.min(5, Math.floor((this.clock - 3) / 0.9) + 1);
      if (k !== this.lights) { this.lights = k; this.events.push({ type: 'lights', value: k }); }
      if (this.clock - 3 > 5 * 0.9 + this.goDelay) {
        this.phase = 'racing';
        this.lights = 0;
        this.goAt = this.clock;
        this.events.push({ type: 'go' });
      }
    }
    if (this.phase === 'racing') this.time += dt;

    const hold = this.phase !== 'racing';
    const aiTick = (this.step & 1) === 0;
    const track = this.track;
    const wGrip = this.weather.grip;

    for (const r of this.racers) {
      const q = track.query(r.st.x, r.st.y, r.hint);
      r.q = q; r.hint = q.i; r.surface = q.surface;
      if (r.remote) continue; // cudzie auto: poloha a progres prichádzajú zo siete
      this.updateProgress(r, q);
      this.pitLogic(r, q, dt);

      const servicing = r.pit.phase === 'service';
      const surfGrip = q.surface === 'grass' ? 0.55 : q.surface === 'kerb' ? 0.97 : 1;
      const env: VehicleEnv = {
        grip: wGrip * surfGrip,
        rrCoef: q.surface === 'grass' ? 0.09 : 0.012,
        speedLimit: track.inPitSpeedZone(q) ? PIT_LIMIT : 0,
        hold: hold || servicing,
        fuelPerMeter: r.finished ? 0 : r.fuelPerM,
        wearScale: this.cfg.consumption,
        wetness: this.weather.wetness,
      };

      let inp: DriveInput;
      let as = this.assists;
      if (r.isPlayer && !r.auto) {
        const pi = this.playerInput;
        inp = { steer: pi.steer, throttle: pi.throttle, brake: pi.brake };
        if (pi.shiftUp) { shiftGear(r.spec, r.st, 1); pi.shiftUp = false; }
        if (pi.shiftDown) { shiftGear(r.spec, r.st, -1); pi.shiftDown = false; }
      } else {
        if (aiTick) r.input = this.driveAuto(r, q);
        inp = r.input;
        if (r.isPlayer) as = { abs: true, tc: 1, steer: 1, autoGear: true };
        else as = AI_ASSISTS;
      }
      stepVehicle(r.spec, r.st, inp, as, env, dt);
      r.input = r.isPlayer && !r.auto ? inp : r.input;

      if (!hold) wallCollision(track, r, q, this.events);
      this.checkStuck(r, q, dt);
    }
    if (!hold) carCollisions(this.racers, this.events);
    if ((this.step % 8) === 0) this.updatePositions();
  }

  // ------------------------------------------------------------ AI
  private driveAuto(r: Racer, q: TrackQuery): DriveInput {
    const track = this.track;
    if (r.traffic) {
      const nb: { s: number; d: number; v: number }[] = [];
      for (const o of this.racers) {
        if (o === r) continue;
        const ds = track.wrapS(o.q.s - q.s);
        if (ds > 0 && ds < 45) nb.push({ s: o.q.s, d: o.q.d, v: o.st.vx });
      }
      return driveAI(r.ai, {
        track, spec: r.spec, st: r.st, s: q.s, d: q.d, grip: this.weather.grip * (q.surface === 'grass' ? 0.6 : 1),
        forcedLateral: r.traffic.lateral, lateralFn: null, speedCap: r.traffic.speedCap, stopAtS: null, neighbours: nb,
      }, PHYS_DT * 2);
    }
    const nb: { s: number; d: number; v: number }[] = [];
    for (const o of this.racers) {
      if (o === r) continue;
      const ds = track.wrapS(o.q.s - q.s);
      if (ds > 0 && ds < 45) nb.push({ s: o.q.s, d: o.q.d, v: o.st.vx });
    }
    const inLane = r.pit.phase !== 'none';
    let speedCap = 0;
    let stopAtS: number | null = null;
    let lateralFn: ((s: number) => number) | null = null;
    if (r.finished) speedCap = 28;
    if (inLane) {
      const p = track.d.pit;
      const rel = track.rel(q.s);
      const zoneStart = p.sIn + 40;
      const cap = rel < zoneStart
        ? Math.sqrt(PIT_LIMIT * PIT_LIMIT + 2 * 22 * Math.max(0, zoneStart - rel))
        : PIT_LIMIT * 0.97;
      speedCap = speedCap > 0 ? Math.min(speedCap, cap) : cap;
      if (r.pit.phase === 'lane' && !r.pit.served) stopAtS = r.pit.boxS;
      lateralFn = (s) => this.pitPath(r, s);
    }
    return driveAI(r.ai, {
      track, spec: r.spec, st: r.st, s: q.s, d: q.d, grip: this.weather.grip * (q.surface === 'grass' ? 0.6 : 1),
      forcedLateral: null, lateralFn, speedCap, stopAtS, neighbours: nb,
    }, PHYS_DT * 2);
  }

  /** Cieľová bočná poloha počas prejazdu boxovou uličkou. */
  private pitPath(r: Racer, s: number): number {
    const track = this.track;
    const p = track.d.pit;
    const rel = track.rel(s);
    const entry = smoothstep(p.sIn - 60, p.sIn + 120, rel);
    const exit = 1 - smoothstep(p.sOut - 120, p.sOut + 60, rel);
    const w = Math.min(entry, exit);
    const line = track.lineOffset(s);
    let lane = track.pitFastLane(s);
    const boxRel = track.rel(r.pit.boxS);
    const dB = rel - boxRel;
    const toBox = smoothstep(-34, -6, dB) * (1 - smoothstep(6, 34, dB));
    lane = lerp(lane, r.pit.boxLat, toBox);
    return lerp(line, lane, w);
  }

  // ------------------------------------------------------------ boxy
  private pitLogic(r: Racer, q: TrackQuery, dt: number): void {
    const track = this.track;
    const pit = r.pit;
    const p = track.d.pit;
    const rel = track.rel(q.s);
    // otvorený svet nemá boxy; civilné autá ich nepoužívajú
    if (this.free || r.traffic) return;

    // AI sa rozhodne pre zastávku skôr, než príde k vjazdu do boxov
    if (!r.isPlayer || r.auto) {
      if (pit.phase === 'none' && !r.finished && rel > p.sIn - 520 && rel < p.sIn - 140 && this.phase === 'racing') {
        const lapsLeft = lapsLeftOf(this, r);
        const wear = (r.st.wear[0] + r.st.wear[1] + r.st.wear[2] + r.st.wear[3]) / 4;
        const dmg = Math.max(...r.st.damage);
        const fuelFrac = r.st.fuel / r.spec.fuelCapacity;
        const lapFuel = (r.fuelPerM * track.length * 0.7) / r.spec.fuelCapacity;
        const need = wear > 0.6 || dmg > 0.35 || fuelFrac < lapFuel * 1.6;
        // vytrvalostný pretek: povinná zastávka v rozptýlenom čase, aby nešli všetci naraz
        const dur = this.cfg.durationS;
        const mustStop = dur != null && pit.stops < (this.cfg.mandatoryStops ?? 0)
          && this.time > dur * (0.18 + 0.5 * (((r.idx * 37) % 97) / 97)) && this.time < dur - 120;
        if ((need && lapsLeft > 1.6) || mustStop) {
          pit.phase = 'lane'; pit.served = false; r.ai.offsetTarget = 0;
        }
      }
    }

    const inBoxRect = this.inBox(r, q);
    const speed = Math.abs(r.st.vx);

    if (pit.phase === 'service') {
      pit.t += dt;
      // sekvencia: pneumatiky → palivo → oprava (auto stojí)
      const { tyres, fuel, repair } = pit.plan;
      if (tyres > 0 && pit.t >= tyres) r.st.wear = [0, 0, 0, 0];
      if (fuel > 0) r.st.fuel = lerp(pit.startFuel, r.spec.fuelCapacity, clamp((pit.t - tyres) / fuel, 0, 1));
      if (repair > 0) {
        const f = clamp((pit.t - tyres - fuel) / repair, 0, 1);
        for (let k = 0; k < 4; k++) r.st.damage[k] = pit.startDamage[k] * (1 - f);
      }
      if (pit.t >= pit.total) {
        r.st.wear = [0, 0, 0, 0];
        r.st.fuel = r.spec.fuelCapacity;
        r.st.damage = [0, 0, 0, 0];
        pit.phase = 'exit';
        pit.served = true;
        pit.stops++;
        this.events.push({ type: 'pitDone', racer: r });
      }
      return;
    }

    // vstup do servisu: stojí v boxe
    if (!pit.served && inBoxRect && speed < 0.6 && this.phase === 'racing' && !r.finished && (pit.phase === 'lane' || (r.isPlayer && !r.auto))) {
      this.startService(r);
      return;
    }

    // zrušenie stavu po opustení boxu / uličky
    if (r.isPlayer && !r.auto) {
      if (pit.phase === 'exit' && !track.inPitLane(q)) { pit.phase = 'none'; pit.served = false; }
      if (pit.served && pit.phase !== 'exit' && Math.abs(track.wrapS(q.s - pit.boxS + track.length / 2) - track.length / 2) > 14) pit.served = false;
    } else {
      if (pit.phase === 'exit' && rel > p.sOut) { pit.phase = 'none'; pit.served = false; r.ai.wantsPit = false; }
      if (pit.phase === 'lane' && !pit.served && rel > p.sOut) { pit.phase = 'none'; } // minul zastávku
    }
  }

  private inBox(r: Racer, q: TrackQuery): boolean {
    const pit = r.pit;
    const ds = this.track.wrapS(q.s - pit.boxS + this.track.length / 2) - this.track.length / 2;
    return Math.abs(ds) < 3.2 && Math.abs(q.d - pit.boxLat) < 2.4;
  }

  private startService(r: Racer): void {
    const pit = r.pit;
    const wear = (r.st.wear[0] + r.st.wear[1] + r.st.wear[2] + r.st.wear[3]) / 4;
    const dmg = Math.max(...r.st.damage);
    const missing = 1 - r.st.fuel / r.spec.fuelCapacity;
    const tyres = wear > 0.02 ? 3.2 : 0;
    const fuel = missing > 0.01 ? missing * 7 : 0;
    const repair = dmg > 0.01 ? 2 + dmg * 9 : 0;
    pit.plan = { tyres, fuel, repair };
    pit.total = Math.max(1.2, tyres + fuel + repair + 0.4);
    pit.t = 0;
    pit.phase = 'service';
    pit.startFuel = r.st.fuel;
    pit.startDamage = [...r.st.damage] as [number, number, number, number];
    this.events.push({ type: 'pitIn', racer: r });
  }

  // ------------------------------------------------------------ progres a kolá
  private updateProgress(r: Racer, q: TrackQuery): void {
    const L = this.track.length;
    let ds = q.s - r.lastS;
    if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
    if (Math.abs(ds) < 40) r.prog += ds;
    r.lastS = q.s;
    if (this.phase !== 'racing' || this.free) return;
    while (r.prog >= L * (r.lapsDone + 1) && !r.finished) {
      r.lapsDone++;
      const lt = this.time - r.lapStartT;
      r.lapStartT = this.time;
      r.lapTimes.push(lt);
      r.lastLap = lt;
      const best = r.bestLap == null || lt < r.bestLap;
      if (best) r.bestLap = lt;
      this.events.push({ type: 'lap', racer: r, value: lt });
      if (best && (!this.bestLapOverall || lt < this.bestLapOverall.t)) {
        this.bestLapOverall = { t: lt, racer: r };
        this.events.push({ type: 'bestLap', racer: r, value: lt });
      }
      const dur = this.cfg.durationS;
      if (dur != null ? this.time >= dur : r.lapsDone >= this.cfg.laps) {
        r.finished = true;
        r.dq = dur != null && r.pit.stops < (this.cfg.mandatoryStops ?? 0);
        r.finishT = this.time;
        r.finishOrder = ++this.finishCount;
        this.events.push({ type: 'finish', racer: r });
        if (r.isPlayer) {
          this.playerFinishedAt = this.time;
          r.auto = true;
          r.ai.pace = DIFF_PACE.medium;
          if (r.pit.phase !== 'none') r.pit.phase = 'none';
        }
      }
    }
  }

  get allFinished(): boolean {
    return this.racers.every((r) => r.finished);
  }

  // ------------------------------------------------------------ poradie
  updatePositions(): void {
    const arr = this.racers.filter((r) => !r.hidden);
    for (const r of this.racers) if (r.hidden) r.pos = this.racers.length;
    const D = this.cfg.durationS;
    const L = this.track.length;
    const expired = D != null && this.time >= D;
    /** Vytrvalosť: rozhoduje počet kôl (po uplynutí času sa nedokončené auto počíta na kolo, ktoré ešte dokončí). */
    const laps = (r: Racer) => (r.finished ? r.lapsDone : expired ? Math.ceil(r.prog / L - 1e-6) : r.prog / L);
    arr.sort((a, b) => {
      if (D != null) {
        if (a.dq !== b.dq) return a.dq ? 1 : -1;
        const ka = laps(a), kb = laps(b);
        if (ka !== kb) return kb - ka;
        if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
        if (a.finished) return -1;
        if (b.finished) return 1;
        return b.prog - a.prog;
      }
      if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.prog - a.prog;
    });
    const leader = arr[0];
    arr.forEach((r, i) => {
      r.pos = i + 1;
      const ref = Math.max(30, r.st.vx);
      r.gapLeader = i === 0 ? 0 : Math.max(0, (leader.prog - r.prog) / ref);
      r.gapAhead = i === 0 ? 0 : Math.max(0, (arr[i - 1].prog - r.prog) / ref);
    });
    this.sorted = arr;
  }
  sorted: Racer[] = [];

  // ------------------------------------------------------------ uviaznutie a návrat na trať
  private checkStuck(r: Racer, q: TrackQuery, dt: number): void {
    if (this.phase === 'racing' && !r.finished && (r.pit.phase === 'lane' || r.pit.phase === 'exit') && !(r.isPlayer && !r.auto)) {
      // uviaznutie v boxovej uličke (náraz do múru, poškodené auto): vráť auto na rýchly pruh
      r.stuckT = Math.abs(r.st.vx) < 1.2 && !this.inBox(r, q) ? r.stuckT + dt : 0;
      if (r.stuckT > 4) this.resetInPit(r);
      return;
    }
    if (this.phase !== 'racing' || r.pit.phase !== 'none' || r.finished) { r.stuckT = 0; return; }
    const stuck = Math.abs(r.st.vx) < 1.2 && !(r.isPlayer && !r.auto);
    const away = q.surface === 'grass' || q.surface === 'wall' || Math.abs(q.d) > 12;
    r.stuckT = stuck ? r.stuckT + dt : 0;
    if (r.stuckT > (away ? 3 : 7)) { this.resetToTrack(r); }
  }

  /** Vráti uviaznuté auto v boxovej uličke na rýchly pruh, kúsok pred jeho box (alebo o kúsok ďalej). */
  private resetInPit(r: Racer): void {
    const st = r.st;
    const track = this.track;
    const before = r.pit.phase === 'lane' && !r.pit.served
      && track.wrapS(r.q.s - r.pit.boxS + track.length / 2) - track.length / 2 > -12;
    const s = track.wrapS(before ? r.pit.boxS - 14 : r.q.s + 4);
    const p = track.at(s, track.pitFastLane(s));
    st.x = p.x; st.y = p.y; st.heading = p.h;
    st.vx = 4; st.vy = 0; st.r = 0; st.steer = 0;
    st.gear = Math.max(1, st.gear);
    r.stuckT = 0;
    r.q = track.query(st.x, st.y, -2);
    r.hint = r.q.i;
    r.lastS = r.q.s;
  }

  /** Vráti auto na najbližší bod trate v smere jazdy (R). */
  resetToTrack(r: Racer, lateral = 0): void {
    const st = r.st;
    const s = this.track.wrapS(r.q.s + 4);
    const lat = clamp(lateral, -4, 4);
    const p = this.track.at(s, lat);
    st.x = p.x; st.y = p.y; st.heading = p.h;
    st.vx = Math.min(Math.max(st.vx, 0), 12); st.vy = 0; st.r = 0; st.steer = 0;
    st.gear = Math.max(1, st.gear);
    r.stuckT = 0;
    r.q = this.track.query(st.x, st.y, -2);
    r.hint = r.q.i;
    r.lastS = r.q.s;
    r.ai.offset = 0; r.ai.offsetTarget = 0;
    if (r.isPlayer) this.events.push({ type: 'reset', racer: r });
  }

  /** Posledné poradie pre tabuľku výsledkov. */
  classification(): Racer[] {
    this.updatePositions();
    return this.sorted;
  }
}

const AI_ASSISTS: Assists = { abs: true, tc: 1, steer: 0, autoGear: true };

interface GridEntry { driver: Driver; team: Team; player?: boolean; remote?: boolean }

/** Vyberie `n` prvkov rovnomerne rozložených v poli (zachová mix najlepších a slabších). */
function thin<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * arr.length) / n)]);
  return out;
}

export { NO_UPGRADES };
