import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Track, type TrackData } from '../src/sim/track';
import { Race } from '../src/sim/race';
import { PROTOCOL_VERSION, rankStandings, sanitizeSettings, sanitizeText, validSnap, type C2S, type NetSnap, type S2C } from '../src/net/protocol';
import { OnlineSession, RemoteBuffer, snapshotOf, type NetLike } from '../src/net/sync';
import { Lobby, TIMING } from '../server/lobby';
import { startServer } from '../server/index';

const load = (id: string) => new Track(JSON.parse(fs.readFileSync(path.resolve('public/tracks', `${id}.json`), 'utf8')) as TrackData);

const snap = (o: Partial<NetSnap> = {}): NetSnap => ({
  T: 1, x: 0, y: 0, h: 0, vx: 10, vy: 0, r: 0, st: 0, th: 1, br: 0, g: 3, rpm: 8000,
  prog: 0, laps: 0, fin: false, finT: null, best: null, last: null, pit: 'none', dmg: [0, 0, 0, 0], ...o,
});

describe('Online protokol', () => {
  it('čistí text a nastavenia', () => {
    expect(sanitizeText('  ahoj\u0000  svet‮ ', 50)).toBe('ahoj svet');
    expect(sanitizeText(42, 10)).toBe('');
    expect(sanitizeText('x'.repeat(300), 200)).toHaveLength(200);
    expect(sanitizeSettings({ trackId: 'horizon-park', laps: 999, weather: 'snow', cls: 'GT', maxPlayers: 4 }))
      .toEqual({ trackId: 'horizon-park', laps: 3, weather: 'dry', cls: 'GT', maxPlayers: 4 });
    expect(sanitizeSettings({ trackId: '../etc' })).toBeNull();
  });

  it('odmietne nezmyselný stav auta', () => {
    expect(validSnap(snap())).toBe(true);
    expect(validSnap(snap({ x: Number.NaN }))).toBe(false);
    expect(validSnap(snap({ th: 5 }))).toBe(false);
    expect(validSnap({ ...snap(), pit: 'teleport' })).toBe(false);
    expect(validSnap({ ...snap(), dmg: [0, 0, 0] })).toBe(false);
  });

  it('poradie: v cieli podľa času, potom podľa vzdialenosti, odídení na konci', () => {
    const base = { name: 'x', teamId: 'ferrari', best: null };
    const list = rankStandings([
      { ...base, id: 'a', laps: 2, prog: 5000, fin: false, finT: null, left: false },
      { ...base, id: 'b', laps: 3, prog: 9000, fin: true, finT: 100, left: false },
      { ...base, id: 'c', laps: 3, prog: 9000, fin: true, finT: 95, left: false },
      { ...base, id: 'd', laps: 3, prog: 9900, fin: false, finT: null, left: true },
    ]);
    expect(list.map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(list.map((r) => r.pos)).toEqual([1, 2, 3, 4]);
  });
});

describe('Interpolácia cudzích áut', () => {
  it('interpoluje medzi paketmi s oneskorením a obmedzene extrapoluje', () => {
    const b = new RemoteBuffer();
    // odosielateľ T=0,0.05,…; doručenie s posunom 10 s a malým jitterom
    for (let i = 0; i <= 10; i++) b.push(snap({ T: i * 0.05, x: i * 0.5 }), 10 + i * 0.05 + (i % 2) * 0.01);
    expect(b.offset).toBeCloseTo(10, 5);
    const mid = b.sample(10 + 0.3 + 0.1)!; // lokálny čas → T = 0.3
    expect(mid.x).toBeCloseTo(3, 5);
    const far = b.sample(10 + 5)!; // ďaleko za posledným paketom → max. MAX_EXTRAPOLATE
    expect(far.x).toBeLessThanOrEqual(5 + 10 * 0.25 + 1e-6);
    // starý paket sa zahodí
    b.push(snap({ T: 0.1, x: 99 }), 20);
    expect(b.latest!.x).toBe(5);
  });
});

/** Testovacia sieť: zachytáva správy pre jednotlivých hráčov. */
function harness() {
  let now = 1000;
  const lobby = new Lobby(() => 0.42, () => now);
  const inbox = new Map<string, S2C[]>();
  const join = (id: string, name: string) => {
    inbox.set(id, []);
    lobby.connect({ id, send: (m) => inbox.get(id)!.push(m) });
    lobby.handle(id, { t: 'hello', name, ver: PROTOCOL_VERSION });
  };
  const last = <K extends S2C['t']>(id: string, t: K) => [...inbox.get(id)!].reverse().find((m) => m.t === t) as Extract<S2C, { t: K }> | undefined;
  /** Server musí zvládnuť aj neúplné správy (napr. bez `teamId`), preto voľnejší typ. */
  const send = (id: string, m: C2S | { t: C2S['t']; [k: string]: unknown }) => lobby.handle(id, m);
  const tick = (ms: number) => { now += ms; lobby.tick(); };
  return { lobby, inbox, join, last, send, tick };
}

describe('Server – miestnosti', () => {
  const settings = { trackId: 'horizon-park', laps: 2, weather: 'dry' as const, cls: 'F1' as const, maxPlayers: 4 };

  it('celý priebeh: miestnosť → pripravenosť → štart → stavy → výsledky', () => {
    const h = harness();
    h.join('a', 'Anna'); h.join('b', 'Boris');
    expect(h.last('a', 'welcome')?.id).toBe('a');

    h.send('a', { t: 'create', name: 'Test', settings, teamId: 'mclaren' });
    const room = h.last('a', 'room')!.room!;
    expect(room.hostId).toBe('a');
    expect(room.players[0].teamId).toBe('mclaren');

    h.send('a', { t: 'start' });
    expect(h.last('a', 'error')?.key).toBe('net.err.minPlayers');

    h.send('b', { t: 'join', roomId: room.id, teamId: 'gt-porsche' }); // nesprávna trieda → predvolený tím
    expect(h.last('b', 'room')!.room!.players).toHaveLength(2);
    expect(h.last('b', 'room')!.room!.players[1].teamId).not.toBe('gt-porsche');

    h.send('a', { t: 'start' });
    expect(h.last('a', 'error')?.key).toBe('net.err.notReady');
    h.send('b', { t: 'ready', ready: true });
    h.send('a', { t: 'start' });
    const start = h.last('b', 'start')!;
    expect(start.grid.map((g) => g.id).sort()).toEqual(['a', 'b']);
    expect(h.last('a', 'go')).toBeUndefined();

    h.send('a', { t: 'loaded' });
    expect(h.last('a', 'go')).toBeUndefined();
    h.send('b', { t: 'loaded' });
    expect(h.last('a', 'go')).toBeDefined();

    // stav od A sa prepošle len B
    h.send('a', { t: 'state', s: snap({ T: 0.5, x: 12 }) });
    h.send('a', { t: 'state', s: { ...snap(), x: Infinity } as unknown as NetSnap }); // neplatný – zahodí sa
    h.tick(TIMING.statesMs);
    const st = h.last('b', 'states')!;
    expect(st.list).toEqual([['a', expect.objectContaining({ x: 12 })]]);
    expect(h.inbox.get('a')!.some((m) => m.t === 'states')).toBe(false);

    h.tick(TIMING.standingsMs);
    expect(h.last('a', 'standings')!.list).toHaveLength(2);

    h.send('a', { t: 'state', s: snap({ T: 60, laps: 2, prog: 1e4, fin: true, finT: 60 }) });
    h.tick(30);
    expect(h.last('a', 'results')).toBeUndefined();
    h.send('b', { t: 'state', s: snap({ T: 61, laps: 2, prog: 1e4, fin: true, finT: 58 }) });
    h.tick(30);
    const res = h.last('a', 'results')!;
    expect(res.list.map((r) => r.id)).toEqual(['b', 'a']);
    const after = h.last('a', 'room')!.room!;
    expect(after.status).toBe('lobby');
    expect(after.lastResults?.[0].id).toBe('b');
    expect(after.players.every((p) => !p.ready)).toBe(true);
  });

  it('odchod hostiteľa, chat s limitom, časový limit dojazdu', () => {
    const h = harness();
    h.join('a', 'Anna'); h.join('b', 'Boris'); h.join('c', 'Cyril');
    h.send('a', { t: 'create', name: 'R', settings });
    const id = h.last('a', 'room')!.room!.id;
    h.send('b', { t: 'join', roomId: id });
    h.send('c', { t: 'join', roomId: id });

    for (let i = 0; i < TIMING.chatMax + 2; i++) h.send('b', { t: 'chat', text: `msg ${i}` });
    expect(h.inbox.get('c')!.filter((m) => m.t === 'chat' && m.from === 'b')).toHaveLength(TIMING.chatMax);
    expect(h.last('b', 'error')?.key).toBe('net.err.chatRate');

    h.lobby.disconnect('a');
    const r = h.last('b', 'room')!.room!;
    expect(r.hostId).toBe('b');
    expect(r.players).toHaveLength(2);

    h.send('c', { t: 'ready', ready: true });
    h.send('b', { t: 'start' });
    h.send('b', { t: 'loaded' }); h.send('c', { t: 'loaded' });
    h.send('b', { t: 'state', s: snap({ T: 50, laps: 2, fin: true, finT: 50 }) });
    h.tick(30);
    expect(h.last('b', 'results')).toBeUndefined();
    h.tick(TIMING.finishGraceMs + 10);
    expect(h.last('c', 'results')!.list[0].id).toBe('b');
  });

  it('kto nenačíta trať včas, vypadne', () => {
    const h = harness();
    h.join('a', 'Anna'); h.join('b', 'Boris'); h.join('c', 'Cyril');
    h.send('a', { t: 'create', name: 'R', settings });
    const id = h.last('a', 'room')!.room!.id;
    h.send('b', { t: 'join', roomId: id }); h.send('c', { t: 'join', roomId: id });
    h.send('b', { t: 'ready', ready: true }); h.send('c', { t: 'ready', ready: true });
    h.send('a', { t: 'start' });
    h.send('a', { t: 'loaded' }); h.send('b', { t: 'loaded' });
    h.tick(TIMING.loadTimeoutMs + 10);
    expect(h.last('c', 'error')?.key).toBe('net.err.loadTimeout');
    expect(h.last('a', 'go')).toBeDefined();
    expect(h.last('a', 'left')?.id).toBe('c');
  });
});

describe('Online preteky – klient', () => {
  /** Dvaja klienti pripojení k zdieľanej "sieti" bez servera. */
  function pair() {
    const track = load('horizon-park');
    const grid = [{ id: 'a', name: 'Anna', teamId: 'ferrari' }, { id: 'b', name: 'Boris', teamId: 'mclaren' }];
    const mk = (self: string) => new Race({
      trackId: 'horizon-park', laps: 1, playerTeamId: 'ferrari', playerName: self, opponents: 0, difficulty: 'medium',
      weather: 'dry', gridPos: 1, consumption: 1, seed: 7, online: { selfId: self, grid },
    }, track);
    const ra = mk('a'), rb = mk('b');
    let clock = 0;
    const listeners = { a: new Set<(m: S2C) => void>(), b: new Set<(m: S2C) => void>() };
    const net = (self: 'a' | 'b', other: 'a' | 'b'): NetLike => ({
      send: (m) => { if (m.t === 'state') for (const f of listeners[other]) f({ t: 'states', list: [[self, m.s]] }); },
      on: (f) => { listeners[self].add(f); return () => listeners[self].delete(f); },
    });
    const sa = new OnlineSession(net('a', 'b'), ra, 'a', () => clock);
    const sb = new OnlineSession(net('b', 'a'), rb, 'b', () => clock);
    const bcast = (m: S2C) => { for (const f of [...listeners.a, ...listeners.b]) f(m); };
    const step = (dt: number) => { clock += dt; ra.advance(dt); rb.advance(dt); sa.update(dt); sb.update(dt); };
    return { ra, rb, sa, sb, bcast, step };
  }

  it('rošt tvoria len ľudia, cudzie auto je vzdialené a čaká sa na štart', () => {
    const { ra, rb, step } = pair();
    expect(ra.racers).toHaveLength(2);
    expect(ra.player.id).toBe('a');
    expect(rb.player.id).toBe('b');
    expect(ra.racers.find((r) => r.id === 'b')!.remote).toBe(true);
    expect(ra.player.remote).toBeFalsy();
    const x0 = ra.player.st.x;
    for (let i = 0; i < 120; i++) step(1 / 60);
    expect(ra.gate).toBe(true);
    expect(ra.phase).toBe('grid');
    expect(ra.player.st.x).toBe(x0);
  });

  it('po signáli go sa jazdí a pohyb sa prenáša k súperovi', () => {
    const { ra, rb, bcast, step } = pair();
    ra.setPlayerAuto(true); rb.setPlayerAuto(true);
    bcast({ t: 'go' });
    expect(ra.gate).toBe(false);
    for (let i = 0; i < 60 * 14; i++) step(1 / 60);
    expect(ra.phase).toBe('racing');
    const meInB = rb.racers.find((r) => r.id === 'a')!;
    // B vidí A s oneskorením ~INTERP_DELAY → poloha blízko skutočnej
    const d = Math.hypot(meInB.st.x - ra.player.st.x, meInB.st.y - ra.player.st.y);
    expect(Math.abs(ra.player.st.vx)).toBeGreaterThan(10);
    expect(d).toBeLessThan(Math.abs(ra.player.st.vx) * 0.25 + 2);
    expect(meInB.prog).toBeGreaterThan(0);
    // snapshot je platný z pohľadu servera
    expect(validSnap(snapshotOf(ra))).toBe(true);
  });

  it('odídený hráč zmizne z poradia', () => {
    const { ra, sa, bcast } = pair();
    bcast({ t: 'left', id: 'b' });
    expect(ra.racers.find((r) => r.id === 'b')!.hidden).toBe(true);
    ra.updatePositions();
    expect(ra.player.pos).toBe(1);
    sa.dispose();
  });
});

describe('Server – WebSocket', () => {
  it('dvaja klienti cez skutočné spojenie: hello → miestnosť → chat', async () => {
    const srv = await startServer(0, '127.0.0.1');
    const url = `ws://127.0.0.1:${srv.port}`;
    const open = (name: string) => new Promise<{ ws: WebSocket; msgs: S2C[]; wait: (t: S2C['t']) => Promise<S2C> }>((resolve, reject) => {
      const ws = new WebSocket(url);
      const msgs: S2C[] = [];
      const waiters: { t: string; f: (m: S2C) => void }[] = [];
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as S2C;
        msgs.push(m);
        for (const w of waiters.splice(0)) { if (w.t === m.t) w.f(m); else waiters.push(w); }
      };
      ws.onerror = () => reject(new Error('ws error'));
      const wait = (t: S2C['t']) => new Promise<S2C>((res) => { const m = msgs.find((x) => x.t === t); if (m) { msgs.splice(msgs.indexOf(m), 1); res(m); } else waiters.push({ t, f: (x) => { msgs.splice(msgs.indexOf(x), 1); res(x); } }); });
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', name, ver: PROTOCOL_VERSION })); resolve({ ws, msgs, wait }); };
    });
    try {
      const a = await open('Anna');
      const b = await open('Boris');
      await a.wait('welcome'); await b.wait('welcome');
      a.ws.send(JSON.stringify({ t: 'create', name: 'Okruh', settings: { trackId: 'horizon-park', laps: 2, weather: 'rain', cls: 'GT', maxPlayers: 6 } }));
      let room = (await a.wait('room')) as Extract<S2C, { t: 'room' }>;
      while (!room.room) room = (await a.wait('room')) as Extract<S2C, { t: 'room' }>;
      b.ws.send(JSON.stringify({ t: 'join', roomId: room.room.id }));
      await b.wait('room');
      // dlhá správa (>125 B → 16-bit dĺžka rámca) + diakritika
      const text = 'Ahoj, ideme na to! Žlté svetlá, ďaleko, ľavá zákruta. '.repeat(3).trim();
      b.ws.send(JSON.stringify({ t: 'chat', text }));
      let chat = (await a.wait('chat')) as Extract<S2C, { t: 'chat' }>;
      while (chat.from == null) chat = (await a.wait('chat')) as Extract<S2C, { t: 'chat' }>;
      expect(chat.name).toBe('Boris');
      expect(chat.text).toBe(text);
      const health = await (await fetch(`http://127.0.0.1:${srv.port}/health`)).json() as { rooms: number; clients: number };
      expect(health).toMatchObject({ ok: true, rooms: 1, clients: 2 });
      a.ws.close(); b.ws.close();
    } finally {
      await srv.close();
    }
  });
});
