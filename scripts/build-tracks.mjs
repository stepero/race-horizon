// Generuje public/tracks/*.json z data/raw-tracks/*.csv (TUMFTM racetrack-database, LGPL-3.0)
// a dočasné trate (placeholder) pre okruhy, ktoré v databáze nie sú.
// Spustenie: npm run tracks
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data/raw-tracks');
const OUT = path.join(ROOT, 'public/tracks');
fs.mkdirSync(OUT, { recursive: true });

const DS = 5; // vzdialenosť medzi bodmi [m]

// id trate -> zdroj
const REAL = {
  melbourne: 'Melbourne', shanghai: 'Shanghai', suzuka: 'Suzuka', montreal: 'Montreal',
  barcelona: 'Catalunya', spielberg: 'Spielberg', silverstone: 'Silverstone', spa: 'Spa',
  hungaroring: 'Budapest', zandvoort: 'Zandvoort', monza: 'Monza', sepang: 'Sepang',
  cota: 'Austin', mexico: 'MexicoCity', interlagos: 'SaoPaulo', yasmarina: 'YasMarina',
};

// Dočasné trate: hrubé tvary riadiacich bodov [m]. Neodrážajú presné rozloženie skutočných okruhov.
// Vlastný fiktívny základný okruh Race Horizon (nie je dočasný – je to originálna trať hry).
const FICTIONAL = {
  'horizon-park': { scale: 1.0, halfW: 7.5, runoff: 14, pts: [[0,0],[500,0],[820,-20],[1000,80],[1010,260],[860,340],[700,300],[560,380],[600,540],[780,600],[900,760],[800,900],[560,920],[380,820],[180,860],[-60,820],[-200,660],[-140,480],[-280,360],[-300,180],[-180,50]] },
};

const PLACEHOLDER = {
  miami: { scale: 1.0, halfW: 7.5, runoff: 10, pts: [[0,0],[700,0],[1000,40],[1150,160],[1100,300],[950,360],[1000,470],[1150,540],[1250,700],[1100,840],[800,850],[600,760],[420,830],[200,800],[100,640],[-150,600],[-250,420],[-120,300],[-250,180],[-150,50]] },
  monaco: { scale: 1.45, halfW: 5.5, runoff: 2.5, pts: [[0,0],[250,0],[330,30],[380,100],[360,170],[300,200],[240,190],[200,240],[230,300],[330,330],[420,300],[470,330],[450,400],[350,430],[200,420],[100,440],[0,420],[-80,380],[-90,300],[-50,240],[-100,180],[-90,100],[-50,40]] },
  madring: { scale: 1.0, halfW: 7.2, runoff: 9, pts: [[0,0],[600,0],[850,-60],[1050,40],[1100,230],[950,330],[1000,480],[1180,560],[1150,760],[950,840],[700,780],[520,860],[300,800],[240,620],[40,560],[-180,640],[-330,520],[-300,320],[-120,260],[-200,120],[-120,30]] },
  baku: { scale: 1.0, halfW: 6.5, runoff: 3.5, pts: [[0,0],[900,0],[1500,0],[1750,60],[1800,200],[1700,330],[1500,360],[1450,480],[1560,600],[1500,720],[1300,740],[1200,640],[1000,640],[850,760],[600,780],[400,700],[420,560],[250,500],[100,560],[-50,500],[-150,350],[-120,180],[-200,100],[-120,40]] },
  singapore: { scale: 1.0, halfW: 6.5, runoff: 3.0, pts: [[0,0],[450,0],[700,0],[790,80],[740,170],[800,260],[760,360],[900,420],[1000,520],[950,630],[800,610],[700,680],[740,780],[600,860],[420,820],[300,720],[320,600],[200,560],[100,640],[-30,600],[-100,480],[-40,380],[-200,300],[-250,160],[-150,60]] },
  vegas: { scale: 1.0, halfW: 8.0, runoff: 4.0, pts: [[0,0],[1500,0],[2400,0],[2650,40],[2700,200],[2600,330],[2300,360],[2200,520],[2300,640],[2200,760],[1800,780],[1500,760],[1450,640],[1200,600],[1100,720],[800,740],[450,740],[300,640],[350,500],[200,420],[0,400],[-150,300],[-150,120]] },
  lusail: { scale: 1.0, halfW: 8.5, runoff: 12, pts: [[0,0],[700,0],[1000,-10],[1180,100],[1160,260],[1000,330],[1040,470],[1200,540],[1180,720],[1000,790],[800,720],[620,780],[420,740],[330,600],[130,560],[-40,630],[-190,550],[-180,380],[-40,320],[-130,200],[-110,70]] },
};

// ---------- pomocné funkcie ----------
const hyp = Math.hypot;
function pathLength(p) { let L = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; L += hyp(b[0] - a[0], b[1] - a[1]); } return L; }

function resample(pts, ds) {
  // pts: [[x,y,wr,wl]...] uzavretá krivka
  const n = pts.length; const cum = [0];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; cum.push(cum[i] + hyp(b[0] - a[0], b[1] - a[1])); }
  const L = cum[n]; const m = Math.round(L / ds); const step = L / m; const out = [];
  let j = 0;
  for (let k = 0; k < m; k++) {
    const s = k * step;
    while (cum[j + 1] < s) j++;
    const a = pts[j % n], b = pts[(j + 1) % n]; const t = (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1);
    out.push(a.map((v, c) => v + (b[c] - v) * t));
  }
  return out;
}

function smooth(arr, passes, cols) {
  let cur = arr.map((r) => r.slice());
  for (let p = 0; p < passes; p++) {
    const nxt = cur.map((r) => r.slice());
    for (let i = 0; i < cur.length; i++) {
      const a = cur[(i - 1 + cur.length) % cur.length], b = cur[i], c = cur[(i + 1) % cur.length];
      for (const k of cols) nxt[i][k] = 0.25 * a[k] + 0.5 * b[k] + 0.25 * c[k];
    }
    cur = nxt;
  }
  return cur;
}

function headings(p) {
  const n = p.length; const h = new Array(n);
  for (let i = 0; i < n; i++) { const a = p[(i - 1 + n) % n], b = p[(i + 1) % n]; h[i] = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  return h;
}
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

function catmull(ctrl, perSeg) {
  // centripetal Catmull-Rom, uzavretá
  const n = ctrl.length; const out = [];
  const tj = (ti, a, b) => ti + Math.pow(hyp(b[0] - a[0], b[1] - a[1]), 0.5);
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    for (let k = 0; k < perSeg; k++) {
      const t = t1 + ((t2 - t1) * k) / perSeg;
      const L = (a, b, ta, tb) => [0, 1].map((c) => ((tb - t) / (tb - ta)) * a[c] + ((t - ta) / (tb - ta)) * b[c]);
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = [0, 1].map((c) => ((t2 - t) / (t2 - t0)) * A1[c] + ((t - t0) / (t2 - t0)) * A2[c]);
      const B2 = [0, 1].map((c) => ((t3 - t) / (t3 - t1)) * A2[c] + ((t - t1) / (t3 - t1)) * A3[c]);
      out.push([0, 1].map((c) => ((t2 - t) / (t2 - t1)) * B1[c] + ((t - t1) / (t2 - t1)) * B2[c]));
    }
  }
  return out;
}

function minCurvatureLine(pts, margin) {
  // pts: [x,y,wr,wl]; q = bočný posun od stredu (kladný = vľavo)
  const n = pts.length; const h = headings(pts);
  const nx = h.map((a) => -Math.sin(a)), ny = h.map((a) => Math.cos(a));
  const q = new Float64Array(n);
  const lo = pts.map((p) => -(p[2] - margin)), hi = pts.map((p) => p[3] - margin);
  const P = (i) => { const k = ((i % n) + n) % n; return [pts[k][0] + nx[k] * q[k], pts[k][1] + ny[k] * q[k]]; };
  for (let it = 0; it < 4000; it++) {
    for (let i = 0; i < n; i++) {
      const a = P(i - 2), b = P(i - 1), c = P(i), d = P(i + 1), e = P(i + 2);
      const gx = a[0] - 4 * b[0] + 6 * c[0] - 4 * d[0] + e[0];
      const gy = a[1] - 4 * b[1] + 6 * c[1] - 4 * d[1] + e[1];
      q[i] -= 0.12 * (gx * nx[i] + gy * ny[i]);
      q[i] = Math.max(lo[i], Math.min(hi[i], q[i]));
    }
  }
  // vyhladenie q
  let qq = Array.from(q);
  for (let p = 0; p < 6; p++) qq = qq.map((v, i) => (0.25 * qq[(i - 1 + n) % n] + 0.5 * v + 0.25 * qq[(i + 1) % n]));
  return qq.map((v, i) => Math.max(lo[i], Math.min(hi[i], v)));
}

function findStart(pts) {
  // najrovnejší úsek (okno ~650 m): minimalizuje súčet |zmena smeru|
  const n = pts.length; const h = headings(pts); const W = Math.round(650 / DS);
  let best = 0, bestV = Infinity;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < W; k++) v += Math.abs(wrap(h[(i + k + 1) % n] - h[(i + k) % n]));
    if (v < bestV) { bestV = v; best = i; }
  }
  return (best + Math.round(W / 2)) % n; // stred okna
}

function selfIntersects(pts, minDist) {
  const n = pts.length; const gap = Math.round(80 / DS);
  for (let i = 0; i < n; i += 2) for (let j = i + gap; j < n; j += 2) {
    if (n - (j - i) < gap) continue;
    if (hyp(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < minDist) return [i, j];
  }
  return null;
}

function findCrossings(pts) {
  // nájdi páry segmentov, ktoré sa pretínajú (trať sa kríži sama so sebou → most)
  const n = pts.length; const res = [];
  const inter = (a, b, c, d) => {
    const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    return cr(a, b, c) * cr(a, b, d) < 0 && cr(c, d, a) * cr(c, d, b) < 0;
  };
  for (let i = 0; i < n; i++) for (let j = i + 20; j < n; j++) {
    if (n - (j - i) < 20) continue;
    if (inter(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) res.push([i, j]);
  }
  return res;
}

function choosePitSide(pts) {
  const n = pts.length; const h = headings(pts);
  const span = Math.round(330 / DS);
  const score = (side) => {
    let worst = Infinity;
    for (let k = -span; k <= span; k++) {
      const i = (k + n) % n;
      const w = side < 0 ? pts[i][2] : pts[i][3];
      const off = side * (w + 14);
      const px = pts[i][0] - Math.sin(h[i]) * off, py = pts[i][1] + Math.cos(h[i]) * off;
      for (let j = 0; j < n; j++) {
        const dj = Math.min(Math.abs(j - i), n - Math.abs(j - i));
        if (dj < span + 20) continue;
        const dd = hyp(pts[j][0] - px, pts[j][1] - py) - Math.max(pts[j][2], pts[j][3]);
        if (dd < worst) worst = dd;
      }
    }
    return worst;
  };
  const r = score(-1), l = score(1);
  return r >= 12 || r >= l ? -1 : 1;
}

function build(id, raw, opts) {
  let pts = resample(raw, DS);
  pts = smooth(pts, opts.smoothPasses ?? 3, [0, 1]);
  pts = resample(pts, DS);
  // šírky: obmedz a vyhladí
  pts = pts.map((p) => [p[0], p[1], Math.max(opts.minHalf, Math.min(opts.maxHalf, p[2])), Math.max(opts.minHalf, Math.min(opts.maxHalf, p[3]))]);
  pts = smooth(pts, 6, [2, 3]);
  const st = findStart(pts);
  pts = pts.slice(st).concat(pts.slice(0, st));
  const line = minCurvatureLine(pts, 1.6);
  const n = pts.length;
  // --- výška: mosty v miestach, kde sa trať kríži sama so sebou ---
  const z = new Float64Array(n);
  const crossings = findCrossings(pts);
  for (const [i, j] of crossings) {
    const hi = j; // neskorší úsek ide po moste
    const span = Math.round(260 / DS);
    for (let k = -span; k <= span; k++) {
      const idx = (hi + k + n) % n;
      const t = Math.abs(k) / span;
      z[idx] = Math.max(z[idx], 8 * (0.5 + 0.5 * Math.cos(Math.PI * t)));
    }
    void i;
  }
  // --- strana boxovej uličky: vyber stranu bez kolízie s inou časťou trate ---
  const pitSide = choosePitSide(pts);

  const L = pathLength(pts);
  const clash = selfIntersects(pts, (opts.minHalf + 2) * 2);
  const r2 = (v) => Math.round(v * 100) / 100;
  const json = {
    id, ds: pathLength(pts) / pts.length, length: Math.round(L), placeholder: !!opts.placeholder,
    n: pts.length, x: pts.map((p) => r2(p[0])), y: pts.map((p) => r2(p[1])),
    wr: pts.map((p) => r2(p[2])), wl: pts.map((p) => r2(p[3])), line: line.map(r2),
    z: Array.from(z, r2),
    runoff: opts.runoff, fictional: !!opts.fictional,
    // vzhľadom na štartovú čiaru [m]; side: -1 = vpravo, +1 = vľavo
    pit: { sIn: -310, sOut: 310, boxFrom: -140, boxSpacing: 9.5, side: pitSide },
  };
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(json));
  return { id, L, n: pts.length, clash, placeholder: !!opts.placeholder, crossings: crossings.length, pitSide };
}

const report = [];
for (const [id, file] of Object.entries(REAL)) {
  const rows = fs.readFileSync(path.join(RAW, `${file}.csv`), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').map(Number));
  report.push(build(id, rows, { minHalf: 6.0, maxHalf: 8.5, runoff: 12, smoothPasses: 2 }));
}
for (const [id, d] of [...Object.entries(FICTIONAL).map(([k, v]) => [k, { ...v, fictional: true }]), ...Object.entries(PLACEHOLDER)]) {
  let ctrl = d.pts.map(([x, y]) => [x * d.scale, y * d.scale]);
  const cx = ctrl.reduce((s, p) => s + p[0], 0) / ctrl.length, cy = ctrl.reduce((s, p) => s + p[1], 0) / ctrl.length;
  ctrl = ctrl.map(([x, y]) => [x - cx, y - cy]);
  const dense = catmull(ctrl, 24).map(([x, y]) => [x, y, d.halfW, d.halfW]);
  report.push(build(id, dense, { minHalf: d.halfW, maxHalf: d.halfW, runoff: d.runoff, placeholder: !d.fictional, fictional: !!d.fictional, smoothPasses: 4 }));
}
for (const r of report) {
  console.log(`${r.id.padEnd(12)} ${String(Math.round(r.L)).padStart(6)} m  ${String(r.n).padStart(5)} pts  ${r.placeholder ? 'PLACEHOLDER' : 'real'}  pit=${r.pitSide < 0 ? 'R' : 'L'} mosty=${r.crossings} ${r.clash && !r.crossings ? '!! BLÍZKO ' + r.clash : ''}`);
}
