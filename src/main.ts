import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import './styles.css';

import { t } from './i18n';
import { loadSettings, saveSettings, type Settings } from './settings';
import { InputManager } from './input/input';
import { Track } from './sim/track';
import { Race, type RaceConfig } from './sim/race';
import { WorldSim, type WorldEvent } from './sim/world';
import { MAX_LEVEL, emptyUpgrades } from './career/rules';
import { teamOf } from './career/career';
import { RaceView } from './render/scene';
import { Hud } from './ui/hud';
import { Coach } from './ui/coach';
import { EngineAudio } from './audio';
import { TRACK_BY_ID } from './data/catalog';
import { OnlineSession } from './net/sync';
import type { S2C } from './net/protocol';
import { OnlineFlow, RaceChat, onlineResultsScreen } from './ui/online';
import { enduranceSetupScreen, mainMenu, pauseScreen, resultsScreen, settingsScreen, setupScreen, worldSetupScreen, type Screen } from './ui/screens';
import { el } from './ui/dom';
import { CareerFlow, outcomeBlock } from './ui/career';
import { CareerStore } from './career/store';
import { applyStandaloneEndurance, enduranceConfig, forfeit, raceConfig } from './career/career';
import type { CareerEvent, RaceOutcome, ResultRow } from './career/types';

type Mode = 'menu' | 'loading' | 'race' | 'pause';

class App {
  settings = loadSettings();
  input = new InputManager(() => this.settings);
  audio = new EngineAudio();
  private ui = document.getElementById('ui')!;
  private stage = document.getElementById('stage')!;
  private hudLayer = document.getElementById('hud-layer')!;
  private toastEl = document.getElementById('toast')!;
  private screen: Screen | null = null;
  private mode: Mode = 'menu';

  race: Race | null = null;
  /** Otvorený svet (namiesto `race`). */
  world: WorldSim | null = null;
  /** Kariéra, do ktorej sa pripisujú odmeny z výziev (null = voľná jazda). */
  private worldCareer: boolean = false;
  view: RaceView | null = null;
  private hud: Hud | null = null;
  private coach = new Coach();
  private canvas: HTMLCanvasElement | null = null;
  private last = performance.now();
  private resultsAt: number | null = null;
  private resultsShown: 'none' | 'partial' | 'computing' | 'final' = 'none';
  private toastT = 0;
  private lastCfg: RaceConfig | null = null;
  private frameId = 0;
  readonly careerStore = new CareerStore();
  readonly career = new CareerFlow({
    store: this.careerStore, settings: this.settings,
    setScreen: (s) => this.setScreen(s),
    toMainMenu: () => this.showMenu(),
    startEvent: (c, ev) => {
      // Spustené preteky sa zapíšu hneď: zatvorenie hry uprostred pretekov sa neskôr počíta ako odstúpenie.
      c.pending = ev;
      this.careerStore.save(c);
      void this.startRace(raceConfig(c, ev), ev);
    },
    startWorld: (c) => this.setScreen(worldSetupScreen(this.settings,
      { onBack: () => { this.persist(); this.career.openHub(); }, onStart: () => { this.persist(); this.startWorld(c); } }, t('world.careerNote'))),
  });
  /** Online lobby (pripojenie, miestnosti); drží sieťového klienta. */
  readonly online: OnlineFlow = new OnlineFlow({
    settings: this.settings,
    persist: () => this.persist(),
    setScreen: (s) => this.setScreen(s),
    toMainMenu: () => this.showMenu(),
    startOnline: (m) => void this.startOnlineRace(m),
    abortOnline: () => { this.teardownRace(); this.mode = 'menu'; },
    toast: (m) => this.toast(m),
  });
  /** Prebiehajúce online preteky (null = offline). */
  private session: OnlineSession | null = null;
  private raceChat: RaceChat | null = null;
  private waitEl: HTMLElement | null = null;
  /** Online: otvorená pauza/menu (preteky bežia ďalej, auto je bez vstupu). */
  private onlineMenu = false;
  private onlineResultsAt = 0;
  /** Prebiehajúce kariérne preteky (null = mimo kariéry). */
  private careerEv: CareerEvent | null = null;
  private careerOutcome: RaceOutcome | null = null;
  /** Odmena zo samostatnej 24-hodinovky (do najnovšej kariéry). */
  private standaloneOutcome: RaceOutcome | null = null;

  constructor() {
    this.input.events.any = () => this.audio.unlock();
    this.input.events.camera = () => this.toggleCamera();
    this.input.events.reset = () => {
      if (this.mode !== 'race') return;
      const s = this.world ?? this.race;
      if (s) s.resetToTrack(s.player);
    };
    this.input.events.pause = () => this.togglePause();
    this.input.events.minimap = () => { if (this.mode === 'race') { this.settings.minimap = !this.settings.minimap; this.persist(); } };
    addEventListener('resize', () => this.view?.resize());
    addEventListener('pointerdown', () => this.audio.unlock());
    addEventListener('beforeunload', () => saveSettings(this.settings));
    this.showMenu();
    this.frameId = requestAnimationFrame(this.frame);
  }

  persist(): void { saveSettings(this.settings); }

  // ---------------------------------------------------------------- obrazovky
  private setScreen(s: Screen | null): void {
    this.screen?.dispose?.();
    this.screen = s;
    this.ui.replaceChildren(...(s ? [s.el] : []));
    this.ui.classList.toggle('active', !!s);
  }

  showMenu(): void {
    this.teardownRace();
    this.mode = 'menu';
    this.careerEv = null; this.careerOutcome = null;
    this.setScreen(mainMenu({ onCircuit: () => this.showSetup(), onCareer: () => this.career.openMenu(), onWorld: () => this.showWorldSetup(), onEndurance: () => this.showEnduranceSetup(), onOnline: () => this.online.open(), onSettings: () => this.showSettings(() => this.showMenu()) }));
  }

  showSetup(): void {
    this.setScreen(setupScreen(this.settings, { onBack: () => { this.persist(); this.showMenu(); }, onStart: () => { this.persist(); void this.startRace(); } }));
  }

  showWorldSetup(): void {
    this.worldCareer = false;
    this.setScreen(worldSetupScreen(this.settings, { onBack: () => { this.persist(); this.showMenu(); }, onStart: () => { this.persist(); this.startWorld(null); } }, null));
  }

  showEnduranceSetup(): void {
    this.setScreen(enduranceSetupScreen(this.settings, { onBack: () => { this.persist(); this.showMenu(); }, onStart: () => { this.persist(); void this.startRace(this.buildEnduranceConfig()); } }));
  }

  buildEnduranceConfig(): RaceConfig {
    const e = this.settings.endurance;
    return enduranceConfig({
      trackId: e.trackId, laps: 0, playerTeamId: e.teamId, playerName: this.settings.name, opponents: 29, difficulty: e.difficulty,
      weather: e.weather, gridPos: 1 + Math.floor(Math.random() * 6), consumption: 2.5, seed: (Math.random() * 1e6) | 0,
    });
  }

  showSettings(back: () => void): void {
    this.setScreen(settingsScreen(this.settings, this.input, {
      onChange: () => this.persist(),
      onClose: () => { this.persist(); back(); },
    }));
  }

  // ---------------------------------------------------------------- preteky
  private buildConfig(): RaceConfig {
    const su = this.settings.setup;
    return {
      trackId: su.trackId, laps: su.laps, playerTeamId: su.teamId, playerName: this.settings.name,
      opponents: su.opponents, difficulty: su.difficulty, weather: su.weather, gridPos: su.gridPos,
      consumption: su.consumption, seed: (Math.random() * 1e6) | 0,
    };
  }

  async startRace(cfg: RaceConfig = this.buildConfig(), careerEv: CareerEvent | null = null): Promise<void> {
    this.teardownRace();
    this.careerEv = careerEv; this.careerOutcome = null; this.standaloneOutcome = null;
    this.mode = 'loading';
    this.lastCfg = cfg;
    const info = TRACK_BY_ID[cfg.trackId];
    this.setScreen({ el: el('div', { class: 'screen loading' }, el('div', { class: 'spinner' }), el('p', null, t('loading.track', { name: info?.name ?? cfg.trackId }))) });
    let track: Track;
    try { track = await Track.load(cfg.trackId); } catch (e) {
      console.error(e);
      this.setScreen({ el: el('div', { class: 'screen loading' }, el('p', null, t('setup.error')), el('button', { class: 'btn primary', onclick: () => this.leaveToHub() }, t('menu.back'))) });
      return;
    }
    await new Promise((r) => setTimeout(r, 30));
    const race = new Race(cfg, track);
    this.race = race;
    this.canvas = el('canvas', { id: 'view' });
    this.stage.append(this.canvas);
    try {
      this.view = new RaceView(this.canvas, race);
    } catch (e) {
      console.error(e);
      this.canvas.remove();
      this.race = null;
      this.setScreen({ el: el('div', { class: 'screen loading' }, el('p', null, t('error.webgl')), el('button', { class: 'btn primary', onclick: () => this.showMenu() }, t('menu.back'))) });
      return;
    }
    this.view.cameraMode = this.settings.camera;
    this.hud = new Hud(race, () => this.settings);
    this.hudLayer.append(this.hud.root);
    this.coach = new Coach();
    this.resultsAt = null;
    this.resultsShown = 'none';
    this.mode = 'race';
    this.setScreen(null);
    this.last = performance.now();
  }

  /** Otvorený svet: bez štartu, kôl a cieľa. S kariérou (`c`) hrá s jej autom a odmeny z výziev idú do nej. */
  startWorld(c: import('./career/types').Career | null): void {
    this.teardownRace();
    this.careerEv = null; this.careerOutcome = null;
    const w = this.settings.world;
    const team = c ? teamOf(c) : null;
    let world: WorldSim;
    try {
      world = new WorldSim({
        worldId: w.worldId, traffic: w.traffic, trafficCount: w.trafficCount,
        playerTeamId: c ? c.teamId : w.teamId, playerName: c ? (c.profile.nickname || c.profile.name) : this.settings.name,
        weather: w.weather, seed: (Math.random() * 1e6) | 0,
        playerTier: team?.tier, upgrades: c ? (c.upgrades[c.teamId] ?? emptyUpgrades()) : undefined,
      });
    } catch (e) {
      console.error(e);
      this.setScreen({ el: el('div', { class: 'screen loading' }, el('p', null, t('setup.error')), el('button', { class: 'btn primary', onclick: () => this.leaveWorld() }, t('menu.back'))) });
      return;
    }
    this.worldCareer = !!c;
    this.world = world;
    this.canvas = el('canvas', { id: 'view' });
    this.stage.append(this.canvas);
    try {
      this.view = new RaceView(this.canvas, world);
    } catch (e) {
      console.error(e);
      this.canvas.remove();
      this.world = null;
      this.setScreen({ el: el('div', { class: 'screen loading' }, el('p', null, t('error.webgl')), el('button', { class: 'btn primary', onclick: () => this.showMenu() }, t('menu.back'))) });
      return;
    }
    this.view.cameraMode = this.settings.camera;
    this.hud = new Hud(world, () => this.settings);
    this.hudLayer.append(this.hud.root);
    this.coach = new Coach();
    this.resultsAt = null; this.resultsShown = 'none';
    this.mode = 'race';
    this.setScreen(null);
    this.last = performance.now();
  }

  /** Online: server spustil preteky → načítaj trať, postav `Race` s cudzími autami a ohlás `loaded`. */
  private async startOnlineRace(msg: Extract<S2C, { t: 'start' }>): Promise<void> {
    const net = this.online.net;
    const selfId = net.id;
    if (!selfId) return;
    this.teardownRace();
    this.careerEv = null; this.careerOutcome = null; this.standaloneOutcome = null;
    this.mode = 'loading';
    const s = msg.settings;
    const me = msg.grid.find((g) => g.id === selfId);
    const failLoad = (key: string) => {
      net.send({ t: 'leave' });
      this.teardownRace();
      this.mode = 'menu';
      this.toast(t(key));
      this.online.backFromRace();
    };
    this.setScreen({ el: el('div', { class: 'screen loading' }, el('div', { class: 'spinner' }), el('p', null, t('net.loading'))) });
    let track: Track;
    try { track = await Track.load(s.trackId); } catch (e) { console.error(e); failLoad('setup.error'); return; }
    const cfg: RaceConfig = {
      trackId: s.trackId, laps: s.laps, playerTeamId: me?.teamId ?? s.cls, playerName: this.settings.name,
      opponents: 0, difficulty: 'medium', weather: s.weather, gridPos: 1, consumption: 1.5, seed: msg.seed,
      online: { selfId, grid: msg.grid },
    };
    const race = new Race(cfg, track);
    this.race = race;
    this.lastCfg = cfg;
    this.canvas = el('canvas', { id: 'view' });
    this.stage.append(this.canvas);
    try { this.view = new RaceView(this.canvas, race); } catch (e) {
      console.error(e);
      this.canvas.remove(); this.race = null;
      failLoad('error.webgl');
      return;
    }
    this.view.cameraMode = this.settings.camera;
    this.hud = new Hud(race, () => this.settings);
    this.hudLayer.append(this.hud.root);
    this.coach = new Coach();
    this.session = new OnlineSession(net, race, selfId);
    this.raceChat = new RaceChat(net);
    this.hudLayer.append(this.raceChat.root);
    this.waitEl = el('div', { class: 'netwait show' }, t('net.wait.others'));
    this.hudLayer.append(this.waitEl);
    this.resultsAt = null; this.resultsShown = 'none'; this.onlineMenu = false; this.onlineResultsAt = 0;
    this.mode = 'race';
    this.setScreen(null);
    this.last = performance.now();
    net.send({ t: 'loaded' });
  }

  private showOnlineResults(): void {
    const sess = this.session, race = this.race;
    if (!sess || !race) return;
    this.resultsShown = sess.results ? 'final' : 'partial';
    const list = sess.results ?? (sess.standings.length ? sess.standings : []);
    this.setScreen(onlineResultsScreen(list, sess.selfId, race.cfg.laps, !!sess.results, {
      onBack: () => { this.teardownRace(); this.mode = 'menu'; this.online.backFromRace(); },
      onLeave: () => { this.teardownRace(); this.mode = 'menu'; this.online.quitRace(); },
    }));
  }

  private showOnlinePause(): void {
    this.onlineMenu = true;
    this.setScreen(pauseScreen({
      onResume: () => { this.onlineMenu = false; this.setScreen(null); },
      onSettings: () => this.showSettings(() => this.showOnlinePause()),
      onQuit: () => {
        if (!confirm(t('net.quitConfirm'))) return;
        this.teardownRace(); this.mode = 'menu';
        this.online.quitRace();
      },
      quitLabel: t('net.pause.quit'),
    }));
  }

  private leaveWorld(): void {
    const career = this.worldCareer && this.career.c;
    this.teardownRace(); this.mode = 'menu';
    if (career) { this.worldCareer = false; this.career.openHub(); } else this.showMenu();
  }

  private handleWorldEvents(world: WorldSim): void {
    const evs = world.worldEvents.splice(0);
    for (const e of evs) this.worldToast(e);
  }

  private worldToast(e: WorldEvent): void {
    if (e.type === 'service') { this.toast(t('world.toast.service')); return; }
    const c = e.challenge;
    if (!c) return;
    const kind = t('world.kind.' + c.kind);
    if (e.type === 'start') {
      const desc = t('world.desc.' + c.kind, { len: Math.round(c.len), time: c.target, kph: Math.round(c.target * 3.6) });
      this.toast(t('world.toast.start', { kind, desc }));
    } else if (e.type === 'failed') this.toast(t('world.toast.failed', { kind }));
    else {
      const cr = this.worldCareer ? this.career.c : null;
      if (cr) {
        cr.level = Math.min(MAX_LEVEL, cr.level + c.reward.level);
        cr.coins += c.reward.coins;
        this.careerStore.save(cr);
        this.toast(t('world.toast.done', { kind, level: c.reward.level, coins: c.reward.coins }));
      } else this.toast(t('world.toast.doneFree', { kind }));
    }
  }

  /** Návrat zo záťažovej obrazovky: do kariérneho centra, ak práve beží kariéra, inak do nastavenia. */
  private leaveToHub(): void {
    if (this.careerEv && this.career.c) {
      const out = forfeit(this.career.c, this.careerEv);
      this.careerStore.save(this.career.c);
      this.teardownRace(); this.mode = 'menu'; this.careerEv = null;
      this.career.openHub(out);
    } else this.showSetup();
  }

  private teardownRace(): void {
    this.view?.dispose();
    this.canvas?.remove();
    this.hud?.dispose();
    this.audio.silence();
    this.view = null; this.canvas = null; this.hud = null; this.race = null; this.world = null;
    this.session?.dispose(); this.session = null;
    this.raceChat?.dispose(); this.raceChat = null;
    this.waitEl?.remove(); this.waitEl = null;
    this.onlineMenu = false;
  }

  private toggleCamera(): void {
    if (this.mode !== 'race' || !this.view) return;
    const m = this.view.toggleCamera();
    this.settings.camera = m;
    this.toast(t(m === 'cockpit' ? 'hud.cam.cockpit' : 'hud.cam.chase'));
    this.persist();
  }

  private togglePause(): void {
    if (this.session) {
      if (this.mode !== 'race' || this.resultsShown !== 'none') return;
      if (this.onlineMenu) { this.onlineMenu = false; this.setScreen(null); } else this.showOnlinePause();
      return;
    }
    if (this.mode === 'race' && (this.race || this.world) && this.resultsShown === 'none') {
      this.mode = 'pause';
      this.audio.silence();
      this.showPause();
    } else if (this.mode === 'pause') this.resume();
  }

  private showPause(): void {
    if (this.world) {
      this.setScreen(pauseScreen({
        onResume: () => this.resume(),
        onSettings: () => this.showSettings(() => this.showPause()),
        onQuit: () => this.leaveWorld(),
        quitLabel: t('world.pause.quit'),
      }));
      return;
    }
    this.setScreen(pauseScreen({
      onResume: () => this.resume(),
      onRestart: this.careerEv ? undefined : () => { if (this.lastCfg) void this.startRace({ ...this.lastCfg, seed: (Math.random() * 1e6) | 0 }); },
      onSettings: () => this.showSettings(() => this.showPause()),
      onQuit: () => { if (this.careerEv) this.quitCareerRace(); else this.showMenu(); },
      quitLabel: this.careerEv ? t('pause.career') : undefined,
    }));
  }

  /** Odchod z kariérnych pretekov = odstúpenie (posledné miesto, bez bodov). */
  private quitCareerRace(): void {
    const c = this.career.c, ev = this.careerEv, race = this.race;
    if (!c || !ev || !race) { this.showMenu(); return; }
    if (!confirm(t('career.quitConfirm'))) return;
    const out = forfeit(c, ev, this.resultRows(race));
    this.careerStore.save(c);
    this.teardownRace(); this.mode = 'menu'; this.careerEv = null;
    this.career.openHub(out);
  }

  private resultRows(race: Race): ResultRow[] {
    // zmiešané pole: do kariéry ide len poradie v triede hráča
    const list = race.classification().filter((r) => !race.cfg.mixed || r.cls === race.player.cls);
    return list.map((r, i) => ({ id: r.isPlayer ? 'player' : r.id, name: r.name, team: r.teamName, color: r.color, pos: i + 1, isPlayer: r.isPlayer }));
  }

  private resume(): void {
    this.mode = 'race';
    this.setScreen(null);
    this.last = performance.now();
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    this.toastT = 2.2;
  }

  // ---------------------------------------------------------------- výsledky
  private showResults(state: 'partial' | 'computing' | 'final'): void {
    const race = this.race;
    if (!race) return;
    this.resultsShown = state;
    this.mode = 'race';
    if (this.careerEv && this.career.c) {
      const ev = this.careerEv;
      // výsledok sa započíta práve raz, až keď sú dopočítané aj ostatné autá
      if (state === 'final' && !this.careerOutcome) this.careerOutcome = this.career.finishRace(ev, this.resultRows(race));
      const out = this.careerOutcome;
      this.setScreen(resultsScreen(race, state, {
        title: t('cres.title', { kind: t('kind.' + ev.kind) }),
        extra: out ? outcomeBlock(out) : el('p', { class: 'muted' }, t('cres.waiting')),
        menuLabel: t('cres.continue'), hideSkip: true,
        onMenu: () => { this.teardownRace(); this.mode = 'menu'; this.careerEv = null; this.career.openHub(); },
        onSkip: () => undefined,
      }));
      return;
    }
    let extra: Node | null = null;
    if (race.cfg.durationS != null && state === 'final') {
      if (!this.standaloneOutcome) this.standaloneOutcome = this.rewardStandalone(race);
      extra = this.standaloneOutcome ? outcomeBlock(this.standaloneOutcome) : el('p', { class: 'muted' }, t('endurance.noCareer'));
    }
    this.setScreen(resultsScreen(race, state, {
      extra,
      onAgain: () => { if (this.lastCfg) void this.startRace({ ...this.lastCfg, seed: (Math.random() * 1e6) | 0 }); },
      onMenu: () => this.showMenu(),
      onSkip: () => { this.showResults('computing'); },
    }));
  }

  /** Samostatná 24-hodinovka: menšia odmena do najnovšie hranej kariéry (ak nejaká existuje). */
  private rewardStandalone(race: Race): RaceOutcome | null {
    const meta = this.careerStore.list()[0];
    const c = meta ? this.careerStore.load(meta.id) : null;
    if (!c || c.pending) return null;
    const out = applyStandaloneEndurance(c, this.resultRows(race));
    this.careerStore.save(c);
    return out;
  }

  private computeRest(): void {
    const race = this.race;
    if (!race) return;
    const t0 = performance.now();
    const limit = (race.playerFinishedAt ?? race.time) + 900;
    while (performance.now() - t0 < 10 && !race.allFinished && race.time < limit) race.advance(200 / 240, 200);
    if (race.allFinished || race.time >= limit) this.showResults('final');
  }

  // ---------------------------------------------------------------- hlavná slučka
  private frame = (now: number): void => {
    this.frameId = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.toastEl.classList.remove('show'); }

    const world = this.world;
    if (world && this.view && this.hud) {
      const view = this.view, hud = this.hud;
      if (this.mode === 'race') {
        const p = world.player;
        world.playerInput = this.input.poll(dt, Math.abs(p.st.vx));
        world.assists = { abs: this.settings.abs, tc: this.settings.tc, steer: this.settings.steerAssist, autoGear: this.settings.autoGear };
        world.advance(dt);
        this.handleEvents(world);
        this.handleWorldEvents(world);
        const key = this.coach.update(world, dt);
        hud.update(dt, key, view.cameraMode);
        this.audio.update(p.st.rpm, p.spec.redline, p.st.throttle, Math.abs(p.st.vx), p.st.skid, this.settings.volume, true);
      } else if (this.mode === 'pause') this.input.poll(dt, 0);
      view.render(this.mode === 'race' ? dt : 0, world.player);
      return;
    }

    const race = this.race, view = this.view, hud = this.hud;
    if (!race || !view || !hud) { this.input.poll(dt, 0); return; }

    if (this.mode === 'race') {
      if (this.resultsShown === 'computing') this.computeRest();
      else {
        const p = race.player;
        const sess = this.session;
        let inp = this.input.poll(dt, Math.abs(p.st.vx));
        // online: pri otvorenom menu / písaní správy auto nedostáva vstup (preteky bežia ďalej)
        if (sess && (this.onlineMenu || this.raceChat?.root.classList.contains('typing'))) inp = { ...inp, steer: 0, throttle: 0, brake: 0.3, shiftUp: false, shiftDown: false };
        race.playerInput = inp;
        race.assists = { abs: this.settings.abs, tc: this.settings.tc, steer: this.settings.steerAssist, autoGear: this.settings.autoGear };
        race.advance(dt);
        if (sess) {
          sess.update(dt);
          this.raceChat?.update();
          this.waitEl?.classList.toggle('show', race.gate);
        }
        this.handleEvents(race);
        const key = this.coach.update(race, dt);
        hud.update(dt, key, view.cameraMode);
        this.audio.update(p.st.rpm, p.spec.redline, p.st.throttle, Math.abs(p.st.vx), p.st.skid, this.settings.volume, race.phase !== 'grid');

        if (sess) {
          if (p.finished && this.resultsAt == null) this.resultsAt = now + 4500;
          const due = this.resultsAt != null && now > this.resultsAt;
          if (due && !this.onlineMenu) {
            // živé poradie sa obnovuje raz za sekundu, po `results` od servera sa zobrazí konečné
            if (this.resultsShown === 'none' || (this.resultsShown === 'partial' && (sess.results || now - this.onlineResultsAt > 1000))) {
              this.onlineResultsAt = now;
              this.showOnlineResults();
            }
          }
        } else {
          if (p.finished && this.resultsAt == null) this.resultsAt = now + 4500;
          if (this.resultsAt != null && this.resultsShown === 'none' && now > this.resultsAt) this.showResults(this.careerEv ? 'computing' : race.allFinished ? 'final' : 'partial');
          if (this.resultsShown === 'partial' && race.allFinished) this.showResults('final');
        }
      }
    } else if (this.mode === 'pause') this.input.poll(dt, 0);
    view.render(this.mode === 'race' ? dt : 0, race.player);
  };

  private handleEvents(race: Race | WorldSim): void {
    for (const e of race.events) {
      if (e.racer?.isPlayer) {
        if (e.type === 'bestLap') this.toast(t('msg.newBest'));
        else if (e.type === 'reset') this.toast(t('msg.reset'));
        else if (e.type === 'pitDone') this.toast(t('msg.fresh'));
      }
    }
    race.events.length = 0;
  }

  /** Pomocník pre testy v prehliadači (screenshoty). */
  debugState(): unknown { return { mode: this.mode, frame: this.frameId }; }
}

const app = new App();
(window as unknown as { __rh: unknown }).__rh = {
  app,
  get race() { return app.race; },
  get view() { return app.view; },
  get world() { return app.world; },
  career: app.career,
};

// Rýchly štart pre ladenie: ?quick=<trať>&weather=rain&cam=cockpit&team=ferrari&cls=GT&laps=2&opp=11
const q = new URLSearchParams(location.search);
if (q.has('quick')) {
  const su: Settings['setup'] = app.settings.setup;
  su.trackId = q.get('quick') || su.trackId;
  if (q.has('weather')) su.weather = q.get('weather') as typeof su.weather;
  if (q.has('cls')) su.cls = q.get('cls') as typeof su.cls;
  if (q.has('team')) su.teamId = q.get('team')!;
  if (q.has('laps')) su.laps = Number(q.get('laps'));
  if (q.has('opp')) su.opponents = Number(q.get('opp'));
  if (q.has('grid')) su.gridPos = Number(q.get('grid'));
  if (q.has('cam')) app.settings.camera = q.get('cam') as Settings['camera'];
  // auto=1: hráča vedie autopilot (ladenie / screenshoty)
  void app.startRace().then(() => { if (q.get('auto') === '1') app.race?.setPlayerAuto(true); });
}

// Otvorený svet: ?world=world-coast|world-hills&traffic=1&n=14&weather=dry&auto=1
if (q.has('world')) {
  const w = app.settings.world;
  w.worldId = q.get('world') || w.worldId;
  if (q.has('traffic')) w.traffic = q.get('traffic') === '1';
  if (q.has('n')) w.trafficCount = Number(q.get('n'));
  if (q.has('weather')) w.weather = q.get('weather') as typeof w.weather;
  if (q.has('team')) w.teamId = q.get('team')!;
  if (q.has('cls')) w.cls = q.get('cls') as typeof w.cls;
  if (q.has('cam')) app.settings.camera = q.get('cam') as Settings['camera'];
  app.startWorld(null);
  if (q.get('auto') === '1') app.world?.setPlayerAuto(true);
}

// 24-hodinovka: ?endurance=<trať>&weather=dry&cls=GT&team=gt-porsche&dur=<sekundy>&auto=1
if (q.has('endurance')) {
  const e = app.settings.endurance;
  e.trackId = q.get('endurance') || e.trackId;
  if (q.has('weather')) e.weather = q.get('weather') as typeof e.weather;
  if (q.has('cls')) e.cls = q.get('cls') as typeof e.cls;
  if (q.has('team')) e.teamId = q.get('team')!;
  if (q.has('cam')) app.settings.camera = q.get('cam') as Settings['camera'];
  const cfg = app.buildEnduranceConfig();
  if (q.has('dur')) cfg.durationS = Number(q.get('dur'));
  void app.startRace(cfg).then(() => { if (q.get('auto') === '1') app.race?.setPlayerAuto(true); });
}
