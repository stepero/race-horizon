import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Minimálny WebSocket server (RFC 6455) bez externých závislostí – stačí na textové JSON správy.
 * Podporuje: handshake, maskované rámce od klienta, fragmentáciu, ping/pong, close, limit veľkosti správy.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsConn {
  readonly remote: string;
  send(text: string): void;
  close(code?: number): void;
  onMessage: (text: string) => void;
  onClose: () => void;
}

export interface WsOptions {
  maxMessage: number;
  /** Interval pingu [ms]; spojenie bez odozvy 2,5× dlhšie sa zruší. */
  pingMs?: number;
}

export function attachWebSocket(server: Server, opts: WsOptions, onConnection: (c: WsConn) => void): () => void {
  const conns = new Set<Conn>();
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    if (upgrade !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const c = new Conn(socket, opts, String(req.socket.remoteAddress ?? ''), () => conns.delete(c));
    conns.add(c);
    onConnection(c);
    if (head.length) c.feed(head);
  });
  const ping = setInterval(() => { for (const c of conns) c.heartbeat(); }, opts.pingMs ?? 15000);
  ping.unref?.();
  return () => { clearInterval(ping); for (const c of [...conns]) c.close(1001); };
}

class Conn implements WsConn {
  onMessage: (text: string) => void = () => undefined;
  onClose: () => void = () => undefined;
  private buf: Buffer = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private fragLen = 0;
  private closed = false;
  private lastSeen = Date.now();
  private sock: Duplex;
  private opts: WsOptions;
  private onGone: () => void;
  readonly remote: string;

  constructor(sock: Duplex, opts: WsOptions, remote: string, onGone: () => void) {
    this.sock = sock; this.opts = opts; this.remote = remote; this.onGone = onGone;
    sock.on('data', (d: Buffer) => this.feed(d));
    sock.on('close', () => this.finish());
    sock.on('error', () => this.finish());
    sock.on('end', () => this.finish());
  }

  feed(d: Buffer): void {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed) {
      const f = this.parse();
      if (!f) break;
      this.handle(f.op, f.fin, f.payload);
    }
  }

  private parse(): { op: number; fin: boolean; payload: Buffer } | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const hi = b.readUInt32BE(2);
      if (hi !== 0) { this.fail(1009); return null; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (!masked || (b[0] & 0x70) !== 0) { this.fail(1002); return null; }
    if (len > this.opts.maxMessage || this.fragLen + len > this.opts.maxMessage) { this.fail(1009); return null; }
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    return { op, fin, payload };
  }

  private handle(op: number, fin: boolean, payload: Buffer): void {
    switch (op) {
      case 0x0: // pokračovanie fragmentovanej správy
      case 0x1: {
        if (op === 0x1 && this.frags.length) { this.fail(1002); return; }
        if (op === 0x0 && !this.frags.length) { this.fail(1002); return; }
        this.frags.push(payload); this.fragLen += payload.length;
        if (!fin) return;
        const text = Buffer.concat(this.frags).toString('utf8');
        this.frags = []; this.fragLen = 0;
        try { this.onMessage(text); } catch (e) { console.error('[ws] chyba spracovania správy', e); }
        return;
      }
      case 0x2: this.fail(1003); return; // binárne správy nepoužívame
      case 0x8: this.close(1000); return;
      case 0x9: this.frame(0xa, payload); return;
      case 0xa: return;
      default: this.fail(1002);
    }
  }

  private frame(op: number, payload: Buffer): void {
    if (this.closed) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = len;
    else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    this.sock.write(Buffer.concat([head, payload]));
  }

  send(text: string): void { this.frame(0x1, Buffer.from(text, 'utf8')); }

  heartbeat(): void {
    if (this.closed) return;
    if (Date.now() - this.lastSeen > (this.opts.pingMs ?? 15000) * 2.5) { this.sock.destroy(); this.finish(); return; }
    this.frame(0x9, Buffer.alloc(0));
  }

  private fail(code: number): void { this.close(code); }

  close(code = 1000): void {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    this.frame(0x8, p);
    this.sock.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onGone();
    this.onClose();
  }
}
