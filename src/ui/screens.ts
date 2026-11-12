import { t } from '../i18n';
import { CAR_MODEL_BY_ID, GT_TEAMS, TEAMS, TRACKS, TRACK_BY_ID, TEAM_BY_ID } from '../data/catalog';
import type { Settings } from '../settings';
import type { InputManager, LearnTarget } from '../input/input';
import type { Race, Racer } from '../sim/race';
import { fmtTime } from '../sim/math';
import { el, field, segmented, slider } from './dom';
import type { Difficulty } from '../sim/ai';
import type { WeatherMode } from '../sim/weather';
import { WORLDS } from '../sim/worldMap';

export interface Screen { el: HTMLElement; dispose?: () => void }

export const panel = (cls: string, ...kids: (Node | string | null)[]): HTMLElement => el('div', { class: `screen ${cls}` }, el('div', { class: 'panel' }, ...kids));

// ------------------------------------------------------------------ hlavné menu
export function mainMenu(cb: { onCircuit: () => void; onCareer: () => void; onWorld: () => void; onEndurance: () => void; onOnline: () => void; onSettings: () => void }): Screen {
  const item = (label: string, on?: () => void, soon = false) =>
    el('button', { class: 'menu-item' + (soon ? ' soon' : ''), disabled: soon, onclick: on },
      el('span', null, label), soon ? el('small', null, t('menu.disabled')) : null);
  return {
    el: el('div', { class: 'screen menu' },
      el('div', { class: 'brand' },
        el('h1', null, 'RACE', el('em', null, 'HORIZON')),
        el('p', null, t('app.tagline'))),
      el('div', { class: 'menu-list' },
        item(t('menu.circuit'), cb.onCircuit),
        item(t('menu.career'), cb.onCareer),
        item(t('menu.openworld'), cb.onWorld),
        item(t('menu.endurance'), cb.onEndurance),
        item(t('menu.online'), cb.onOnline),
        item(t('menu.settings'), cb.onSettings)),
      el('div', { class: 'menu-foot' }, t('menu.hint'))),
  };
}

// ------------------------------------------------------------------ príprava pretekov
export function setupScreen(s: Settings, cb: { onStart: () => void; onBack: () => void }): Screen {
  const su = s.setup;
  const body = el('div', { class: 'form' });
  const info = el('div', { class: 'info' });

  const render = () => {
    const teams = su.cls === 'F1' ? TEAMS : GT_TEAMS;
    if (!teams.some((x) => x.id === su.teamId)) su.teamId = teams[0].id;
    const maxOpp = su.cls === 'F1' ? 21 : 29;
    su.opponents = Math.min(su.opponents, maxOpp);
    su.gridPos = Math.min(su.gridPos, su.opponents + 1);

    const teamSel = el('select', { onchange: (e: Event) => { su.teamId = (e.target as HTMLSelectElement).value; update(); } },
      ...teams.map((x) => el('option', { value: x.id, selected: x.id === su.teamId }, x.cls === 'F1' ? x.name : `${x.brand} – ${CAR_MODEL_BY_ID[x.car].name}`)));
    const trackSel = el('select', { onchange: (e: Event) => { su.trackId = (e.target as HTMLSelectElement).value; update(); } },
      ...TRACKS.map((x) => el('option', { value: x.id, selected: x.id === su.trackId }, x.round ? `${String(x.round).padStart(2, '0')} · ${x.name}` : `★ ${x.name}`)));

    body.replaceChildren(
      field(t('setup.class'), segmented([{ value: 'F1', label: t('cls.F1') }, { value: 'GT', label: t('cls.GT') }], su.cls, (v) => { su.cls = v; render(); })),
      field(t('setup.team'), teamSel),
      field(t('setup.track'), trackSel),
      field(t('setup.laps'), slider(1, 30, 1, su.laps, (v) => { su.laps = v; })),
      field(t('setup.opponents'), slider(1, maxOpp, 1, su.opponents, (v) => { su.opponents = v; su.gridPos = Math.min(su.gridPos, v + 1); render2(); })),
      field(t('setup.gridPos'), slider(1, su.opponents + 1, 1, su.gridPos, (v) => { su.gridPos = v; })),
      field(t('setup.difficulty'), segmented<Difficulty>(
        (['easy', 'medium', 'hard', 'expert'] as const).map((d) => ({ value: d, label: t('diff.' + d) })), su.difficulty, (v) => { su.difficulty = v; })),
      field(t('setup.weather'), segmented<WeatherMode>(
        (['dry', 'dynamic', 'rain'] as const).map((d) => ({ value: d, label: t('weather.' + d) })), su.weather, (v) => { su.weather = v; })),
      field(t('setup.consumption'), slider(1, 10, 0.5, su.consumption, (v) => { su.consumption = v; }, (v) => `×${v.toFixed(1)}`)),
    );
    update();
  };
  // pri zmene počtu súperov prekreslíme len posuvník štartovej pozície
  const render2 = () => { const keep = body.scrollTop; render(); body.scrollTop = keep; };
  const update = () => {
    const tr = TRACK_BY_ID[su.trackId];
    const team = TEAM_BY_ID[su.teamId];
    const car = team ? CAR_MODEL_BY_ID[team.car] : null;
    info.replaceChildren(
      el('div', null, el('b', null, tr.gp), ` · ${tr.country}`),
      el('div', { class: 'muted' }, tr.fictional ? t('track.fictional') : tr.placeholder ? t('track.placeholder') : ''),
      el('div', { class: 'muted' }, car ? `${car.brand} ${car.name} – ${t('car.placeholder')}` : ''),
      el('div', { class: 'muted' }, t('setup.pitHint')),
    );
  };
  render();

  return {
    el: panel('setup',
      el('h2', null, t('setup.title')),
      body, info,
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost', onclick: cb.onBack }, t('menu.back')),
        el('button', { class: 'btn primary', onclick: cb.onStart }, t('menu.start')))),
  };
}

// ------------------------------------------------------------------ otvorený svet
export function worldSetupScreen(s: Settings, cb: { onStart: () => void; onBack: () => void }, careerNote: string | null): Screen {
  const w = s.world;
  const body = el('div', { class: 'form' });
  const render = () => {
    const teams = w.cls === 'F1' ? TEAMS : GT_TEAMS;
    if (!teams.some((x) => x.id === w.teamId)) w.teamId = teams[0].id;
    const teamSel = el('select', { onchange: (e: Event) => { w.teamId = (e.target as HTMLSelectElement).value; } },
      ...teams.map((x) => el('option', { value: x.id, selected: x.id === w.teamId }, x.cls === 'F1' ? x.name : `${x.brand} – ${CAR_MODEL_BY_ID[x.car].name}`)));
    const mapSel = el('select', { onchange: (e: Event) => { w.worldId = (e.target as HTMLSelectElement).value; } },
      ...WORLDS.map((x) => el('option', { value: x.id, selected: x.id === w.worldId }, x.name)));
    body.replaceChildren(
      field(t('world.map'), mapSel),
      field(t('world.traffic'), segmented<string>([{ value: 'on', label: t('world.on') }, { value: 'off', label: t('world.off') }], w.traffic ? 'on' : 'off', (v) => { w.traffic = v === 'on'; render(); })),
      ...(w.traffic ? [field(t('world.trafficCount'), slider(4, 30, 1, w.trafficCount, (v) => { w.trafficCount = v; }))] : []),
      ...(careerNote ? [] : [
        field(t('setup.class'), segmented([{ value: 'F1', label: t('cls.F1') }, { value: 'GT', label: t('cls.GT') }], w.cls, (v) => { w.cls = v; render(); })),
        field(t('setup.team'), teamSel),
      ]),
      field(t('setup.weather'), segmented<WeatherMode>(
        (['dry', 'dynamic', 'rain'] as const).map((d) => ({ value: d, label: t('weather.' + d) })), w.weather, (v) => { w.weather = v; })),
    );
  };
  render();
  return {
    el: panel('setup',
      el('h2', null, t('world.title')),
      body,
      el('div', { class: 'info' },
        el('div', { class: 'muted' }, t('world.info')),
        el('div', { class: 'muted' }, t('car.placeholder')),
        careerNote ? el('div', { class: 'muted' }, careerNote) : null),
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost', onclick: cb.onBack }, t('menu.back')),
        el('button', { class: 'btn primary', onclick: cb.onStart }, t('menu.start')))),
  };
}

// ------------------------------------------------------------------ nastavenia
export function settingsScreen(s: Settings, input: InputManager, cb: { onClose: () => void; onChange: () => void }): Screen {
  const ch = () => cb.onChange();
  const onOff = (v: boolean, on: (b: boolean) => void) => segmented([{ value: 'on', label: t('set.on') }, { value: 'off', label: t('set.off') }], v ? 'on' : 'off', (x) => { on(x === 'on'); ch(); });
  const level = (v: number, on: (n: 0 | 1 | 2) => void) => segmented<number>(
    [{ value: 0, label: t('set.off') }, { value: 1, label: t('set.low') }, { value: 2, label: t('set.high') }], v, (x) => { on(x as 0 | 1 | 2); ch(); });

  const nameInp = el('input', { type: 'text', maxlength: 18, value: s.name, oninput: () => { s.name = nameInp.value.trim() || 'Hráč'; ch(); } });
  nameInp.value = s.name;

  // ---- volant / gamepad
  const wheelBox = el('div', { class: 'wheelbox' });
  let sig = '';
  const targets: { key: LearnTarget; label: string }[] = [
    { key: 'steer', label: t('set.map.steer') }, { key: 'throttle', label: t('set.map.throttle') }, { key: 'brake', label: t('set.map.brake') },
    { key: 'up', label: t('set.map.up') }, { key: 'down', label: t('set.map.down') },
  ];
  const renderWheel = () => {
    const devs = input.devices();
    const dev = devs.find((d) => d.id === s.wheel.deviceId) ?? devs[0];
    const rows = targets.map(({ key, label }) => {
      const learning = input.learn?.target === key;
      let status: string;
      if (key === 'up' || key === 'down') status = s.wheel[key] >= 0 ? t('set.mapped', { axis: `tl. ${s.wheel[key]}` }).replace(/\(.*\)/, `(tl. ${s.wheel[key]})`) : t('set.unmapped');
      else status = s.wheel[key].axis >= 0 ? t('set.mapped', { axis: s.wheel[key].axis }) : t('set.unmapped');
      return el('div', { class: 'maprow' },
        el('span', null, label), el('small', { class: learning ? 'learning' : '' }, learning ? t('set.learning') : status),
        el('button', { class: 'btn small', disabled: !dev, onclick: () => { input.startLearn(key, () => { ch(); sig = ''; }); sig = ''; } }, t('set.learn')));
    });
    wheelBox.replaceChildren(
      el('p', { class: 'muted' }, dev ? `${t('set.wheelDetected')}: ${dev.id} (${dev.axes} os., ${dev.buttons} tl.)` : t('set.wheelNone')),
      field(t('set.wheelEnable'), onOff(s.wheel.enabled, (b) => { s.wheel.enabled = b; })),
      ...rows,
      el('div', { class: 'maprow' }, el('span', null, t('set.invert')), el('small'),
        el('button', { class: 'btn small', onclick: () => { const m = s.wheel.steer; m.full = 2 * m.rest - m.full; ch(); } }, t('set.invert'))),
      dev && s.wheel.enabled ? axesMeter(dev.id) : el('span'),
    );
  };
  const axesMeter = (id: string) => {
    const v = input.axesOf(id);
    return el('div', { class: 'axes' }, ...v.slice(0, 8).map((a, i) => el('div', { class: 'axis' }, el('span', null, `${i}`), el('div', { class: 'abar' }, el('i', { style: `left:${50 + a * 50}%` })))));
  };
  const tick = () => {
    const devs = input.devices();
    const next = JSON.stringify([devs.map((d) => d.id), input.learn?.target ?? '', s.wheel, devs.length ? input.axesOf(s.wheel.deviceId).map((v) => Math.round(v * 20)) : []]);
    if (next !== sig) { sig = next; renderWheel(); }
  };
  renderWheel();
  const timer = window.setInterval(tick, 120);

  return {
    el: panel('settings',
      el('h2', null, t('set.title')),
      el('div', { class: 'cols' },
        el('section', null,
          el('h3', null, t('set.gameplay')),
          field(t('set.name'), nameInp),
          field(t('set.transmission'), segmented([{ value: 'auto', label: t('set.auto') }, { value: 'manual', label: t('set.manual') }], s.autoGear ? 'auto' : 'manual', (v) => { s.autoGear = v === 'auto'; ch(); })),
          field(t('set.abs'), onOff(s.abs, (b) => { s.abs = b; })),
          field(t('set.tc'), level(s.tc, (n) => { s.tc = n; })),
          field(t('set.steerAssist'), level(s.steerAssist, (n) => { s.steerAssist = n; })),
          field(t('set.minimap'), onOff(s.minimap, (b) => { s.minimap = b; })),
          field(t('set.camera'), segmented([{ value: 'chase', label: t('hud.cam.chase') }, { value: 'cockpit', label: t('hud.cam.cockpit') }], s.camera, (v) => { s.camera = v; ch(); })),
          field(t('set.steerSens'), slider(0.5, 1.6, 0.05, s.steerSens, (v) => { s.steerSens = v; ch(); }, (v) => v.toFixed(2))),
          field(t('set.volume'), slider(0, 1, 0.05, s.volume, (v) => { s.volume = v; ch(); }, (v) => `${Math.round(v * 100)} %`)),
        ),
        el('section', null,
          el('h3', null, t('set.pad')),
          el('p', { class: 'muted' }, t('set.padNote')),
          wheelBox,
          el('h3', null, t('set.keyboard')),
          el('p', { class: 'muted' }, t('set.controls')),
          el('p', { class: 'muted' }, t('set.controls2')),
        )),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', onclick: cb.onClose }, t('menu.back')))),
    dispose: () => { window.clearInterval(timer); input.cancelLearn(); },
  };
}

// ------------------------------------------------------------------ pauza
export function pauseScreen(cb: { onResume: () => void; onRestart?: () => void; onSettings: () => void; onQuit: () => void; quitLabel?: string }): Screen {
  return {
    el: panel('pause narrow',
      el('h2', null, t('menu.paused')),
      el('div', { class: 'menu-list compact' },
        el('button', { class: 'menu-item', onclick: cb.onResume }, el('span', null, t('menu.resume'))),
        cb.onRestart ? el('button', { class: 'menu-item', onclick: cb.onRestart }, el('span', null, t('menu.restart'))) : null,
        el('button', { class: 'menu-item', onclick: cb.onSettings }, el('span', null, t('menu.settings'))),
        el('button', { class: 'menu-item', onclick: cb.onQuit }, el('span', null, cb.quitLabel ?? t('menu.quit'))))),
  };
}

// ------------------------------------------------------------------ 24-hodinovka (samostatne proti AI)
export function enduranceSetupScreen(s: Settings, cb: { onStart: () => void; onBack: () => void }): Screen {
  const e = s.endurance;
  const body = el('div', { class: 'form' });
  const render = () => {
    const teams = e.cls === 'F1' ? TEAMS : GT_TEAMS;
    if (!teams.some((x) => x.id === e.teamId)) e.teamId = teams[0].id;
    const teamSel = el('select', { onchange: (ev: Event) => { e.teamId = (ev.target as HTMLSelectElement).value; } },
      ...teams.map((x) => el('option', { value: x.id, selected: x.id === e.teamId }, x.cls === 'F1' ? x.name : `${x.brand} – ${CAR_MODEL_BY_ID[x.car].name}`)));
    const trackSel = el('select', { onchange: (ev: Event) => { e.trackId = (ev.target as HTMLSelectElement).value; } },
      ...TRACKS.map((x) => el('option', { value: x.id, selected: x.id === e.trackId }, x.round ? `${String(x.round).padStart(2, '0')} · ${x.name}` : `★ ${x.name}`)));
    body.replaceChildren(
      field(t('setup.class'), segmented([{ value: 'F1', label: t('cls.F1') }, { value: 'GT', label: t('cls.GT') }], e.cls, (v) => { e.cls = v; render(); })),
      field(t('setup.team'), teamSel),
      field(t('setup.track'), trackSel),
      field(t('setup.difficulty'), segmented<Difficulty>(
        (['easy', 'medium', 'hard', 'expert'] as const).map((d) => ({ value: d, label: t('diff.' + d) })), e.difficulty, (v) => { e.difficulty = v; })),
      field(t('setup.weather'), segmented<WeatherMode>(
        (['dry', 'dynamic', 'rain'] as const).map((d) => ({ value: d, label: t('weather.' + d) })), e.weather, (v) => { e.weather = v; })),
    );
  };
  render();
  return {
    el: panel('setup',
      el('h2', null, t('endurance.title')),
      el('p', { class: 'muted' }, t('endurance.info')),
      body,
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost', onclick: cb.onBack }, t('menu.back')),
        el('button', { class: 'btn primary', onclick: cb.onStart }, t('menu.start')))),
  };
}

// ------------------------------------------------------------------ výsledky
function lapsBehindText(n: number): string {
  return t(n === 1 ? 'result.lapsBehind' : n < 5 ? 'result.lapsBehind2' : 'result.lapsBehind5', { n });
}

export interface ResultsCb {
  onAgain?: () => void; onMenu: () => void; onSkip: () => void;
  /** Kariéra: blok s bodmi, levelom a mincami + vlastné texty. */
  extra?: Node | null; menuLabel?: string; title?: string; hideSkip?: boolean;
}

export function resultsScreen(race: Race, state: 'partial' | 'computing' | 'final', cb: ResultsCb): Screen {
  const list: Racer[] = race.classification();
  const winner = list[0];
  const mixed = !!race.cfg.mixed;
  const inClass = list.filter((r) => !mixed || r.cls === race.player.cls);
  const classPos = inClass.indexOf(race.player) + 1;
  const L = race.track.length;
  const rows = list.map((r) => {
    let time = '';
    if (r.finished && r.finishT != null) time = r === winner ? fmtTime(r.finishT) : `+${(r.finishT - (winner.finishT ?? 0)).toFixed(3)}`;
    else if (r.finished) time = '';
    else {
      const behind = Math.max(0, Math.floor((winner.prog - r.prog) / L));
      time = state === 'final' ? t('result.dnf') : behind > 0 ? lapsBehindText(behind) : '…';
    }
    return el('tr', { class: r.isPlayer ? 'me' : '' },
      el('td', { class: 'n' }, r.pos),
      el('td', null, el('i', { class: 'dot', style: `background:${r.color}` }), r.isPlayer ? `${r.name} (${t('result.you')})` : r.name),
      el('td', { class: 'muted' }, mixed ? `${r.cls} · ${r.teamName}` : r.teamName),
      el('td', { class: 'n' }, race.cfg.durationS != null ? `${r.lapsDone}` : `${Math.min(r.lapsDone, race.cfg.laps)}/${race.cfg.laps}`),
      el('td', { class: 'n' }, r.dq ? t('result.dq') : time),
      el('td', { class: 'n' + (race.bestLapOverall?.racer === r ? ' purple' : '') }, fmtTime(r.bestLap)),
      el('td', { class: 'n' }, r.pit.stops));
  });
  const fastest = race.bestLapOverall;
  const done = list.filter((r) => r.finished).length;
  return {
    el: panel('results',
      el('h2', null, cb.title ?? t('result.title')),
      cb.extra ?? null,
      el('p', { class: 'lead' }, t('result.winner', { name: winner.name }), ' · ', t('result.yourPos', { pos: race.player.pos }), mixed ? ` · ${t('result.classPos', { cls: race.player.cls, pos: classPos, n: inClass.length })}` : ''),
      el('div', { class: 'tablewrap' },
        el('table', { class: 'results' },
          el('thead', null, el('tr', null, ...[t('result.pos'), t('result.driver'), t('result.team'), t('result.laps'), t('result.time'), t('result.best'), t('result.pits')].map((h) => el('th', null, h)))),
          el('tbody', null, ...rows))),
      el('p', { class: 'muted' },
        fastest ? t('result.fastest', { name: fastest.racer.name, time: fmtTime(fastest.t) }) : '',
        state !== 'final' ? ` · ${t('result.finishedRacers', { n: done, total: list.length })}` : ''),
      el('div', { class: 'actions' },
        state === 'final' || cb.hideSkip ? null : el('button', { class: 'btn ghost', disabled: state === 'computing', onclick: cb.onSkip }, state === 'computing' ? t('result.calc') : t('result.skipAhead')),
        el('button', { class: cb.onAgain ? 'btn ghost' : 'btn primary', onclick: cb.onMenu, disabled: !!cb.hideSkip && state !== 'final' }, cb.menuLabel ?? t('result.menu')),
        cb.onAgain ? el('button', { class: 'btn primary', onclick: cb.onAgain }, t('result.again')) : null)),
  };
}
