import type { Racer } from '../sim/race';
import type { Sim } from '../sim/sim';
import { PIT_LIMIT } from '../sim/track';
import { clamp, fmtTime } from '../sim/math';
import { t } from '../i18n';
import { el, setClass, setText } from './dom';
import type { Settings } from '../settings';
import { lapsLeftOf } from '../sim/sim';

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

function wearColor(w: number): string {
  // w = opotrebenie 0..1
  if (w < 0.45) return '#3ddc84';
  if (w < 0.65) return '#d9e04a';
  if (w < 0.82) return '#ffa52e';
  return '#ff3b3b';
}

/**
 * HUD pretekov. Sklada sa z DOM prvkov (text, tabuľky) a dvoch plátien (budík a minimapa).
 * Vpravo dole je digitálny + analógový budík so zaradeným stupňom; vpravo hore tréner.
 */
export class Hud {
  readonly root: HTMLElement;
  private coachEl = el('div', { class: 'coach', 'aria-live': 'polite' });
  private pos = el('div', { class: 'pos' });
  private lapEl = el('div', { class: 'lapinfo' });
  private timeEl = el('div', { class: 'timeinfo' });
  private bestEl = el('div', { class: 'bestinfo' });
  private standings = el('div', { class: 'standings' });
  private weatherEl = el('div', { class: 'weather' });
  private lightsEl = el('div', { class: 'startlights' });
  private lightDots: HTMLElement[] = [];
  private banner = el('div', { class: 'banner' });
  private pitPanel = el('div', { class: 'pitpanel' });
  private pitRows: Record<string, { fill: HTMLElement; row: HTMLElement }> = {};
  private pitLimit = el('div', { class: 'pitlimit' });
  private warn = el('div', { class: 'warnbox' });
  private fuelFill = el('div', { class: 'fill' });
  private fuelTxt = el('span');
  private tyreEls: { box: HTMLElement; txt: HTMLElement }[] = [];
  private dmgFills: HTMLElement[] = [];
  private assistEls = { abs: el('span', { class: 'ind' }, t('hud.abs')), tc: el('span', { class: 'ind' }, t('hud.tc')), asr: el('span', { class: 'ind' }, t('hud.steerAssist')) };
  private camEl = el('div', { class: 'camhint' });
  private gauge = el('canvas', { class: 'gauge', width: 260, height: 260 });
  private mini = el('canvas', { class: 'minimap', width: 220, height: 220 });
  private miniWrap = el('div', { class: 'minimap-wrap' });
  private gaugeBase: HTMLCanvasElement | null = null;
  private miniBase: HTMLCanvasElement | null = null;
  private miniTf = { s: 1, ox: 0, oy: 0 };
  private maxKph: number;
  private textTimer = 0;
  private rowCache: HTMLElement[] = [];
  private lastCoach = '';

  private world: boolean;

  constructor(private race: Sim, private settings: () => Settings) {
    this.world = !!race.free;
    const spec = race.player.spec;
    this.maxKph = Math.ceil((spec.topSpeed * 3.6 * 1.04) / 50) * 50;

    for (let i = 0; i < 5; i++) { const d = el('i'); this.lightDots.push(d); this.lightsEl.append(d); }

    const tyreGrid = el('div', { class: 'tyres' });
    for (const k of ['fl', 'fr', 'rl', 'rr'] as const) {
      const txt = el('span');
      const box = el('div', { class: 'tyre', title: t('hud.tyre.' + k) }, el('b', null, t('hud.tyre.' + k)), txt);
      this.tyreEls.push({ box, txt });
      tyreGrid.append(box);
    }
    const dmg = el('div', { class: 'dmg' });
    for (const k of ['front', 'rear', 'left', 'right']) {
      const f = el('div', { class: 'fill' });
      this.dmgFills.push(f);
      dmg.append(el('div', { class: 'dmgrow' }, el('span', null, t('hud.dmg.' + k)), el('div', { class: 'bar' }, f)));
    }
    const status = el('div', { class: 'status' },
      el('div', { class: 'blk' }, el('h4', null, t('hud.fuel')), el('div', { class: 'bar' }, this.fuelFill), this.fuelTxt),
      el('div', { class: 'blk' }, el('h4', null, t('hud.tyres')), tyreGrid),
      el('div', { class: 'blk' }, el('h4', null, t('hud.damage')), dmg),
      el('div', { class: 'inds' }, this.assistEls.abs, this.assistEls.tc, this.assistEls.asr),
    );

    this.miniWrap.append(this.mini);
    for (const [key, label] of [['tyres', 'service.tyres'], ['fuel', 'service.fuel'], ['repair', 'service.repair']] as const) {
      const fill = el('div', { class: 'fill' });
      const row = el('div', { class: 'prow' }, el('span', null, t('hud.' + label)), el('div', { class: 'bar' }, fill));
      this.pitRows[key] = { fill, row };
      this.pitPanel.append(row);
    }
    this.pitPanel.prepend(el('h3', null, t('hud.pitStop')));

    const topLeft = el('div', { class: 'topleft' }, this.pos, this.lapEl, this.timeEl, this.bestEl);
    this.root = el('div', { class: 'hud' },
      topLeft, this.standings,
      el('div', { class: 'topright' }, this.coachEl, this.weatherEl),
      this.lightsEl, this.banner, this.pitPanel, this.pitLimit, this.warn,
      el('div', { class: 'bottomleft' }, this.miniWrap, status),
      el('div', { class: 'bottomright' }, this.camEl, this.gauge),
    );
    if (this.world) this.root.classList.add('world');
    else this.buildMiniBase();
    this.buildGaugeBase();
  }

  // ---------------------------------------------------------------- statické vrstvy
  private buildMiniBase(): void {
    const d = this.race.track.d;
    const W = this.mini.width, H = this.mini.height, pad = 14;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < d.n; i++) { minX = Math.min(minX, d.x[i]); maxX = Math.max(maxX, d.x[i]); minY = Math.min(minY, d.y[i]); maxY = Math.max(maxY, d.y[i]); }
    const s = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const ox = (W - (maxX - minX) * s) / 2 - minX * s;
    const oy = (H - (maxY - minY) * s) / 2 + maxY * s;
    this.miniTf = { s, ox, oy };
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const path = () => {
      g.beginPath();
      const step = Math.max(1, Math.floor(d.n / 400));
      for (let i = 0; i <= d.n; i += step) {
        const k = i % d.n;
        const px = d.x[k] * s + ox, py = -d.y[k] * s + oy;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    };
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 8; path(); g.stroke();
    g.strokeStyle = '#d9dde3'; g.lineWidth = 4.5; path(); g.stroke();
    g.strokeStyle = '#3a3f48'; g.lineWidth = 2.6; path(); g.stroke();
    // štartová čiara
    const x0 = d.x[0] * s + ox, y0 = -d.y[0] * s + oy;
    g.fillStyle = '#fff'; g.fillRect(x0 - 5, y0 - 1.5, 10, 3);
    this.miniBase = c;
  }

  private buildGaugeBase(): void {
    const dpr = DPR();
    const S = 260;
    this.gauge.width = S * dpr; this.gauge.height = S * dpr;
    this.gauge.style.width = S + 'px'; this.gauge.style.height = S + 'px';
    const c = document.createElement('canvas'); c.width = S * dpr; c.height = S * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const cx = S / 2, cy = S / 2, R = 120;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const ang = (v: number) => a0 + (a1 - a0) * (v / this.maxKph);
    // plocha
    const grad = g.createRadialGradient(cx, cy, 20, cx, cy, R + 8);
    grad.addColorStop(0, 'rgba(18,22,30,0.88)'); grad.addColorStop(1, 'rgba(6,8,12,0.92)');
    g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R + 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R + 6, 0, Math.PI * 2); g.stroke();
    // delenia
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let v = 0; v <= this.maxKph; v += 10) {
      const major = v % 50 === 0;
      const a = ang(v);
      const r1 = R - (major ? 16 : 8), r2 = R - 1;
      g.strokeStyle = major ? '#f2f4f8' : 'rgba(255,255,255,0.4)';
      g.lineWidth = major ? 2.4 : 1.2;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
      if (major && v % 50 === 0 && (v % 100 === 0 || this.maxKph <= 350)) {
        g.fillStyle = '#e6e9ee'; g.font = '600 13px "Barlow Condensed", sans-serif';
        g.fillText(String(v), cx + Math.cos(a) * (R - 30), cy + Math.sin(a) * (R - 30));
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = '600 11px "Barlow Condensed", sans-serif';
    g.fillText(t('hud.kph').toUpperCase(), cx, cy + 62);
    this.gaugeBase = c;
  }

  // ---------------------------------------------------------------- aktualizácia
  update(dt: number, coachKey: string, camMode: 'chase' | 'cockpit'): void {
    const race = this.race;
    const p = race.player;
    const st = p.st;
    const showMini = this.settings().minimap;
    setClass(this.miniWrap, 'off', !showMini);
    this.drawGauge(p);
    if (showMini) this.drawMini();

    // štartové svetlá
    const goFlash = !this.world && race.phase === 'racing' && race.time < 1.4;
    const lit = race.phase === 'lights' ? race.lights : goFlash ? -1 : 0;
    setClass(this.lightsEl, 'show', race.phase === 'lights' || goFlash);
    this.lightDots.forEach((d, i) => {
      setClass(d, 'red', lit > i);
      setClass(d, 'green', lit === -1);
    });

    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 0.08;

    if (coachKey !== this.lastCoach) { setText(this.coachEl, t(coachKey)); this.lastCoach = coachKey; }

    const total = race.sorted.length || race.racers.length;
    setText(this.pos, `P${p.pos}`);
    this.pos.dataset.total = `/${total}`;
    if (this.world) setText(this.pos, '');
    if (this.world) this.updateWorldInfo();
    else {
      if (race.cfg.durationS != null) {
        const left = Math.max(0, race.cfg.durationS - race.time);
        setText(this.lapEl, `${t('hud.lap')} ${p.lapsDone + 1} · ${t('hud.remaining')} ${fmtTime(race.phase === 'racing' ? left : race.cfg.durationS)}`);
      } else {
        const lap = Math.min(p.lapsDone + 1, race.cfg.laps);
        setText(this.lapEl, `${t('hud.lap')} ${lap}/${race.cfg.laps}`);
      }
      setText(this.timeEl, `${t('hud.time')} ${fmtTime(race.phase === 'racing' ? race.time : 0)}`);
      setText(this.bestEl, `${t('hud.lastLap')} ${fmtTime(p.lastLap)} · ${t('hud.bestLap')} ${fmtTime(p.bestLap)}`);
    }
    setText(this.weatherEl, `${t('hud.weatherNow')}: ${t('weather.' + race.weather.label)} · ${t('hud.wetness')} ${Math.round(race.weather.wetness * 100)} %`);
    setText(this.camEl, `${t('hud.camHint')} · ${t(camMode === 'cockpit' ? 'hud.cam.cockpit' : 'hud.cam.chase')}`);

    // ----- stav auta
    const cap = p.spec.fuelCapacity;
    const fuelFrac = st.fuel / cap;
    this.fuelFill.style.width = `${clamp(fuelFrac, 0, 1) * 100}%`;
    this.fuelFill.style.background = fuelFrac < 0.15 ? '#ff3b3b' : fuelFrac < 0.3 ? '#ffa52e' : '#3ddc84';
    const lapFuel = p.fuelPerM * race.track.length;
    const laps = lapFuel > 0 ? st.fuel / lapFuel : 99;
    setText(this.fuelTxt, `${st.fuel.toFixed(1)} kg · ${t('hud.fuelLaps', { n: laps < 99 ? laps.toFixed(1) : '∞' })}`);
    let maxWear = 0;
    this.tyreEls.forEach((e, i) => {
      const w = st.wear[i];
      maxWear = Math.max(maxWear, w);
      e.box.style.setProperty('--c', wearColor(w));
      setText(e.txt, `${Math.round((1 - w) * 100)}%`);
      setClass(e.box, 'bad', w > 0.8);
    });
    let maxDmg = 0;
    this.dmgFills.forEach((f, i) => {
      const d = st.damage[i];
      maxDmg = Math.max(maxDmg, d);
      f.style.width = `${d * 100}%`;
      f.style.background = d < 0.3 ? '#d9e04a' : d < 0.6 ? '#ffa52e' : '#ff3b3b';
    });
    setClass(this.assistEls.abs, 'on', st.absActive);
    setClass(this.assistEls.tc, 'on', st.tcActive);
    setClass(this.assistEls.asr, 'on', st.steerAssistActive);
    setClass(this.assistEls.abs, 'dim', !race.assists.abs);
    setClass(this.assistEls.tc, 'dim', race.assists.tc === 0);
    setClass(this.assistEls.asr, 'dim', race.assists.steer === 0);

    // ----- jasné varovanie + odporúčanie zastávky
    const lapsLeft = lapsLeftOf(race, p);
    let warnMsg = '';
    let crit = false;
    if (!this.world && !p.finished && lapsLeft > 1) {
      if (maxWear > 0.85) { warnMsg = t('warn.tyresCritical'); crit = true; }
      else if (laps < 0.8) { warnMsg = t('warn.fuel'); crit = true; }
      else if (maxWear > 0.62) warnMsg = t('warn.tyres');
      else if (laps < 1.7) warnMsg = t('warn.fuel');
      else if (maxDmg > 0.3) warnMsg = t('warn.damage');
    }
    setText(this.warn, warnMsg);
    setClass(this.warn, 'show', !!warnMsg && p.pit.phase === 'none');
    setClass(this.warn, 'crit', crit);

    // ----- boxy
    const inLane = race.track.inPitLane(p.q);
    const serving = p.pit.phase === 'service';
    setClass(this.pitPanel, 'show', serving);
    if (serving) {
      const { plan, t: tt } = p.pit;
      const prog = (from: number, len: number) => (len <= 0 ? 1 : clamp((tt - from) / len, 0, 1));
      this.pitRows.tyres.fill.style.width = `${prog(0, plan.tyres) * 100}%`;
      this.pitRows.fuel.fill.style.width = `${prog(plan.tyres, plan.fuel) * 100}%`;
      this.pitRows.repair.fill.style.width = `${prog(plan.tyres + plan.fuel, plan.repair) * 100}%`;
      setClass(this.pitRows.tyres.row, 'skip', plan.tyres <= 0);
      setClass(this.pitRows.fuel.row, 'skip', plan.fuel <= 0);
      setClass(this.pitRows.repair.row, 'skip', plan.repair <= 0);
    }
    const limiting = race.track.inPitSpeedZone(p.q);
    setClass(this.pitLimit, 'show', limiting && !serving);
    if (limiting) setText(this.pitLimit, `${t('hud.pitZone')} · ${t('hud.speedLimit', { kph: Math.round(PIT_LIMIT * 3.6) })}`);
    let b = '';
    if (!this.world && p.finished) b = t('hud.finishedBanner', { pos: p.pos });
    else if (goFlash) b = t('hud.go');
    else if (inLane && !p.pit.served && p.pit.phase !== 'service' && !p.finished) b = t('hud.stopInBox');
    else if (p.pit.phase === 'exit' && p.pit.stops > 0 && !inLane) b = '';
    setText(this.banner, b);
    setClass(this.banner, 'show', !!b);
    setClass(this.banner, 'go', goFlash);

    if (!this.world) this.updateStandings(p);
  }

  private updateStandings(p: Racer): void {
    const arr = this.race.sorted;
    const show: (Racer | null)[] = [];
    const maxRows = 10;
    if (arr.length <= maxRows) show.push(...arr);
    else {
      show.push(...arr.slice(0, 5));
      const pi = arr.indexOf(p);
      if (pi >= 5) {
        if (pi > 5) show.push(null);
        for (let i = Math.max(5, pi - 1); i <= Math.min(arr.length - 1, pi + 1); i++) show.push(arr[i]);
      } else show.push(...arr.slice(5, 8));
    }
    while (this.rowCache.length < show.length) {
      const r = el('div', { class: 'srow' }, el('b'), el('span', { class: 'code' }), el('span', { class: 'gap' }));
      this.rowCache.push(r);
      this.standings.append(r);
    }
    this.rowCache.forEach((r, i) => {
      const x = show[i];
      r.style.display = i < show.length ? '' : 'none';
      if (i >= show.length) return;
      if (!x) { setText(r.children[0] as HTMLElement, ''); setText(r.children[1] as HTMLElement, '…'); setText(r.children[2] as HTMLElement, ''); r.style.removeProperty('--team'); setClass(r, 'me', false); return; }
      setText(r.children[0] as HTMLElement, String(x.pos));
      setText(r.children[1] as HTMLElement, x.isPlayer ? t('hud.you') : x.code);
      const lapsBehind = Math.floor((arr[0].prog - x.prog) / this.race.track.length + 0.0);
      const gap = x.pos === 1 ? t('hud.leader') : lapsBehind >= 1 && !x.finished ? `+${lapsBehind} ${lapsBehind === 1 ? 'kolo' : 'kolá'}` : `+${x.gapLeader.toFixed(1)}`;
      setText(r.children[2] as HTMLElement, x.pit.phase !== 'none' ? 'BOX' : gap);
      r.style.setProperty('--team', x.color);
      setClass(r, 'me', x.isPlayer);
    });
  }

  private drawGauge(p: Racer): void {
    const g = this.gauge.getContext('2d')!;
    const dpr = DPR();
    const S = 260;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, S, S);
    if (this.gaugeBase) g.drawImage(this.gaugeBase, 0, 0, S, S);
    const st = p.st, cx = S / 2, cy = S / 2, R = 120;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const kph = Math.abs(st.vx) * 3.6;
    const frac = clamp(kph / this.maxKph, 0, 1);
    // oblúk rýchlosti
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 7;
    g.beginPath(); g.arc(cx, cy, R - 44, a0, a1); g.stroke();
    // ot/min – segmentový oblúk
    const rf = clamp(st.rpm / p.spec.redline, 0, 1);
    const grad = g.createLinearGradient(cx - R, cy, cx + R, cy);
    grad.addColorStop(0, '#3ddc84'); grad.addColorStop(0.65, '#ffd23e'); grad.addColorStop(1, '#ff3b3b');
    g.strokeStyle = grad; g.lineWidth = 7;
    g.beginPath(); g.arc(cx, cy, R - 44, a0, a0 + (a1 - a0) * rf); g.stroke();
    if (rf > 0.94) { g.strokeStyle = 'rgba(255,60,60,0.9)'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, R - 52, a0 + (a1 - a0) * 0.94, a1); g.stroke(); }
    // ručička
    const a = a0 + (a1 - a0) * frac;
    g.save();
    g.translate(cx, cy); g.rotate(a);
    g.fillStyle = '#ff4b2b';
    g.beginPath(); g.moveTo(R - 6, 0); g.lineTo(R - 34, -3.2); g.lineTo(-14, -2); g.lineTo(-14, 2); g.lineTo(R - 34, 3.2); g.closePath(); g.fill();
    g.restore();
    g.fillStyle = '#0b0d11'; g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill(); g.stroke();
    // digitálna rýchlosť + stupeň
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.font = '700 44px "Barlow Condensed", sans-serif';
    g.fillText(String(Math.round(kph)), cx, cy + 36);
    const gear = st.gear === -1 ? t('hud.gear.R') : this.race.phase !== 'racing' && kph < 1 ? t('hud.gear.N') : String(st.gear);
    g.fillStyle = st.limiter ? '#ffa52e' : '#ffd23e';
    g.font = '700 54px "Barlow Condensed", sans-serif';
    g.fillText(gear, cx, cy - 36);
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '600 11px "Barlow Condensed", sans-serif';
    g.fillText(`${Math.round(st.rpm / 100) * 100} ${t('hud.rpm')}`, cx, cy + 76);
    if (st.limiter) { g.fillStyle = '#ffa52e'; g.font = '700 12px "Barlow Condensed", sans-serif'; g.fillText(t('hud.pitLimiter'), cx, cy + 92); }
  }

  private drawMini(): void {
    if (this.world) { this.drawMiniWorld(); return; }
    const g = this.mini.getContext('2d')!;
    g.clearRect(0, 0, this.mini.width, this.mini.height);
    if (this.miniBase) g.drawImage(this.miniBase, 0, 0);
    const { s, ox, oy } = this.miniTf;
    const race = this.race;
    for (const r of race.racers) {
      if (r.isPlayer || r.hidden) continue;
      g.fillStyle = r.color;
      g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 1.2;
      g.beginPath(); g.arc(r.st.x * s + ox, -r.st.y * s + oy, 3.4, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    const p = race.player;
    const px = p.st.x * s + ox, py = -p.st.y * s + oy;
    g.save();
    g.translate(px, py); g.rotate(-p.st.heading);
    g.fillStyle = '#ffffff'; g.strokeStyle = '#000'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(8, 0); g.lineTo(-5, 5); g.lineTo(-2.5, 0); g.lineTo(-5, -5); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  /** Otvorený svet: minimapa so stredom na hráčovi (sever hore), kreslená z blízkych bodov cesty. */
  private drawMiniWorld(): void {
    const g = this.mini.getContext('2d')!;
    const W = this.mini.width, H = this.mini.height;
    g.clearRect(0, 0, W, H);
    const race = this.race;
    const d = race.track.d;
    const p = race.player;
    const scale = 0.16; // px / m  → ~±690 m
    const cx = W / 2, cy = H / 2;
    const tx = (x: number) => (x - p.st.x) * scale + cx;
    const ty = (y: number) => -(y - p.st.y) * scale + cy;
    g.save();
    g.beginPath(); g.arc(cx, cy, W / 2 - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = 'rgba(14,18,24,0.55)'; g.fillRect(0, 0, W, H);
    const span = Math.ceil(750 / d.ds);
    const path = () => {
      g.beginPath();
      for (let k = -span; k <= span; k++) {
        const i = (((p.q.i + k) % d.n) + d.n) % d.n;
        const px = tx(d.x[i]), py = ty(d.y[i]);
        if (k === -span) g.moveTo(px, py); else g.lineTo(px, py);
      }
    };
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 8; path(); g.stroke();
    g.strokeStyle = '#d9dde3'; g.lineWidth = 4.5; path(); g.stroke();
    g.strokeStyle = '#3a3f48'; g.lineWidth = 2.6; path(); g.stroke();
    // výzvy: začiatok úseku
    for (const c of race.challenges ?? []) {
      if (c.state === 'done') continue;
      const q = race.track.at(c.from, 0);
      g.fillStyle = c.state === 'active' ? '#3ddc84' : '#ffd23e';
      g.beginPath(); g.arc(tx(q.x), ty(q.y), 4.2, 0, Math.PI * 2); g.fill();
    }
    for (const r of race.racers) {
      if (r.isPlayer) continue;
      g.fillStyle = '#9aa3b2'; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 1.1;
      g.beginPath(); g.arc(tx(r.st.x), ty(r.st.y), 3, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.translate(cx, cy); g.rotate(-p.st.heading);
    g.fillStyle = '#ffffff'; g.strokeStyle = '#000'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(8, 0); g.lineTo(-5, 5); g.lineTo(-2.5, 0); g.lineTo(-5, -5); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  /** Otvorený svet: namiesto kôl ukáže najbližšiu / aktívnu výzvu a počet splnených. */
  private updateWorldInfo(): void {
    const race = this.race;
    const list = race.challenges ?? [];
    const tr = race.track;
    const done = list.filter((c) => c.state === 'done').length;
    const act = race.active ?? null;
    const label = (k: string) => t('world.kind.' + k);
    if (act) {
      setText(this.lapEl, `${t('world.active')}: ${label(act.kind)}`);
      if (act.kind === 'speedtrap') setText(this.timeEl, `${Math.round((act.result ?? 0) * 3.6)} / ${Math.round(act.target * 3.6)} ${t('hud.kph')}`);
      else if (act.kind === 'sprint') setText(this.timeEl, `${fmtTime(race.time - act.t0)} / ${fmtTime(act.target)}`);
      else setText(this.timeEl, `${fmtTime(race.time - act.t0)} · ${t('world.noHit')}`);
    } else {
      let best: { c: (typeof list)[number]; dist: number } | null = null;
      for (const c of list) {
        if (c.state === 'done') continue;
        const dist = tr.wrapS(c.from - race.player.q.s);
        if (!best || dist < best.dist) best = { c, dist };
      }
      if (best) {
        setText(this.lapEl, `${t('world.next')}: ${label(best.c.kind)}`);
        setText(this.timeEl, `${(best.dist / 1000).toFixed(1)} km`);
      } else {
        setText(this.lapEl, t('world.allDone'));
        setText(this.timeEl, '');
      }
    }
    setText(this.bestEl, `${t('world.done')} ${done}/${list.length}`);
  }

  dispose(): void { this.root.remove(); }
}
