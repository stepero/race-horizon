import { t } from '../i18n';
import { CAR_MODEL_BY_ID, GT_TEAMS, TEAMS, TEAM_BY_ID, TRACKS, TRACK_BY_ID } from '../data/catalog';
import { fmtTime } from '../sim/math';
import type { Settings } from '../settings';
import { LIMITS, type RoomSettings, type S2C, type StandingRow } from '../net/protocol';
import { NetClient, defaultServerUrl, type ChatLine } from '../net/client';
import { el, field, segmented, slider } from './dom';
import { panel, type Screen } from './screens';

export interface OnlineHost {
  settings: Settings;
  persist(): void;
  setScreen(s: Screen | null): void;
  toMainMenu(): void;
  /** Server spustil preteky – načítaj trať a po načítaní zavolaj `net.send({t:'loaded'})`. */
  startOnline(msg: Extract<S2C, { t: 'start' }>): void;
  /** Spojenie spadlo počas pretekov. */
  abortOnline(): void;
  toast(msg: string): void;
}

type View = 'none' | 'connect' | 'rooms' | 'room' | 'race';

const teamsOf = (cls: 'F1' | 'GT') => (cls === 'F1' ? TEAMS : GT_TEAMS);
const teamLabelOf = (id: string) => {
  const x = TEAM_BY_ID[id];
  if (!x) return id;
  return x.cls === 'F1' ? x.name : `${x.brand} – ${CAR_MODEL_BY_ID[x.car].name}`;
};

/** Text riadku chatu (systémové správy sa prekladajú podľa kľúča). */
export function chatText(c: ChatLine): { who: string; text: string; sys: boolean } {
  if (c.from == null) return { who: '', text: t(c.key ?? '', c.params), sys: true };
  return { who: c.name, text: c.text, sys: false };
}

function chatLineEl(c: ChatLine, selfId: string | null): HTMLElement {
  const x = chatText(c);
  if (x.sys) return el('div', { class: 'cline sys' }, x.text);
  return el('div', { class: 'cline' + (c.from === selfId ? ' me' : '') }, el('b', null, `${x.who}: `), x.text);
}

/** Tabuľka online výsledkov / poradia. */
export function standingsTable(list: StandingRow[], selfId: string | null, laps: number): HTMLElement {
  const win = list[0];
  const rows = list.map((r) => {
    let time = '';
    if (r.left) time = t('net.res.left');
    else if (r.fin && r.finT != null) time = r === win || win.finT == null ? fmtTime(r.finT) : `+${(r.finT - win.finT).toFixed(3)}`;
    else time = t('net.res.running');
    return el('tr', { class: r.id === selfId ? 'me' : '' },
      el('td', { class: 'n' }, r.pos),
      el('td', null, el('i', { class: 'dot', style: `background:${TEAM_BY_ID[r.teamId]?.color ?? '#888'}` }), r.id === selfId ? `${r.name} (${t('result.you')})` : r.name),
      el('td', { class: 'muted' }, TEAM_BY_ID[r.teamId]?.name ?? r.teamId),
      el('td', { class: 'n' }, `${Math.min(r.laps, laps)}/${laps}`),
      el('td', { class: 'n' }, time),
      el('td', { class: 'n' }, fmtTime(r.best)));
  });
  return el('div', { class: 'tablewrap short' },
    el('table', { class: 'results' },
      el('thead', null, el('tr', null, ...[t('result.pos'), t('result.driver'), t('result.team'), t('result.laps'), t('result.time'), t('result.best')].map((h) => el('th', null, h)))),
      el('tbody', null, ...rows)));
}

/**
 * Online lobby: pripojenie na server → zoznam miestností → miestnosť (hráči, nastavenia, chat).
 * Preteky samotné riadi `App` (startOnline) spolu s `OnlineSession`.
 */
export class OnlineFlow {
  readonly net = new NetClient();
  private view: View = 'none';
  private error = '';
  private offMsg: (() => void) | null = null;
  private roomEls: { players: HTMLElement; settings: HTMLElement; chat: HTMLElement; actions: HTMLElement; results: HTMLElement; status: HTMLElement } | null = null;
  private roomsEl: HTMLElement | null = null;
  private lastSettingsSig = '';

  constructor(private host: OnlineHost) {
    this.net.onClose(() => {
      const wasRace = this.view === 'race';
      this.offMsg?.(); this.offMsg = null;
      if (this.view === 'none') return;
      this.error = t('net.err.lost');
      if (wasRace) this.host.abortOnline();
      this.openConnect();
    });
  }

  private get s(): Settings['online'] { return this.host.settings.online; }

  /** Vstup z hlavného menu. */
  open(): void {
    if (this.net.connected) { if (this.net.room) this.openRoom(); else this.openRooms(); return; }
    this.openConnect();
  }

  /** Návrat z pretekov do miestnosti (alebo zoznamu, ak už v nej nie sme). */
  backFromRace(): void {
    if (!this.net.connected) { this.openConnect(); return; }
    if (this.net.room) this.openRoom(); else this.openRooms();
  }

  /** Hráč opúšťa rozbehnuté preteky = odchod z miestnosti. */
  quitRace(): void {
    this.net.send({ t: 'leave' });
    this.openRooms();
  }

  enterRace(): void { this.view = 'race'; this.roomEls = null; this.roomsEl = null; }

  private leaveAll(): void {
    this.view = 'none';
    this.offMsg?.(); this.offMsg = null;
    this.net.close();
    this.host.toMainMenu();
  }

  private bind(): void {
    if (this.offMsg) return;
    this.offMsg = this.net.on((m) => this.onMessage(m));
  }

  private onMessage(m: S2C): void {
    switch (m.t) {
      case 'rooms': if (this.view === 'rooms') this.renderRooms(); break;
      case 'room':
        if (this.view === 'race') break;
        if (m.room && this.view !== 'room') this.openRoom();
        else if (!m.room && this.view === 'room') this.openRooms();
        else if (this.view === 'room') this.renderRoom();
        break;
      case 'chat': if (this.view === 'room' && this.roomEls) this.appendChat(this.roomEls.chat, this.net.chat[this.net.chat.length - 1]); break;
      case 'start': this.enterRace(); this.host.startOnline(m); break;
      case 'error':
        if (this.view === 'race') this.host.toast(t(m.key));
        else { this.error = t(m.key); this.showError(); }
        break;
      default: break;
    }
  }

  private errEl = el('p', { class: 'bad neterr' });
  private showError(): void {
    this.errEl.textContent = this.error;
    this.errEl.style.display = this.error ? '' : 'none';
  }

  // ------------------------------------------------------------------ pripojenie
  openConnect(): void {
    this.view = 'connect';
    const s = this.s;
    if (!s.server) s.server = defaultServerUrl();
    const url = el('input', { type: 'text', value: s.server, spellcheck: 'false' });
    url.value = s.server;
    const name = el('input', { type: 'text', maxlength: LIMITS.name, value: this.host.settings.name });
    name.value = this.host.settings.name;
    const go = el('button', { class: 'btn primary' }, t('net.connect'));
    const status = el('p', { class: 'muted' });
    const connect = async () => {
      s.server = url.value.trim() || defaultServerUrl();
      this.host.settings.name = name.value.trim().slice(0, LIMITS.name) || 'Hráč';
      this.host.persist();
      go.disabled = true;
      status.textContent = t('net.connecting');
      this.error = ''; this.showError();
      try {
        await this.net.connect(s.server, this.host.settings.name);
        this.bind();
        this.openRooms();
      } catch (e) {
        go.disabled = false;
        status.textContent = '';
        this.error = t(e instanceof Error ? e.message : 'net.err.connect');
        this.showError();
      }
    };
    go.onclick = () => void connect();
    url.onkeydown = name.onkeydown = (e: KeyboardEvent) => { if (e.key === 'Enter') void connect(); };
    this.showError();
    this.host.setScreen({
      el: panel('career narrowish',
        el('h2', null, t('net.title')),
        el('p', { class: 'muted' }, t('net.intro')),
        el('div', { class: 'form' },
          field(t('net.server'), url, t('net.serverHint')),
          field(t('set.name'), name)),
        this.errEl, status,
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', onclick: () => this.leaveAll() }, t('menu.back')),
          go)),
    });
  }

  // ------------------------------------------------------------------ zoznam miestností
  openRooms(): void {
    this.view = 'rooms';
    this.roomEls = null;
    this.roomsEl = el('div', { class: 'slots' });
    const s = this.s;
    const draft: RoomSettings = { ...s.room };
    if (!TRACK_BY_ID[draft.trackId]) draft.trackId = TRACKS[0].id;
    const roomName = el('input', { type: 'text', maxlength: LIMITS.roomName, value: s.roomName || t('net.roomDefault', { name: this.host.settings.name }) });
    roomName.value = s.roomName || t('net.roomDefault', { name: this.host.settings.name });
    const form = el('div', { class: 'form' }, field(t('net.roomName'), roomName), ...settingsFields(draft, () => undefined));
    const create = () => {
      s.room = { ...draft };
      s.roomName = roomName.value.trim();
      this.host.persist();
      this.error = ''; this.showError();
      this.net.send({ t: 'create', name: s.roomName || roomName.value, settings: draft, teamId: this.teamFor(draft.cls) });
    };
    this.error = ''; this.showError();
    this.host.setScreen({
      el: panel('career online',
        el('div', { class: 'hubhead' },
          el('div', { class: 'who' }, el('h2', null, t('net.rooms')), el('div', { class: 'muted' }, t('net.connectedAs', { name: this.host.settings.name, server: s.server })))),
        this.errEl,
        el('div', { class: 'cols' },
          el('section', null,
            el('h3', null, t('net.openRooms')),
            this.roomsEl,
            el('button', { class: 'btn small', onclick: () => this.net.send({ t: 'list' }) }, t('net.refresh'))),
          el('section', null,
            el('h3', null, t('net.create')),
            form,
            el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: create }, t('net.createBtn'))))),
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', onclick: () => this.leaveAll() }, t('net.disconnect')))),
    });
    this.renderRooms();
  }

  private teamFor(cls: 'F1' | 'GT'): string {
    const id = cls === 'F1' ? this.s.teamF1 : this.s.teamGT;
    return TEAM_BY_ID[id]?.cls === cls ? id : teamsOf(cls)[0].id;
  }

  private renderRooms(): void {
    const box = this.roomsEl;
    if (!box) return;
    const rooms = this.net.rooms;
    if (!rooms.length) { box.replaceChildren(el('p', { class: 'muted' }, t('net.noRooms'))); return; }
    box.replaceChildren(...rooms.map((r) => {
      const tr = TRACK_BY_ID[r.settings.trackId];
      const can = r.status === 'lobby' && r.players < r.settings.maxPlayers;
      return el('div', { class: 'slot' },
        el('div', null, el('b', null, r.name),
          el('div', { class: 'muted' }, `${tr?.name ?? r.settings.trackId} · ${t('cls.' + r.settings.cls)} · ${t('career.lapsN', { n: r.settings.laps })} · ${t('weather.' + r.settings.weather)}`),
          el('div', { class: 'muted' }, `${t('net.players', { n: r.players, max: r.settings.maxPlayers })} · ${t('net.status.' + r.status)}`)),
        el('button', { class: 'btn small primary', disabled: !can, onclick: () => { this.error = ''; this.showError(); this.net.send({ t: 'join', roomId: r.id, teamId: this.teamFor(r.settings.cls) }); } }, t('net.join')));
    }));
  }

  // ------------------------------------------------------------------ miestnosť
  openRoom(): void {
    const room = this.net.room;
    if (!room) { this.openRooms(); return; }
    this.view = 'room';
    this.roomsEl = null;
    this.lastSettingsSig = '';
    const chat = el('div', { class: 'chatlog' });
    const input = el('input', { type: 'text', maxlength: LIMITS.chat, placeholder: t('net.chatPh') });
    const send = () => {
      const v = input.value.trim();
      if (!v) return;
      this.net.send({ t: 'chat', text: v });
      input.value = '';
    };
    input.onkeydown = (e: KeyboardEvent) => { if (e.key === 'Enter') send(); };
    this.roomEls = {
      players: el('div', { class: 'plist' }), settings: el('div', { class: 'form' }), chat, actions: el('div', { class: 'actions' }),
      results: el('div'), status: el('div', { class: 'muted' }),
    };
    for (const c of this.net.chat) this.appendChat(chat, c);
    const title = el('h2', null, room.name);
    this.host.setScreen({
      el: panel('career online',
        el('div', { class: 'hubhead' }, el('div', { class: 'who' }, title, this.roomEls.status)),
        this.errEl,
        el('div', { class: 'cols' },
          el('section', null,
            el('h3', null, t('net.playersTitle')),
            this.roomEls.players,
            el('h3', null, t('net.settings')),
            this.roomEls.settings),
          el('section', null,
            el('h3', null, t('net.chat')),
            chat,
            el('div', { class: 'chatin' }, input, el('button', { class: 'btn small', onclick: send }, t('net.send'))),
            this.roomEls.results)),
        this.roomEls.actions),
    });
    this.renderRoom();
  }

  private appendChat(box: HTMLElement, c: ChatLine | undefined): void {
    if (!c) return;
    box.append(chatLineEl(c, this.net.id));
    while (box.childElementCount > 60) box.firstElementChild?.remove();
    box.scrollTop = box.scrollHeight;
  }

  private renderRoom(): void {
    const room = this.net.room, E = this.roomEls;
    if (!room || !E) return;
    const me = room.players.find((p) => p.id === this.net.id);
    const host = this.net.isHost;
    const lobby = room.status === 'lobby';
    E.status.textContent = `${t('net.status.' + room.status)} · ${t('net.players', { n: room.players.length, max: room.settings.maxPlayers })}`;

    E.players.replaceChildren(...room.players.map((p) => {
      const isMe = p.id === this.net.id;
      const team = TEAM_BY_ID[p.teamId];
      const teamCtl = isMe && lobby
        ? el('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; this.rememberTeam(room.settings.cls, v); this.net.send({ t: 'team', teamId: v }); } },
          ...teamsOf(room.settings.cls).map((x) => el('option', { value: x.id, selected: x.id === p.teamId }, teamLabelOf(x.id))))
        : el('span', { class: 'muted' }, teamLabelOf(p.teamId));
      const badge = p.id === room.hostId ? el('span', { class: 'chip next' }, t('net.host'))
        : el('span', { class: 'chip' + (p.ready ? ' done' : '') }, p.ready ? t('net.ready') : t('net.notReady'));
      return el('div', { class: 'prow2' + (isMe ? ' me' : '') },
        el('i', { class: 'dot', style: `background:${team?.color ?? '#888'}` }),
        el('b', null, isMe ? `${p.name} (${t('result.you')})` : p.name), teamCtl, badge);
    }));

    // nastavenia: hostiteľ ich mení, ostatní vidia len popis
    const sig = JSON.stringify([room.settings, host, lobby]);
    if (sig !== this.lastSettingsSig) {
      this.lastSettingsSig = sig;
      if (host && lobby) {
        const draft: RoomSettings = { ...room.settings };
        const push = () => this.net.send({ t: 'settings', settings: draft });
        E.settings.replaceChildren(...settingsFields(draft, push, true));
      } else {
        const s = room.settings, tr = TRACK_BY_ID[s.trackId];
        E.settings.replaceChildren(
          el('p', null, el('b', null, tr?.name ?? s.trackId), ` · ${tr?.gp ?? ''}`),
          el('p', { class: 'muted' }, `${t('cls.' + s.cls)} · ${t('career.lapsN', { n: s.laps })} · ${t('weather.' + s.weather)} · ${t('net.maxPlayers')}: ${s.maxPlayers}`),
          el('p', { class: 'muted' }, t('net.hostOnly')));
      }
    }

    E.results.replaceChildren(...(room.lastResults ? [el('h3', null, t('net.lastResults')), standingsTable(room.lastResults, this.net.id, room.settings.laps)] : []));

    const others = room.players.filter((p) => p.id !== room.hostId);
    const allReady = others.every((p) => p.ready);
    const enough = room.players.length >= LIMITS.minPlayers;
    const leave = el('button', { class: 'btn ghost', onclick: () => this.net.send({ t: 'leave' }) }, t('net.leave'));
    if (!lobby) E.actions.replaceChildren(el('span', { class: 'muted' }, t('net.raceRunning')), leave);
    else if (host) {
      E.actions.replaceChildren(
        el('span', { class: 'muted' }, !enough ? t('net.waitPlayers') : !allReady ? t('net.waitReady') : t('net.canStart')),
        leave,
        el('button', { class: 'btn primary', disabled: !enough || !allReady, onclick: () => this.net.send({ t: 'start' }) }, t('net.start')));
    } else {
      E.actions.replaceChildren(
        el('span', { class: 'muted' }, t('net.waitHost')),
        leave,
        el('button', { class: me?.ready ? 'btn ghost' : 'btn primary', onclick: () => this.net.send({ t: 'ready', ready: !me?.ready }) }, me?.ready ? t('net.unready') : t('net.readyBtn')));
    }
  }

  private rememberTeam(cls: 'F1' | 'GT', id: string): void {
    if (cls === 'F1') this.s.teamF1 = id; else this.s.teamGT = id;
    this.host.persist();
  }
}

/** Polia nastavení miestnosti. `onChange` sa volá pri každej zmene (pri `live` = hneď odoslanie na server). */
function settingsFields(d: RoomSettings, onChange: () => void, live = false): HTMLElement[] {
  const trackSel = el('select', { onchange: (e: Event) => { d.trackId = (e.target as HTMLSelectElement).value; onChange(); } },
    ...TRACKS.map((x) => el('option', { value: x.id, selected: x.id === d.trackId }, x.round ? `${String(x.round).padStart(2, '0')} · ${x.name}` : `★ ${x.name}`)));
  // posuvníky posielajú zmenu až po pustení (nie pri každom pohybe)
  const sl = (min: number, max: number, v: number, set: (n: number) => void) => {
    const w = slider(min, max, 1, v, set);
    if (live) w.querySelector('input')!.addEventListener('change', onChange);
    return w;
  };
  return [
    field(t('setup.track'), trackSel),
    field(t('setup.class'), segmented([{ value: 'F1', label: t('cls.F1') }, { value: 'GT', label: t('cls.GT') }], d.cls, (v) => { d.cls = v; onChange(); })),
    field(t('setup.laps'), sl(1, LIMITS.maxLaps, d.laps, (n) => { d.laps = n; })),
    field(t('setup.weather'), segmented((['dry', 'dynamic', 'rain'] as const).map((w) => ({ value: w, label: t('weather.' + w) })), d.weather, (v) => { d.weather = v; onChange(); })),
    field(t('net.maxPlayers'), sl(LIMITS.minPlayers, LIMITS.maxPlayers, d.maxPlayers, (n) => { d.maxPlayers = n; })),
  ];
}

/** Rýchly chat počas pretekov: Enter otvorí pole, Enter odošle, Esc zruší. Posledné správy po chvíli zmiznú. */
export class RaceChat {
  readonly root = el('div', { class: 'racechat' });
  private log = el('div', { class: 'rlog' });
  private input = el('input', { type: 'text', maxlength: LIMITS.chat, placeholder: t('net.chatRacePh') });
  private seen = 0;
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || document.activeElement === this.input) return;
    if (document.getElementById('ui')?.classList.contains('active')) return; // pauza / výsledky
    e.preventDefault();
    this.root.classList.add('typing');
    this.input.focus();
  };

  constructor(private net: NetClient) {
    this.root.append(this.log, this.input);
    this.seen = net.chat.length;
    this.input.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        const v = this.input.value.trim();
        if (v) this.net.send({ t: 'chat', text: v });
        this.close();
      } else if (e.key === 'Escape') this.close();
      e.stopPropagation();
    };
    this.input.onblur = () => this.root.classList.remove('typing');
    addEventListener('keydown', this.onKey);
  }

  private close(): void {
    this.input.value = '';
    this.input.blur();
    this.root.classList.remove('typing');
  }

  /** Volať pravidelne (napr. každú snímku). */
  update(): void {
    const chat = this.net.chat;
    if (chat.length < this.seen) this.seen = 0;
    while (this.seen < chat.length) {
      const line = chatLineEl(chat[this.seen++], this.net.id);
      line.dataset.at = String(performance.now());
      this.log.append(line);
      while (this.log.childElementCount > 6) this.log.firstElementChild?.remove();
    }
    const now = performance.now();
    const typing = this.root.classList.contains('typing');
    for (const c of Array.from(this.log.children) as HTMLElement[]) {
      const age = (now - Number(c.dataset.at)) / 1000;
      c.style.opacity = typing ? '1' : String(Math.max(0, Math.min(1, 12 - age)));
    }
  }

  dispose(): void {
    removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}

/** Výsledková obrazovka online pretekov: živé poradie, po potvrdení serverom konečné. */
export function onlineResultsScreen(list: StandingRow[], selfId: string | null, laps: number, final: boolean, cb: { onBack: () => void; onLeave: () => void }): Screen {
  const me = list.find((r) => r.id === selfId);
  return {
    el: panel('results',
      el('h2', null, t('net.title.results')),
      list.length ? el('p', { class: 'lead' }, t('result.winner', { name: list[0].name }), me ? ` · ${t('result.yourPos', { pos: me.pos })}` : '') : null,
      standingsTable(list, selfId, laps),
      final ? null : el('p', { class: 'muted' }, t('net.results.wait')),
      el('div', { class: 'actions' },
        final ? null : el('button', { class: 'btn ghost', onclick: cb.onLeave }, t('net.results.leave')),
        final ? el('button', { class: 'btn primary', onclick: cb.onBack }, t('net.results.back')) : null)),
  };
}
