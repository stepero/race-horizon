// Otvorený svet: voľná jazda po procedurálnej ceste, voliteľná civilná premávka a výzvy.
// Beží na tom istom `Race` jadre (fyzika, AI, kolízie, počasie), len v režime `free`:
// bez štartových svetiel, kôl, cieľa a boxov.
import { Race, type RaceConfig, type Racer } from './race';
import { Track } from './track';
import { buildWorldTrack, WORLD_BY_ID, type WorldSpec } from './worldMap';
import { createVehicleState, type Assists, type CarSpec } from './vehicle';
import { DIFF_PACE, type AIState } from './ai';
import { specFor } from '../data/catalog';
import { mulberry32 } from './math';
import type { PlayerInput, RaceEvent } from './race';

export interface WorldConfig {
  worldId: string;
  /** Civilná premávka (true) alebo prázdny svet (false). */
  traffic: boolean;
  trafficCount: number;
  playerTeamId: string;
  playerName: string;
  weather: RaceConfig['weather'];
  seed: number;
  /** Výkonnosť hráčovho auta 0..1 (kariéra: podľa tímu). */
  playerTier?: number;
  /** Násobok spotreby paliva a opotrebenia (svet je zhovievavý). */
  consumption?: number;
  upgrades?: RaceConfig['upgrades'];
}

export type ChallengeKind = 'sprint' | 'speedtrap' | 'clean';

/** Výzva na mape: úsek cesty `[from, from+len)` v metroch od štartu okruhu. */
export interface Challenge {
  id: string;
  kind: ChallengeKind;
  from: number;
  len: number;
  /** sprint: limit času [s]; speedtrap: minimálna rýchlosť [m/s]; clean: nepoužité. */
  target: number;
  reward: { level: number; coins: number };
  state: 'open' | 'active' | 'done' | 'failed';
  /** Posledný výsledok: čas [s] alebo najvyššia rýchlosť [m/s]. */
  result: number | null;
  /** Beh výzvy (interné). */
  t0: number;
  h0: number;
  lastD: number;
}

export interface WorldEvent {
  type: 'start' | 'done' | 'failed' | 'service';
  challenge?: Challenge;
}

/** Svet je Race s nekonečným počtom kôl a bez štartového poľa; rozhranie zodpovedá `Race` pre HUD a scénu. */
export class WorldSim {
  readonly world: WorldSpec;
  readonly track: Track;
  readonly race: Race;
  readonly challenges: Challenge[];
  readonly trafficOn: boolean;
  /** Fronta udalostí sveta (výzvy, servis) – hlavná slučka ju vyprázdňuje. */
  readonly worldEvents: WorldEvent[] = [];
  /** Aktívna výzva (najviac jedna). */
  active: Challenge | null = null;
  private stillT = 0;

  constructor(cfg: WorldConfig) {
    const spec = WORLD_BY_ID[cfg.worldId];
    if (!spec) throw new Error(`neznámy svet: ${cfg.worldId}`);
    this.world = spec;
    this.track = new Track(buildWorldTrack(spec));
    const rcfg: RaceConfig = {
      trackId: spec.id, laps: Number.MAX_SAFE_INTEGER, playerTeamId: cfg.playerTeamId, playerName: cfg.playerName,
      opponents: 0, difficulty: 'medium', weather: cfg.weather, gridPos: 1, consumption: cfg.consumption ?? 0.5,
      seed: cfg.seed, playerTier: cfg.playerTier, upgrades: cfg.upgrades,
    };
    this.race = new Race(rcfg, this.track, { free: true });
    this.trafficOn = cfg.traffic;
    if (cfg.traffic) this.spawnTraffic(cfg.trafficCount, cfg.seed);
    this.challenges = this.makeChallenges(cfg.seed);
    this.race.updatePositions();
  }

  // ------------------------------------------------------------ premávka
  /** Civilné autá: slabšie naladené GT modely (dočasné), pomalá jazda v pruhu, rovnomerne po okruhu. */
  private spawnTraffic(n: number, seed: number): void {
    const rnd = mulberry32(seed * 977 + 31);
    const L = this.track.length;
    const models = ['toyota-gt', 'bmw-gt', 'nissan-gt', 'mercedes-gt'];
    for (let i = 0; i < n; i++) {
      const s = 120 + (i + rnd() * 0.6) * ((L - 240) / n);
      const side = i % 2 === 0 ? -1 : 1;
      const lat = side * (2.2 + rnd() * 2);
      const car = models[i % models.length];
      const spec: CarSpec = specFor(car, 0.3 + rnd() * 0.12);
      const p = this.track.at(s, lat);
      const st = createVehicleState(spec, p.x, p.y, p.h);
      st.vx = 12;
      const ai: AIState = {
        pace: DIFF_PACE.easy * 0.9, offset: 0, offsetTarget: 0, wantsPit: false, mistakeT: 1e9,
        rnd: mulberry32(seed * 17 + i * 53),
      };
      this.race.addTraffic(i, car, spec, st, ai, lat, 14 + rnd() * 9);
    }
  }

  get traffic(): Racer[] { return this.race.racers.filter((r) => r.traffic); }

  // ------------------------------------------------------------ výzvy
  private makeChallenges(seed: number): Challenge[] {
    const L = this.track.length;
    const rnd = mulberry32(seed * 131 + 9);
    const kinds: ChallengeKind[] = ['sprint', 'speedtrap', 'clean'];
    const out: Challenge[] = [];
    const count = 6;
    for (let i = 0; i < count; i++) {
      const kind = kinds[i % kinds.length];
      const len = kind === 'speedtrap' ? 500 : 900 + rnd() * 500;
      const from = ((i + 0.25) * L) / count + rnd() * 100;
      out.push({
        id: `wc-${i}`, kind, from, len,
        target: kind === 'sprint' ? Math.round(len / 38) : kind === 'speedtrap' ? 70 : 0,
        reward: { level: 1 + (i % 3), coins: 60 + i * 20 },
        state: 'open', result: null, t0: 0, h0: 0, lastD: -1,
      });
    }
    return out;
  }

  private updateChallenges(): void {
    const p = this.race.player;
    const tr = this.track;
    const speed = Math.abs(p.st.vx);
    for (const c of this.challenges) {
      const d = tr.wrapS(p.q.s - c.from);
      const inside = d < c.len;
      if (c.state === 'done' || c.state === 'failed') {
        // po opustení úseku sa výzva dá skúsiť znova (hotová ostáva hotová)
        if (c.state === 'failed' && d > c.len + 150 && d < tr.length - 200) c.state = 'open';
        c.lastD = d;
        continue;
      }
      if (c.state === 'open') {
        // štart výzvy: prechod cez značku v smere jazdy
        if (d < 40 && c.lastD >= 0 && c.lastD > tr.length - 200 && !this.active) {
          c.state = 'active'; c.t0 = this.race.time; c.h0 = p.hits; c.result = null;
          this.active = c;
          this.worldEvents.push({ type: 'start', challenge: c });
        }
      } else if (c.state === 'active') {
        if (c.kind === 'speedtrap') c.result = Math.max(c.result ?? 0, speed);
        if (c.kind === 'clean' && p.hits > c.h0) this.finish(c, 'failed');
        else if (inside && c.kind === 'sprint' && this.race.time - c.t0 > c.target) this.finish(c, 'failed');
        else if (!inside) {
          // úsek prejdený (d tesne za koncom) alebo sa hráč vrátil/odbočil
          if (d < c.len + 150) {
            if (c.kind === 'sprint') { c.result = this.race.time - c.t0; this.finish(c, c.result <= c.target ? 'done' : 'failed'); }
            else if (c.kind === 'speedtrap') this.finish(c, (c.result ?? 0) >= c.target ? 'done' : 'failed');
            else { c.result = this.race.time - c.t0; this.finish(c, 'done'); }
          } else this.finish(c, 'failed');
        }
      }
      c.lastD = d;
    }
  }

  private finish(c: Challenge, st: 'done' | 'failed'): void {
    c.state = st;
    if (this.active === c) this.active = null;
    this.worldEvents.push({ type: st, challenge: c });
  }

  /** Bezplatný servis: státie ~3 s dopĺňa palivo a opravuje auto. */
  private updateService(dt: number): void {
    const p = this.race.player;
    if (Math.abs(p.st.vx) < 0.4 && !this.active) {
      this.stillT += dt;
      if (this.stillT > 3 && (p.st.fuel < p.spec.fuelCapacity * 0.98 || Math.max(...p.st.damage) > 0.02 || Math.max(...p.st.wear) > 0.05)) {
        p.st.fuel = p.spec.fuelCapacity;
        p.st.damage = [0, 0, 0, 0];
        p.st.wear = [0, 0, 0, 0];
        this.stillT = -4; // pauza pred ďalším servisom
        this.worldEvents.push({ type: 'service' });
      }
    } else this.stillT = Math.min(0, this.stillT) < 0 ? this.stillT + dt : 0;
  }

  // ------------------------------------------------------------ rozhranie ako Race
  advance(dt: number, maxSteps = 40): void {
    this.race.advance(dt, maxSteps);
    this.updateChallenges();
    this.updateService(dt);
  }
  get free(): boolean { return true; }
  get player(): Racer { return this.race.player; }
  get racers(): Racer[] { return this.race.racers; }
  get weather() { return this.race.weather; }
  get cfg() { return this.race.cfg; }
  get phase() { return this.race.phase; }
  get lights() { return this.race.lights; }
  get time() { return this.race.time; }
  get sorted(): Racer[] { return this.race.sorted; }
  get events(): RaceEvent[] { return this.race.events; }
  get assists(): Assists { return this.race.assists; }
  set assists(a: Assists) { this.race.assists = a; }
  get playerInput(): PlayerInput { return this.race.playerInput; }
  set playerInput(v: PlayerInput) { this.race.playerInput = v; }
  resetToTrack(r: Racer, lateral = 0): void { this.race.resetToTrack(r, lateral); }
  setPlayerAuto(on: boolean): void { this.race.setPlayerAuto(on); }
}
