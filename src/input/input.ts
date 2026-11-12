import { clamp } from '../sim/math';
import type { PlayerInput } from '../sim/race';
import type { AxisMap, Settings } from '../settings';

export type LearnTarget = 'steer' | 'throttle' | 'brake' | 'up' | 'down';

export interface InputEvents {
  camera?: () => void;
  pause?: () => void;
  reset?: () => void;
  minimap?: () => void;
  /** Ľubovoľné stlačenie (odomknutie zvuku a pod.). */
  any?: () => void;
}

/**
 * Vstup hráča: klávesnica, gamepad (štandardné mapovanie) a volant (vlastné mapovanie osí).
 * Všetko sa spracúva v `poll()` raz za snímku a vracia normalizovaný `PlayerInput`.
 */
export class InputManager {
  private keys = new Set<string>();
  private prevButtons = new Map<number, boolean[]>();
  private steerKb = 0;
  private thrKb = 0;
  private brkKb = 0;
  private pendingUp = false;
  private pendingDown = false;
  events: InputEvents = {};
  active: 'keyboard' | 'gamepad' | 'wheel' = 'keyboard';

  // učenie osí
  learn: { target: LearnTarget; base: number[]; best: { axis: number; dev: number; value: number } | null; t: number; onDone: () => void } | null = null;
  private learnBase: number[] = [];

  constructor(private settings: () => Settings) {
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.keys.clear());
  }

  private static readonly HANDLED = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'KeyC', 'KeyR', 'KeyP', 'KeyM', 'Escape',
  ]);

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (InputManager.HANDLED.has(e.code)) e.preventDefault();
    if (down) {
      if (e.repeat) return;
      this.events.any?.();
      this.keys.add(e.code);
      switch (e.code) {
        case 'ShiftLeft': case 'ShiftRight': case 'KeyE': this.pendingUp = true; break;
        case 'ControlLeft': case 'ControlRight': case 'KeyQ': this.pendingDown = true; break;
        case 'KeyC': this.events.camera?.(); break;
        case 'KeyR': this.events.reset?.(); break;
        case 'KeyP': case 'Escape': this.events.pause?.(); break;
        case 'KeyM': this.events.minimap?.(); break;
      }
    } else this.keys.delete(e.code);
  }

  private pads(): Gamepad[] {
    try {
      return Array.from(navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected);
    } catch { return []; }
  }

  /** Zoznam pripojených zariadení pre nastavenia. */
  devices(): { id: string; index: number; mapping: string; axes: number; buttons: number }[] {
    return this.pads().map((g) => ({ id: g.id, index: g.index, mapping: g.mapping, axes: g.axes.length, buttons: g.buttons.length }));
  }

  /** Aktuálne hodnoty osí zvoleného zariadenia (pre zobrazenie v nastaveniach). */
  axesOf(deviceId: string): number[] {
    const pad = this.pickPad(deviceId);
    return pad ? Array.from(pad.axes) : [];
  }

  private pickPad(deviceId: string): Gamepad | null {
    const ps = this.pads();
    if (!ps.length) return null;
    if (deviceId) { const m = ps.find((p) => p.id === deviceId); if (m) return m; }
    return ps.find((p) => p.mapping === 'standard') ?? ps[0];
  }

  startLearn(target: LearnTarget, onDone: () => void): void {
    const s = this.settings();
    const pad = this.pickPad(s.wheel.deviceId);
    this.learnBase = pad ? Array.from(pad.axes) : [];
    this.learn = { target, base: this.learnBase, best: null, t: 0, onDone };
    this.prevButtons.delete(pad?.index ?? -1);
  }
  cancelLearn(): void { this.learn = null; }

  private updateLearn(dt: number, pad: Gamepad | null): void {
    const L = this.learn;
    if (!L || !pad) return;
    const s = this.settings();
    if (L.target === 'up' || L.target === 'down') {
      const i = pad.buttons.findIndex((b) => b.pressed);
      if (i >= 0) { s.wheel[L.target] = i; s.wheel.deviceId = pad.id; this.learn = null; L.onDone(); }
      return;
    }
    let bi = -1, bd = 0;
    pad.axes.forEach((v, i) => {
      const d = Math.abs(v - (L.base[i] ?? 0));
      if (d > bd) { bd = d; bi = i; }
    });
    if (!L.best && bd > 0.4) L.best = { axis: bi, dev: bd, value: pad.axes[bi] };
    if (L.best) {
      L.t += dt;
      const v = pad.axes[L.best.axis];
      if (Math.abs(v - L.base[L.best.axis]) > Math.abs(L.best.value - L.base[L.best.axis])) L.best.value = v;
      const need = L.target === 'steer' ? 1.6 : 0.8;
      if (L.t > need) {
        const map: AxisMap = { axis: L.best.axis, rest: L.base[L.best.axis] ?? 0, full: L.best.value };
        s.wheel[L.target] = map;
        s.wheel.deviceId = pad.id;
        s.wheel.enabled = true;
        this.learn = null;
        L.onDone();
      }
    }
  }

  private norm(m: AxisMap, v: number): number {
    const span = m.full - m.rest;
    if (Math.abs(span) < 0.05) return 0;
    return (v - m.rest) / span;
  }

  poll(dt: number, speed: number): PlayerInput {
    const s = this.settings();
    const k = this.keys;
    const pad = this.pickPad(s.wheel.deviceId);
    this.updateLearn(dt, pad);

    // ---- klávesnica
    const left = k.has('ArrowLeft') || k.has('KeyA');
    const right = k.has('ArrowRight') || k.has('KeyD');
    const up = k.has('ArrowUp') || k.has('KeyW');
    const down = k.has('ArrowDown') || k.has('KeyS') || k.has('Space');
    const sens = s.steerSens;
    const target = (left ? 1 : 0) - (right ? 1 : 0);
    const rate = (target === 0 || Math.sign(target) !== Math.sign(this.steerKb) ? 6 : 2.6 + 1.6 * sens) * (1 / (1 + speed / 45)) + 1.2;
    this.steerKb += clamp(target - this.steerKb, -rate * dt, rate * dt);
    this.thrKb += clamp((up ? 1 : 0) - this.thrKb, -9 * dt, 4.5 * dt);
    this.brkKb += clamp((down ? 1 : 0) - this.brkKb, -10 * dt, 6 * dt);
    let steer = this.steerKb, thr = this.thrKb, brk = this.brkKb;
    const kbActive = left || right || up || down;

    // ---- gamepad / volant
    let padActive = false;
    if (pad) {
      const wheelOn = s.wheel.enabled && s.wheel.steer.axis >= 0;
      const prev = this.prevButtons.get(pad.index) ?? [];
      const cur = pad.buttons.map((b) => b.pressed);
      const edge = (i: number) => i >= 0 && !!cur[i] && !prev[i];
      if (wheelOn) {
        const v = (m: AxisMap) => (m.axis >= 0 && m.axis < pad.axes.length ? this.norm(m, pad.axes[m.axis]) : 0);
        const ws = v(s.wheel.steer);
        const dead = Math.abs(ws) < 0.015 ? 0 : ws;
        const wt = s.wheel.throttle.axis >= 0 ? clamp(v(s.wheel.throttle), 0, 1) : 0;
        const wb = s.wheel.brake.axis >= 0 ? clamp(v(s.wheel.brake), 0, 1) : 0;
        // volant: priame natočenie (bez kľúčovania), ľavé natočenie = kladné riadenie v simulácii
        const sv = -clamp(dead, -1, 1);
        if (Math.abs(sv) > 0.01 || wt > 0.02 || wb > 0.02) {
          steer = sv; thr = Math.max(wt, 0); brk = Math.max(wb, 0);
          padActive = true; this.active = 'wheel';
        }
        if (edge(s.wheel.up)) this.pendingUp = true;
        if (edge(s.wheel.down)) this.pendingDown = true;
        if (cur.some((b, i) => b && !prev[i])) this.events.any?.();
      } else if (pad.mapping === 'standard' || pad.axes.length >= 2) {
        const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92);
        const ax = dz(pad.axes[0] ?? 0);
        const gsteer = -Math.sign(ax) * Math.pow(Math.abs(ax), 1.35) * clamp(0.75 + 0.25 * sens, 0.5, 1.4);
        const rt = pad.buttons[7]?.value ?? 0, lt = pad.buttons[6]?.value ?? 0;
        if (Math.abs(gsteer) > 0.02 || rt > 0.04 || lt > 0.04) {
          steer = gsteer; thr = rt; brk = lt; padActive = true; this.active = 'gamepad';
        }
        if (edge(0) || edge(5)) this.pendingUp = true;
        if (edge(2) || edge(4)) this.pendingDown = true;
        if (edge(3)) this.events.camera?.();
        if (edge(9)) this.events.pause?.();
        if (edge(1)) this.events.reset?.();
        if (edge(8)) this.events.minimap?.();
        if (cur.some((b, i) => b && !prev[i])) this.events.any?.();
      }
      this.prevButtons.set(pad.index, cur);
    }
    if (!padActive && kbActive) this.active = 'keyboard';

    const out: PlayerInput = {
      steer: clamp(steer, -1, 1), throttle: clamp(thr, 0, 1), brake: clamp(brk, 0, 1),
      shiftUp: this.pendingUp, shiftDown: this.pendingDown,
    };
    this.pendingUp = false; this.pendingDown = false;
    return out;
  }
}
