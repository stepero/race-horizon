import type { RaceEvent, Racer } from './race';
import type { Track, TrackQuery } from './track';
import { clamp } from './math';

export const CAR_R = 0.95;

export function wallCollision(track: Track, r: Racer, q: TrackQuery, events: RaceEvent[]): void {
  const st = r.st;
  const side = q.d >= 0 ? 1 : -1;
  const wd = track.wallDist(q.s, side);
  const pen = Math.abs(q.d) + 1.0 - wd;
  if (pen <= 0) return;
  const th = q.heading;
  const nx = -Math.sin(th) * -side, ny = Math.cos(th) * -side; // smer od steny dovnútra
  const c = Math.cos(st.heading), s = Math.sin(st.heading);
  st.x += nx * (pen + 0.01); st.y += ny * (pen + 0.01);
  const wvx = st.vx * c - st.vy * s, wvy = st.vx * s + st.vy * c;
  const vn = wvx * nx + wvy * ny;
  if (vn >= 0) return;
  const e = 0.12;
  let nvx = wvx - (1 + e) * vn * nx, nvy = wvy - (1 + e) * vn * ny;
  const tx = -ny, ty = nx;
  const vt = nvx * tx + nvy * ty;
  nvx -= vt * tx * 0.1; nvy -= vt * ty * 0.1;
  st.vx = nvx * c + nvy * s;
  st.vy = -nvx * s + nvy * c;
  st.r *= 0.75;
  applyDamage(r, -nx, -ny, -vn, 1, events);
}

/** Poškodenie podľa smeru nárazu (world vektor smerom k prekážke) a rýchlosti nárazu. */
export function applyDamage(r: Racer, dirX: number, dirY: number, impact: number, scale: number, events: RaceEvent[]): void {
  if (impact < 2.5) return;
  const st = r.st;
  const c = Math.cos(st.heading), s = Math.sin(st.heading);
  const fwd = dirX * c + dirY * s;
  const left = -dirX * s + dirY * c;
  const amount = clamp((impact / 38) ** 2, 0, 1) * scale;
  const add = (i: number, a: number) => { st.damage[i] = Math.min(1, st.damage[i] + a); };
  if (Math.abs(fwd) >= Math.abs(left)) { add(fwd > 0 ? 0 : 1, amount); add(left > 0 ? 2 : 3, amount * 0.3); }
  else { add(left > 0 ? 2 : 3, amount); add(fwd > 0 ? 0 : 1, amount * 0.35); }
  r.hits++;
  if (r.isPlayer) events.push({ type: 'hit', racer: r, value: impact });
}

export function carCollisions(rs: Racer[], events: RaceEvent[]): void {
  for (let i = 0; i < rs.length; i++) {
    const a = rs[i];
    for (let j = i + 1; j < rs.length; j++) {
      const b = rs[j];
      if (a.hidden || b.hidden || (a.remote && b.remote)) continue;
      const dx0 = b.st.x - a.st.x, dy0 = b.st.y - a.st.y;
      if (dx0 * dx0 + dy0 * dy0 > 36) continue;
      if (a.pit.phase === 'service' && b.pit.phase === 'service') continue;
      const ca = Math.cos(a.st.heading), sa = Math.sin(a.st.heading);
      const cb = Math.cos(b.st.heading), sb = Math.sin(b.st.heading);
      const oa = a.spec.length / 2 - CAR_R - 0.2, ob = b.spec.length / 2 - CAR_R - 0.2;
      let best = 0, bnx = 0, bny = 0, bxa = 0, bxb = 0;
      for (let u = -1; u <= 1; u++) {
        const pax = a.st.x + ca * oa * u, pay = a.st.y + sa * oa * u;
        for (let w = -1; w <= 1; w++) {
          const pbx = b.st.x + cb * ob * w, pby = b.st.y + sb * ob * w;
          const dx = pax - pbx, dy = pay - pby;
          const d = Math.hypot(dx, dy);
          const pen = 2 * CAR_R - d;
          if (pen > best && d > 1e-4) { best = pen; bnx = dx / d; bny = dy / d; bxa = oa * u; bxb = ob * w; }
        }
      }
      if (best <= 0) continue;
      // n smeruje z b na a
      const ma = a.spec.mass + a.st.fuel, mb = b.spec.mass + b.st.fuel;
      // cudzie (sieťové) auto je pre nás nehybná prekážka: celý vyhýbací pohyb a impulz nesie naše auto
      const ra = a.remote ? 0 : 1, rb = b.remote ? 0 : 1;
      const wa = a.remote ? 0 : b.remote ? 1 : mb / (ma + mb), wb = b.remote ? 0 : a.remote ? 1 : ma / (ma + mb);
      a.st.x += bnx * best * wa; a.st.y += bny * best * wa;
      b.st.x -= bnx * best * wb; b.st.y -= bny * best * wb;
      const avx = a.st.vx * ca - a.st.vy * sa, avy = a.st.vx * sa + a.st.vy * ca;
      const bvx = b.st.vx * cb - b.st.vy * sb, bvy = b.st.vx * sb + b.st.vy * cb;
      const vrel = (avx - bvx) * bnx + (avy - bvy) * bny;
      if (vrel < 0) {
        const e = 0.1;
        const jn = (-(1 + e) * vrel) / (ra / ma + rb / mb);
        const davx = ra * (jn / ma) * bnx, davy = ra * (jn / ma) * bny;
        const dbvx = -rb * (jn / mb) * bnx, dbvy = -rb * (jn / mb) * bny;
        const na = { x: avx + davx, y: avy + davy }, nb = { x: bvx + dbvx, y: bvy + dbvy };
        a.st.vx = na.x * ca + na.y * sa; a.st.vy = -na.x * sa + na.y * ca;
        b.st.vx = nb.x * cb + nb.y * sb; b.st.vy = -nb.x * sb + nb.y * cb;
        // moment od nárazu mimo ťažiska
        const dyA = -davx * sa + davy * ca, dyB = -dbvx * sb + dbvy * cb;
        if (!a.remote) a.st.r += clamp((bxa * dyA * ma) / a.spec.yawInertia, -0.8, 0.8);
        if (!b.remote) b.st.r += clamp((bxb * dyB * mb) / b.spec.yawInertia, -0.8, 0.8);
        const imp = -vrel;
        if (!a.remote) applyDamage(a, -bnx, -bny, imp, 0.8, events);
        if (!b.remote) applyDamage(b, bnx, bny, imp, 0.8, events);
      }
    }
  }
}

