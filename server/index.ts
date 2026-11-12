import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { LIMITS, type S2C } from '../src/net/protocol';
import { Lobby, type Peer } from './lobby';
import { attachWebSocket } from './ws';

/**
 * Online server Race Horizon: `npm run server` (predvolený port 8787, zmena cez `PORT=9000`).
 * Bez externých závislostí – WebSocket vrstva je v `server/ws.ts`.
 */
export function startServer(port: number, host = '0.0.0.0') {
  const lobby = new Lobby();
  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: lobby.roomCount, clients: lobby.clientCount }));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Race Horizon server – pripoj sa cez WebSocket.\n');
  });
  const stopWs = attachWebSocket(http, { maxMessage: LIMITS.message }, (conn) => {
    const id = `p-${randomBytes(6).toString('hex')}`;
    const peer: Peer = { id, send: (m: S2C) => conn.send(JSON.stringify(m)) };
    lobby.connect(peer);
    conn.onMessage = (text) => {
      let msg: unknown;
      try { msg = JSON.parse(text); } catch { return; }
      lobby.handle(id, msg);
    };
    conn.onClose = () => lobby.disconnect(id);
  });
  const timer = setInterval(() => lobby.tick(), 25);
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      const addr = http.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () => new Promise<void>((done) => { clearInterval(timer); stopWs(); http.close(() => done()); http.closeAllConnections?.(); }),
      });
    });
  });
}
