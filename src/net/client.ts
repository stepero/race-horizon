import { PROTOCOL_VERSION, type C2S, type RoomInfo, type RoomSummary, type S2C } from './protocol';

export type NetStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface ChatLine { from: string | null; name: string; text: string; key?: string; params?: Record<string, string | number>; at: number }

/**
 * Klient online servera (prehliadačový WebSocket). Drží posledný známy stav (zoznam miestností,
 * vlastná miestnosť, chat) a každú prijatú správu posunie poslucháčom.
 */
export class NetClient {
  status: NetStatus = 'idle';
  id: string | null = null;
  rooms: RoomSummary[] = [];
  room: RoomInfo | null = null;
  chat: ChatLine[] = [];
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: S2C) => void>();
  private closeListeners = new Set<() => void>();

  /** Pripojí sa a pošle meno. Vyrieši sa po `welcome`, inak chyba (kľúč prekladu). */
  connect(url: string, name: string, timeoutMs = 6000): Promise<void> {
    this.close();
    this.status = 'connecting';
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { this.status = 'closed'; reject(new Error('net.err.url')); return; }
      this.ws = ws;
      let settled = false;
      const done = (err: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { this.status = 'closed'; try { ws.close(); } catch { /* */ } reject(new Error(err)); } else resolve();
      };
      const timer = setTimeout(() => done('net.err.timeout'), timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, ver: PROTOCOL_VERSION } satisfies C2S));
      ws.onerror = () => done('net.err.connect');
      ws.onclose = () => {
        const wasOpen = this.status === 'open';
        done('net.err.connect');
        if (this.ws !== ws) return;
        this.status = 'closed';
        this.room = null;
        this.ws = null;
        // poslucháči sa upozornia len na pád už vytvoreného spojenia (zlyhané pripojenie rieši `connect`)
        if (wasOpen) for (const f of this.closeListeners) f();
      };
      ws.onmessage = (ev) => {
        let m: S2C;
        try { m = JSON.parse(String(ev.data)) as S2C; } catch { return; }
        if (m.t === 'welcome') { this.id = m.id; this.status = 'open'; done(null); }
        if (m.t === 'error' && !settled) { done(m.key); return; }
        this.absorb(m);
        for (const f of this.listeners) f(m);
      };
    });
  }

  private absorb(m: S2C): void {
    switch (m.t) {
      case 'rooms': this.rooms = m.rooms; break;
      case 'room':
        if (!m.room || m.room.id !== this.room?.id) this.chat = [];
        this.room = m.room;
        break;
      case 'chat':
        this.chat.push({ from: m.from, name: m.name, text: m.text, key: m.key, params: m.params, at: performance.now() });
        if (this.chat.length > 60) this.chat.splice(0, this.chat.length - 60);
        break;
      default: break;
    }
  }

  get connected(): boolean { return this.status === 'open' && !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  get isHost(): boolean { return !!this.room && this.room.hostId === this.id; }

  send(m: C2S): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  on(f: (m: S2C) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  onClose(f: () => void): () => void {
    this.closeListeners.add(f);
    return () => this.closeListeners.delete(f);
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.room = null;
    this.status = 'idle';
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; try { ws.close(); } catch { /* */ } }
  }
}

/** Predvolená adresa servera: rovnaký počítač ako stránka, port 8787 (alebo `?server=ws://…`). */
export function defaultServerUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  // produkčný build: adresa nasadeného servera (VITE_SERVER_URL pri builde)
  const built = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (built) return built;
  const host = location.hostname || 'localhost';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${host}:8787`;
}
