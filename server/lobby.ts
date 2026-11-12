import {
  LIMITS, PROTOCOL_VERSION, rankStandings, sanitizeSettings, sanitizeText, validId, validSnap,
  type C2S, type GridSlot, type NetSnap, type RoomInfo, type RoomSettings, type RoomStatus, type RoomSummary, type S2C, type StandingRow,
} from '../src/net/protocol';
import { GT_TEAMS, TEAMS, TEAM_BY_ID, TRACK_BY_ID } from '../src/data/catalog';

/**
 * Logika serverových miestností – bez sieťovej vrstvy (testovateľná). Server nesimuluje fyziku:
 * drží miestnosti a štart, preposiela stavy áut, chat a počíta poradie z hlásených hodnôt.
 * Klientom TÚTO hodnotu dôveruje (prototyp bez ochrany pred podvodom), ale všetky vstupy validuje.
 */

export interface Peer { id: string; send(msg: S2C): void }

export const TIMING = {
  /** Interval preposielania stavov áut [ms] (20 Hz). */
  statesMs: 50,
  standingsMs: 1000,
  roomsMs: 2000,
  /** Ako dlho server čaká na načítanie trate u všetkých hráčov. */
  loadTimeoutMs: 30_000,
  /** Po dojazde prvého auta majú ostatní toľko času na dokončenie. */
  finishGraceMs: 90_000,
  chatWindowMs: 8000,
  chatMax: 6,
  /** Minimálny odstup dvoch stavov od jedného hráča [ms] (ochrana pred zahltením). */
  snapMinMs: 20,
} as const;

interface Member {
  peer: Peer;
  name: string;
  teamId: string;
  ready: boolean;
  loaded: boolean;
  left: boolean;
  snap: NetSnap | null;
  dirty: boolean;
  lastSnapAt: number;
  chatAt: number[];
}

interface Client { peer: Peer; name: string; hello: boolean; room: Room | null; chatAt: number[] }

interface Room {
  id: string;
  name: string;
  hostId: string;
  settings: RoomSettings;
  status: RoomStatus;
  members: Map<string, Member>;
  seed: number;
  startedAt: number;
  firstFinishAt: number | null;
  lastResults: StandingRow[] | null;
}

const defaultTeam = (cls: 'F1' | 'GT') => (cls === 'F1' ? TEAMS[0].id : GT_TEAMS[0].id);
const teamOk = (teamId: unknown, cls: 'F1' | 'GT'): teamId is string => typeof teamId === 'string' && TEAM_BY_ID[teamId]?.cls === cls;

export class Lobby {
  private clients = new Map<string, Client>();
  private rooms = new Map<string, Room>();
  private seq = 0;
  private lastStates = 0;
  private lastStandings = 0;
  private lastRooms = 0;

  private rnd: () => number;
  private now: () => number;

  constructor(rnd: () => number = Math.random, now: () => number = Date.now) {
    this.rnd = rnd; this.now = now;
  }

  // ------------------------------------------------------------------ spojenia
  connect(peer: Peer): void {
    this.clients.set(peer.id, { peer, name: 'Hráč', hello: false, room: null, chatAt: [] });
  }

  disconnect(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    this.leaveRoom(c);
    this.clients.delete(id);
  }

  get roomCount(): number { return this.rooms.size; }
  get clientCount(): number { return this.clients.size; }

  /** Spracuje správu od klienta. Neplatná správa sa ticho zahodí alebo vráti `error`. */
  handle(id: string, raw: unknown): void {
    const c = this.clients.get(id);
    if (!c || !raw || typeof raw !== 'object') return;
    const m = raw as Record<string, unknown>;
    const type = m.t;
    if (type === 'hello') { this.onHello(c, m); return; }
    if (!c.hello) return;
    switch (type) {
      case 'list': c.peer.send({ t: 'rooms', rooms: this.summaries() }); break;
      case 'create': this.onCreate(c, m); break;
      case 'join': this.onJoin(c, m); break;
      case 'leave': this.leaveRoom(c); c.peer.send({ t: 'room', room: null }); c.peer.send({ t: 'rooms', rooms: this.summaries() }); break;
      case 'team': this.onTeam(c, m); break;
      case 'ready': this.onReady(c, m); break;
      case 'settings': this.onSettings(c, m); break;
      case 'start': this.onStart(c); break;
      case 'loaded': this.onLoaded(c); break;
      case 'state': this.onState(c, m); break;
      case 'chat': this.onChat(c, m); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ obsluha správ
  private err(c: Client, key: string): void { c.peer.send({ t: 'error', key }); }

  private onHello(c: Client, m: Record<string, unknown>): void {
    if (m.ver !== PROTOCOL_VERSION) { this.err(c, 'net.err.version'); return; }
    c.name = sanitizeText(m.name, LIMITS.name) || 'Hráč';
    if (c.hello) return;
    c.hello = true;
    c.peer.send({ t: 'welcome', id: c.peer.id });
    c.peer.send({ t: 'rooms', rooms: this.summaries() });
  }

  private onCreate(c: Client, m: Record<string, unknown>): void {
    if (c.room) { this.err(c, 'net.err.inRoom'); return; }
    if (this.rooms.size >= LIMITS.maxRooms) { this.err(c, 'net.err.full'); return; }
    const settings = sanitizeSettings(m.settings);
    if (!settings || !TRACK_BY_ID[settings.trackId]) { this.err(c, 'net.err.settings'); return; }
    const teamId = teamOk(m.teamId, settings.cls) ? m.teamId : defaultTeam(settings.cls);
    const room: Room = {
      id: `r${(++this.seq).toString(36)}${Math.floor(this.rnd() * 1296).toString(36)}`,
      name: sanitizeText(m.name, LIMITS.roomName) || `Miestnosť ${this.seq}`,
      hostId: c.peer.id, settings, status: 'lobby', members: new Map(), seed: 0, startedAt: 0, firstFinishAt: null, lastResults: null,
    };
    this.rooms.set(room.id, room);
    this.addMember(room, c, teamId);
    this.sys(room, 'net.sys.created', { name: c.name });
    this.pushRoom(room);
  }

  private onJoin(c: Client, m: Record<string, unknown>): void {
    if (c.room) { this.err(c, 'net.err.inRoom'); return; }
    const room = validId(m.roomId) ? this.rooms.get(m.roomId) : undefined;
    if (!room) { this.err(c, 'net.err.noRoom'); return; }
    if (room.status !== 'lobby') { this.err(c, 'net.err.started'); return; }
    if (this.active(room).length >= room.settings.maxPlayers) { this.err(c, 'net.err.roomFull'); return; }
    const teamId = teamOk(m.teamId, room.settings.cls) ? m.teamId : defaultTeam(room.settings.cls);
    this.addMember(room, c, teamId);
    this.sys(room, 'net.sys.joined', { name: c.name });
    this.pushRoom(room);
  }

  private onTeam(c: Client, m: Record<string, unknown>): void {
    const r = c.room, me = r?.members.get(c.peer.id);
    if (!r || !me || r.status !== 'lobby') return;
    if (!teamOk(m.teamId, r.settings.cls)) { this.err(c, 'net.err.team'); return; }
    me.teamId = m.teamId;
    me.ready = false;
    this.pushRoom(r);
  }

  private onReady(c: Client, m: Record<string, unknown>): void {
    const r = c.room, me = r?.members.get(c.peer.id);
    if (!r || !me || r.status !== 'lobby') return;
    me.ready = m.ready === true;
    this.pushRoom(r);
  }

  private onSettings(c: Client, m: Record<string, unknown>): void {
    const r = c.room;
    if (!r || r.status !== 'lobby' || r.hostId !== c.peer.id) return;
    const s = sanitizeSettings(m.settings);
    if (!s || !TRACK_BY_ID[s.trackId]) { this.err(c, 'net.err.settings'); return; }
    // nižší limit než počet hráčov nedáva zmysel
    s.maxPlayers = Math.max(s.maxPlayers, this.active(r).length);
    const clsChanged = s.cls !== r.settings.cls;
    r.settings = s;
    for (const mem of r.members.values()) {
      mem.ready = false;
      if (clsChanged || !teamOk(mem.teamId, s.cls)) mem.teamId = defaultTeam(s.cls);
    }
    this.pushRoom(r);
  }

  private onStart(c: Client): void {
    const r = c.room;
    if (!r || r.status !== 'lobby' || r.hostId !== c.peer.id) return;
    const players = this.active(r);
    if (players.length < LIMITS.minPlayers) { this.err(c, 'net.err.minPlayers'); return; }
    if (players.some(([id, mem]) => id !== r.hostId && !mem.ready)) { this.err(c, 'net.err.notReady'); return; }
    r.status = 'loading';
    r.seed = Math.floor(this.rnd() * 1e6);
    r.startedAt = this.now();
    r.firstFinishAt = null;
    r.lastResults = null;
    // náhodné poradie na štartovom rošte (Fisher–Yates)
    const order = players.map(([id]) => id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const grid: GridSlot[] = order.map((id) => { const mem = r.members.get(id)!; return { id, name: mem.name, teamId: mem.teamId }; });
    for (const [, mem] of players) { mem.loaded = false; mem.snap = null; mem.dirty = false; }
    this.broadcast(r, { t: 'start', seed: r.seed, settings: r.settings, grid });
    this.pushRoom(r);
  }

  private onLoaded(c: Client): void {
    const r = c.room, me = r?.members.get(c.peer.id);
    if (!r || !me || r.status !== 'loading') return;
    me.loaded = true;
    this.maybeGo(r);
  }

  private maybeGo(r: Room): void {
    if (r.status !== 'loading') return;
    const act = this.active(r);
    if (act.length === 0 || !act.every(([, m]) => m.loaded)) return;
    r.status = 'racing';
    r.startedAt = this.now();
    this.broadcast(r, { t: 'go' });
    this.pushRoom(r);
  }

  private onState(c: Client, m: Record<string, unknown>): void {
    const r = c.room, me = r?.members.get(c.peer.id);
    if (!r || !me || r.status !== 'racing' || me.left) return;
    const t = this.now();
    if (t - me.lastSnapAt < TIMING.snapMinMs) return;
    if (!validSnap(m.s)) return;
    me.lastSnapAt = t;
    me.snap = m.s;
    me.dirty = true;
    if (m.s.fin && r.firstFinishAt == null) r.firstFinishAt = t;
  }

  private onChat(c: Client, m: Record<string, unknown>): void {
    const text = sanitizeText(m.text, LIMITS.chat);
    if (!text) return;
    const t = this.now();
    c.chatAt = c.chatAt.filter((x) => t - x < TIMING.chatWindowMs);
    if (c.chatAt.length >= TIMING.chatMax) { this.err(c, 'net.err.chatRate'); return; }
    c.chatAt.push(t);
    if (!c.room) return;
    this.broadcast(c.room, { t: 'chat', from: c.peer.id, name: c.name, text });
  }

  // ------------------------------------------------------------------ miestnosti
  private active(r: Room): [string, Member][] {
    return [...r.members].filter(([, m]) => !m.left);
  }

  private addMember(r: Room, c: Client, teamId: string): void {
    r.members.set(c.peer.id, { peer: c.peer, name: c.name, teamId, ready: false, loaded: false, left: false, snap: null, dirty: false, lastSnapAt: 0, chatAt: [] });
    c.room = r;
  }

  private leaveRoom(c: Client): void {
    const r = c.room;
    if (!r) return;
    c.room = null;
    const me = r.members.get(c.peer.id);
    if (!me) return;
    if (r.status === 'lobby') r.members.delete(c.peer.id);
    else { me.left = true; me.ready = false; }
    this.broadcast(r, { t: 'left', id: c.peer.id });
    const act = this.active(r);
    if (act.length === 0) { this.rooms.delete(r.id); return; }
    this.sys(r, 'net.sys.left', { name: me.name });
    if (r.hostId === c.peer.id) {
      r.hostId = act[0][0];
      this.sys(r, 'net.sys.host', { name: act[0][1].name });
    }
    if (r.status === 'loading') this.maybeGo(r);
    if (r.status === 'racing') this.checkFinish(r, false);
    this.pushRoom(r);
  }

  private infoOf(r: Room): RoomInfo {
    return {
      id: r.id, name: r.name, hostId: r.hostId, settings: r.settings, status: r.status,
      players: this.active(r).map(([id, m]) => ({ id, name: m.name, teamId: m.teamId, ready: m.ready })),
      lastResults: r.lastResults,
    };
  }

  private summaries(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => ({ id: r.id, name: r.name, settings: r.settings, players: this.active(r).length, status: r.status }));
  }

  private broadcast(r: Room, msg: S2C): void {
    for (const m of r.members.values()) if (!m.left) m.peer.send(msg);
  }

  private pushRoom(r: Room): void {
    this.broadcast(r, { t: 'room', room: this.infoOf(r) });
  }

  private sys(r: Room, key: string, params: Record<string, string | number>): void {
    this.broadcast(r, { t: 'chat', from: null, name: '', text: '', key, params });
  }

  private standingsOf(r: Room): StandingRow[] {
    const rows = [...r.members].map(([id, m]) => ({
      id, name: m.name, teamId: m.teamId,
      laps: m.snap?.laps ?? 0, prog: m.snap?.prog ?? 0, fin: m.snap?.fin ?? false, finT: m.snap?.finT ?? null,
      best: m.snap?.best ?? null, left: m.left,
    }));
    return rankStandings(rows);
  }

  /** Ukončí preteky, ak všetci dojazdili / odišli, alebo vypršal čas po dojazde prvého. */
  private checkFinish(r: Room, timeExpired: boolean): void {
    if (r.status !== 'racing') return;
    const act = this.active(r);
    const allDone = act.length === 0 || act.every(([, m]) => m.snap?.fin);
    if (!allDone && !timeExpired) return;
    const list = this.standingsOf(r);
    r.lastResults = list;
    r.status = 'lobby';
    r.firstFinishAt = null;
    for (const [id, m] of [...r.members]) {
      if (m.left) { r.members.delete(id); continue; }
      m.ready = false; m.loaded = false; m.snap = null; m.dirty = false;
    }
    if (act.length === 0) { this.rooms.delete(r.id); return; }
    this.broadcast(r, { t: 'results', list });
    this.pushRoom(r);
  }

  // ------------------------------------------------------------------ časovač (volať ~každých 25–50 ms)
  tick(): void {
    const t = this.now();
    for (const r of [...this.rooms.values()]) {
      if (r.status === 'loading' && t - r.startedAt > TIMING.loadTimeoutMs) {
        for (const [id, m] of this.active(r)) {
          if (m.loaded) continue;
          m.left = true;
          this.broadcast(r, { t: 'left', id });
          const cl = this.clients.get(id);
          if (cl) { cl.room = null; cl.peer.send({ t: 'room', room: null }); cl.peer.send({ t: 'error', key: 'net.err.loadTimeout' }); }
        }
        const act = this.active(r);
        if (act.length === 0) { this.rooms.delete(r.id); continue; }
        if (!act.some(([id]) => id === r.hostId)) r.hostId = act[0][0];
        this.maybeGo(r);
        this.pushRoom(r);
      }
      if (r.status === 'racing') {
        if (r.firstFinishAt != null && t - r.firstFinishAt > TIMING.finishGraceMs) this.checkFinish(r, true);
        else this.checkFinish(r, false);
      }
    }
    if (t - this.lastStates >= TIMING.statesMs) { this.lastStates = t; this.flushStates(); }
    if (t - this.lastStandings >= TIMING.standingsMs) {
      this.lastStandings = t;
      for (const r of this.rooms.values()) if (r.status === 'racing') this.broadcast(r, { t: 'standings', list: this.standingsOf(r) });
    }
    if (t - this.lastRooms >= TIMING.roomsMs) {
      this.lastRooms = t;
      const list = this.summaries();
      for (const c of this.clients.values()) if (c.hello && !c.room) c.peer.send({ t: 'rooms', rooms: list });
    }
  }

  private flushStates(): void {
    for (const r of this.rooms.values()) {
      if (r.status !== 'racing') continue;
      const dirty: [string, NetSnap][] = [];
      for (const [id, m] of r.members) if (m.dirty && m.snap && !m.left) { dirty.push([id, m.snap]); m.dirty = false; }
      if (dirty.length === 0) continue;
      for (const [id, m] of r.members) {
        if (m.left) continue;
        const list = dirty.filter(([from]) => from !== id);
        if (list.length) m.peer.send({ t: 'states', list });
      }
    }
  }
}

export type { C2S };
