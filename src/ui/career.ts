import { t } from '../i18n';
import { CAR_MODEL_BY_ID, GT_TEAMS, TEAMS, TEAM_BY_ID, TRACKS, TRACK_BY_ID } from '../data/catalog';
import type { WeatherMode } from '../sim/weather';
import {
  acceptOffer, applyResult, buyUpgrade, canEndSeason, canQualify, canStartChamp, clsOf, createCareer, endSeason, eventBase, eventChamp,
  ENDURANCE_MIN, eventEndurance, eventQual, eventRegular, eventTourn, goalState, leaderboard, qualTrack, resolvePending, standingsRows, startChamp, startTourn, teamOf,
} from '../career/career';
import {
  CHAMP_RACES, MAX_LEVEL, MAX_UPGRADE, START_F1_TEAMS, TOURNAMENTS, UPGRADE_KEYS, seriesOf, teamLabel,
  unlockedSeries, upgradeEffects, upgradePrice, type UpgradeKey,
} from '../career/rules';
import { AVATARS, COUNTRIES, countryName } from '../career/profileData';
import { MAX_SLOTS, type CareerStore } from '../career/store';
import type { Career, CareerEvent, Goal, RaceOutcome, ResultRow, SeriesId, Standings } from '../career/types';
import { el, field, segmented } from './dom';
import { panel, type Screen } from './screens';
import type { Settings } from '../settings';

export interface CareerHost {
  store: CareerStore;
  settings: Settings;
  setScreen(s: Screen | null): void;
  toMainMenu(): void;
  startEvent(c: Career, ev: CareerEvent): void;
  startWorld?(c: Career): void;
}

const goalText = (g: Goal) => t('goal.' + g.kind, { n: g.target });

export const avatarEl = (i: number, big = false) => {
  const a = AVATARS[i % AVATARS.length];
  return el('span', { class: 'avatar' + (big ? ' big' : ''), style: `background:${a.bg}` }, a.glyph);
};

function noteParams(p?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!p) return p;
  const out = { ...p };
  if (typeof out.series === 'string') out.series = t('series.' + out.series);
  return out;
}

/** Blok s výsledkom kariérnych pretekov: level, body, mince, hlášky. */
export function outcomeBlock(o: RaceOutcome): HTMLElement {
  const sign = o.levelDelta > 0 ? `+${o.levelDelta}` : `${o.levelDelta}`;
  return el('div', { class: 'outcome' },
    o.retired ? el('p', { class: 'bad' }, t('cres.retired')) : null,
    el('div', { class: 'ostats' },
      el('div', { class: 'ostat' }, el('small', null, t('cres.level')),
        el('b', { class: o.levelDelta > 0 ? 'up' : o.levelDelta < 0 ? 'down' : '' }, sign),
        el('span', null, t('cres.levelLine', { before: o.levelBefore, after: o.levelAfter }))),
      o.kind === 'champ' || o.kind === 'tourn'
        ? el('div', { class: 'ostat' }, el('small', null, t('cres.points')), el('b', null, `+${o.points}`)) : null,
      el('div', { class: 'ostat' }, el('small', null, t('cres.coins')), el('b', { class: 'up' }, `+${o.coins}`))),
    ...o.notes.map((n) => el('p', { class: 'note' }, t(n.key, noteParams(n.params)))));
}

export class CareerFlow {
  c: Career | null = null;
  constructor(private host: CareerHost) {}

  private show(s: Screen) { this.host.setScreen(s); }
  private save() { if (this.c) this.host.store.save(this.c); }

  // ------------------------------------------------------------ vstup
  openMenu(): void {
    const metas = this.host.store.list();
    const list = el('div', { class: 'slots' });
    if (!metas.length) list.append(el('p', { class: 'muted' }, t('career.none')));
    for (const m of metas) {
      const tm = TEAM_BY_ID[m.teamId];
      list.append(el('div', { class: 'slot' },
        el('div', null, el('b', null, m.nickname || m.name), el('small', null, ' · ', m.name),
          el('div', { class: 'muted' }, t('career.slotInfo', { season: m.season, level: m.level, team: tm ? tm.name : m.teamId }))),
        el('div', { class: 'row' },
          el('button', { class: 'btn small', onclick: () => { if (confirm(t('career.deleteConfirm', { name: m.nickname || m.name }))) { this.host.store.delete(m.id); this.openMenu(); } } }, t('career.delete')),
          el('button', { class: 'btn small primary', onclick: () => this.load(m.id) }, t('career.continue')))));
    }
    const full = metas.length >= MAX_SLOTS;
    this.show({
      el: panel('career narrowish',
        el('h2', null, t('career.title')),
        list,
        full ? el('p', { class: 'muted' }, t('career.slotsFull', { n: MAX_SLOTS })) : null,
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', onclick: () => this.host.toMainMenu() }, t('menu.back')),
          el('button', { class: 'btn ghost', onclick: () => this.openBoard(() => this.openMenu()) }, t('career.leaderboard')),
          el('button', { class: 'btn primary', disabled: full, onclick: () => this.openCreate() }, t('career.new')))),
    });
  }

  load(id: string): void {
    const c = this.host.store.load(id);
    if (!c) { this.openMenu(); return; }
    this.c = c;
    const out = resolvePending(c);
    if (out) this.save();
    this.openHub(out ?? undefined);
  }

  openCreate(): void {
    const draft = { name: this.host.settings.name === 'Hráč' ? '' : this.host.settings.name, nickname: '', country: 'SK', avatar: 0 };
    let cls: 'F1' | 'GT' = 'GT';
    let teamId = 'gt-toyota';
    const body = el('div', { class: 'form' });
    const start = el('button', { class: 'btn primary', onclick: () => {
      const c = createCareer({ name: draft.name.trim(), nickname: draft.nickname.trim() || draft.name.trim().split(' ')[0], country: draft.country, avatar: draft.avatar }, teamId);
      this.c = c; this.save(); this.openHub();
    } }, t('career.begin'));
    const check = () => { start.disabled = draft.name.trim().length < 2; };
    const render = () => {
      const teams = cls === 'F1' ? TEAMS.filter((x) => START_F1_TEAMS.includes(x.id)) : GT_TEAMS;
      if (!teams.some((x) => x.id === teamId)) teamId = teams[teams.length - 1].id;
      const nameInp = el('input', { type: 'text', maxlength: 24, placeholder: t('career.name'), oninput: () => { draft.name = nameInp.value; check(); } });
      const nickInp = el('input', { type: 'text', maxlength: 14, placeholder: t('career.nickname'), oninput: () => { draft.nickname = nickInp.value; } });
      nameInp.value = draft.name; nickInp.value = draft.nickname;
      const country = el('select', { onchange: (e: Event) => { draft.country = (e.target as HTMLSelectElement).value; } },
        ...COUNTRIES.map((x) => el('option', { value: x.code, selected: x.code === draft.country }, x.name)));
      const av = el('div', { class: 'avatars' }, ...AVATARS.map((_, i) =>
        el('button', { type: 'button', class: 'avbtn' + (i === draft.avatar ? ' on' : ''), onclick: () => { draft.avatar = i; render(); } }, avatarEl(i))));
      const car = el('div', { class: 'info' });
      const carLine = () => {
        const tm = TEAM_BY_ID[teamId];
        car.replaceChildren(el('div', null, t('career.carIs', { car: `${CAR_MODEL_BY_ID[tm.car].brand} ${CAR_MODEL_BY_ID[tm.car].name}` })), el('div', { class: 'muted' }, t('career.teamHint')));
      };
      const team = el('select', { onchange: (e: Event) => { teamId = (e.target as HTMLSelectElement).value; carLine(); } },
        ...teams.map((x) => el('option', { value: x.id, selected: x.id === teamId }, teamLabel(x))));
      carLine();
      body.replaceChildren(
        field(t('career.name'), nameInp), field(t('career.nickname'), nickInp), field(t('career.country'), country), field(t('career.avatar'), av),
        field(t('career.class'), segmented<'F1' | 'GT'>([{ value: 'GT', label: t('cls.GT') }, { value: 'F1', label: t('cls.F1') }], cls, (v) => { cls = v; render(); })),
        field(t('career.team'), team), car);
    };
    render(); check();
    this.show({ el: panel('career', el('h2', null, t('career.create')), body, el('div', { class: 'actions' }, el('button', { class: 'btn ghost', onclick: () => this.openMenu() }, t('menu.back')), start)) });
  }

  // ------------------------------------------------------------ centrum
  openHub(last?: RaceOutcome): void {
    const c = this.c!;
    const team = teamOf(c);
    const gs = goalState(c, c.goal);
    const progress = c.goal.kind === 'wins' ? t('goal.progressWins', { n: gs.value }) : c.goal.kind === 'podiums' ? t('goal.progressPodiums', { n: gs.value })
      : c.goal.kind === 'points' ? t('goal.progressPoints', { n: gs.value }) : (c.champ?.done ? `#${c.champ.finalPos}` : t('goal.progressChamp'));
    const tile = (label: string, sub: string, on?: () => void, off = false) =>
      el('button', { class: 'tile' + (off ? ' off' : ''), disabled: off || !on, onclick: on }, el('b', null, label), el('small', null, sub));
    const champSub = c.champ ? (c.champ.done ? t('career.champ.done', { pos: c.champ.finalPos ?? '-' }) : t('career.hub.sub.champ', { n: c.champ.round, total: CHAMP_RACES })) : t('career.hub.sub.champNone');
    const canEnd = canEndSeason(c) && !!c.champ?.done;
    this.show({
      el: panel('career hub',
        el('div', { class: 'hubhead' },
          avatarEl(c.profile.avatar, true),
          el('div', { class: 'who' }, el('h2', null, c.profile.nickname || c.profile.name),
            el('div', { class: 'muted' }, `${c.profile.name} · ${countryName(c.profile.country)}`),
            el('div', null, el('i', { class: 'dot', style: `background:${team.color}` }), teamLabel(team))),
          el('div', { class: 'stats' },
            el('div', { class: 'stat' }, el('small', null, t('career.hub.season', { n: c.season })), el('b', null, `${t('career.hub.level')} ${c.level}`),
              el('div', { class: 'bar' }, el('div', { class: 'fill', style: `width:${(c.level / MAX_LEVEL) * 100}%` })), el('small', null, `0 – ${MAX_LEVEL}`)),
            el('div', { class: 'stat' }, el('small', null, t('career.hub.coins')), el('b', { class: 'coins' }, c.coins)))),
        last ? el('div', { class: 'callout' }, el('p', { class: 'note' }, t('career.pendingNote')), outcomeBlock(last)) : null,
        el('div', { class: 'goalbox' + (c.goal.done ? ' done' : '') },
          el('small', null, t('career.hub.goal'), c.goal.retry ? ` ${t('goal.retry')}` : ''),
          el('div', null, el('b', null, goalText(c.goal)), ' · ', t('goal.reward', { n: c.goal.reward })),
          el('small', null, c.goal.done ? t('career.hub.goalDone') : `${t('career.hub.goalOpen')} – ${progress}`)),
        el('div', { class: 'tiles' },
          tile(t('career.hub.qual'), t('career.hub.sub.qual'), () => this.openQual()),
          tile(t('career.hub.champ'), champSub, () => this.openChamp()),
          tile(t('career.hub.tourn'), c.tourn && !c.tourn.done ? t('career.tourn.active') : t('career.hub.sub.tourn'), () => this.openTourn()),
          tile(t('career.hub.regular'), t('career.hub.sub.regular'), () => this.openRegular()),
          tile(t('career.hub.base'), t('career.hub.sub.base'), () => this.openBase()),
          tile(t('career.hub.shop'), t('career.hub.sub.shop'), () => this.openShop()),
          tile(t('career.hub.board'), `${t('career.hub.level')} ${c.level}`, () => this.openBoard(() => this.openHub())),
          tile(t('career.hub.world'), t('career.hub.sub.world'), this.host.startWorld ? () => this.host.startWorld!(c) : undefined),
          tile(t('career.hub.endurance'), c.endurance.done ? t('career.hub.sub.enduranceDone') : t('career.hub.sub.endurance'), c.endurance.done ? undefined : () => this.openEndurance(), c.endurance.done),
          tile(t('career.hub.end'), canEnd ? t('career.hub.sub.end') : t('career.hub.sub.endLocked'),
            canEnd ? () => { endSeason(c); this.save(); this.openOffers(); } : undefined, !canEnd)),
        el('div', { class: 'actions' },
          el('button', { class: 'btn primary', onclick: () => { this.save(); this.c = null; this.host.toMainMenu(); } }, t('career.hub.save')))),
    });
  }

  private back(): HTMLElement {
    return el('button', { class: 'btn ghost', onclick: () => this.openHub() }, t('career.back'));
  }

  private seriesLabel(id: SeriesId) { return t('series.' + id); }

  // ------------------------------------------------------------ kvalifikácie
  openQual(): void {
    const c = this.c!;
    const rows = seriesOf(clsOf(c)).map((s) => {
      const locked = c.level < s.unlockLevel;
      const st = c.qual[s.id];
      return el('div', { class: 'erow' + (locked ? ' off' : '') },
        el('div', null, el('b', null, this.seriesLabel(s.id)), el('small', null, ` · ${TRACK_BY_ID[qualTrack(c, s.id)].gp}`)),
        el('div', { class: 'muted' }, locked ? t('career.locked', { n: s.unlockLevel }) : st === 'passed' ? t('career.qual.passed') : st === 'failed' ? t('career.qual.failed') : t('career.qual.open')),
        el('button', { class: 'btn small primary', disabled: !canQualify(c, s.id), onclick: () => this.host.startEvent(c, eventQual(c, s.id)) }, t('career.qual.start')));
    });
    this.show({ el: panel('career', el('h2', null, t('career.qual.title')), el('p', { class: 'muted' }, t('career.qual.info')), ...rows, el('div', { class: 'actions' }, this.back())) });
  }

  // ------------------------------------------------------------ šampionát / turnaj
  private standingsTable(st: Standings, limit = 20): HTMLElement {
    const c = this.c!;
    const rows = standingsRows(st, c);
    const shown = rows.slice(0, limit);
    const me = rows.find((r) => r.isPlayer);
    if (me && !shown.includes(me)) shown.push(me);
    return el('div', { class: 'tablewrap short' }, el('table', { class: 'results' },
      el('thead', null, el('tr', null, ...[t('result.pos'), t('result.driver'), t('result.team'), 'V', t('career.pts')].map((h) => el('th', null, h)))),
      el('tbody', null, ...shown.map((r) => el('tr', { class: r.isPlayer ? 'me' : '' },
        el('td', { class: 'n' }, r.pos), el('td', null, el('i', { class: 'dot', style: `background:${r.color}` }), r.name), el('td', { class: 'muted' }, r.team),
        el('td', { class: 'n' }, r.wins), el('td', { class: 'n' }, r.points))))));
  }

  private calendar(st: Standings): HTMLElement {
    return el('div', { class: 'cal' }, ...st.tracks.map((id, i) => {
      const done = i < st.round;
      return el('span', { class: 'chip' + (done ? ' done' : i === st.round ? ' next' : '') }, `${i + 1}. ${TRACK_BY_ID[id].country}`, done && st.results[i] ? ` (${st.results[i]}.)` : '');
    }));
  }

  openChamp(): void {
    const c = this.c!;
    const body: (Node | null)[] = [el('h2', null, t('career.champ.title')), el('p', { class: 'muted' }, t('career.champ.info'))];
    if (!c.champ) {
      const avail = seriesOf(clsOf(c)).filter((s) => canStartChamp(c, s.id));
      if (!avail.length) body.push(el('div', { class: 'info' }, t('career.champ.need')));
      for (const s of avail) body.push(el('div', { class: 'erow' }, el('b', null, this.seriesLabel(s.id)), el('span'),
        el('button', { class: 'btn small primary', onclick: () => { startChamp(c, s.id); this.save(); this.openChamp(); } }, t('career.champ.begin'))));
    } else {
      const ch = c.champ;
      body.push(el('h3', null, `${this.seriesLabel(ch.seriesId)} · ${ch.done ? t('career.champ.final') : t('career.champ.standings')}`), this.standingsTable(ch), this.calendar(ch));
      if (ch.done) body.push(el('div', { class: 'info' }, t('career.champ.done', { pos: ch.finalPos ?? '-' })));
      else {
        const ev = eventChamp(c)!;
        body.push(el('div', { class: 'info' }, t('career.champ.next', { n: ch.round + 1, gp: TRACK_BY_ID[ev.trackId].gp }), el('div', { class: 'muted' }, `${t('weather.' + ev.weather)} · ${t('career.lapsN', { n: ev.laps })}`)));
      }
    }
    const next = c.champ && !c.champ.done ? el('button', { class: 'btn primary', onclick: () => this.host.startEvent(c, eventChamp(c)!) }, t('career.champ.race')) : null;
    this.show({ el: panel('career', ...body, el('div', { class: 'actions' }, this.back(), next)) });
  }

  openTourn(): void {
    const c = this.c!;
    const body: (Node | null)[] = [el('h2', null, t('career.tourn.title')), el('p', { class: 'muted' }, t('career.tourn.info'))];
    let sid = unlockedSeries(clsOf(c), c.level).slice(-1)[0].id;
    if (!c.tourn) {
      const unlocked = unlockedSeries(clsOf(c), c.level);
      const sel = el('select', { onchange: (e: Event) => { sid = (e.target as HTMLSelectElement).value as SeriesId; } },
        ...unlocked.map((s) => el('option', { value: s.id, selected: s.id === sid }, this.seriesLabel(s.id))));
      body.push(field(t('career.series'), sel));
      for (const d of TOURNAMENTS) body.push(el('div', { class: 'erow' }, el('div', null, el('b', null, t('career.tourn.' + d.id)), el('small', null, ` · ${d.tracks.map((x) => TRACK_BY_ID[x].country).join(', ')}`)), el('span'),
        el('button', { class: 'btn small primary', onclick: () => { startTourn(c, d.id, sid); this.save(); this.openTourn(); } }, t('career.tourn.start'))));
    } else {
      const tn = c.tourn;
      body.push(el('h3', null, `${t('career.tourn.' + tn.id)} · ${this.seriesLabel(tn.seriesId)}`), this.standingsTable(tn, 12), this.calendar(tn));
      if (tn.done) body.push(el('div', { class: 'info' }, t('career.champ.done', { pos: tn.finalPos ?? '-' })));
    }
    const tn = c.tourn;
    const act = tn ? (tn.done
      ? el('button', { class: 'btn primary', onclick: () => { c.tourn = null; this.save(); this.openTourn(); } }, t('career.tourn.clear'))
      : el('button', { class: 'btn primary', onclick: () => this.host.startEvent(c, eventTourn(c)!) }, t('career.champ.race'))) : null;
    this.show({ el: panel('career', ...body, el('div', { class: 'actions' }, this.back(), act)) });
  }

  // ------------------------------------------------------------ voľné preteky a základný okruh
  openRegular(): void {
    const c = this.c!;
    let sid = unlockedSeries(clsOf(c), c.level).slice(-1)[0].id;
    let track = TRACKS[1].id;
    let weather: WeatherMode = 'dry';
    const sel = el('select', { onchange: (e: Event) => { sid = (e.target as HTMLSelectElement).value as SeriesId; } },
      ...unlockedSeries(clsOf(c), c.level).map((s) => el('option', { value: s.id, selected: s.id === sid }, this.seriesLabel(s.id))));
    const tsel = el('select', { onchange: (e: Event) => { track = (e.target as HTMLSelectElement).value; } },
      ...TRACKS.map((x) => el('option', { value: x.id, selected: x.id === track }, x.round ? `${String(x.round).padStart(2, '0')} · ${x.name}` : `★ ${x.name}`)));
    this.show({
      el: panel('career',
        el('h2', null, t('career.regular.title')), el('p', { class: 'muted' }, t('career.regular.info')),
        field(t('career.series'), sel), field(t('career.regular.track'), tsel),
        field(t('career.regular.weather'), segmented<WeatherMode>((['dry', 'dynamic', 'rain'] as const).map((d) => ({ value: d, label: t('weather.' + d) })), weather, (v) => { weather = v; })),
        el('div', { class: 'actions' }, this.back(), el('button', { class: 'btn primary', onclick: () => this.host.startEvent(c, eventRegular(c, sid, track, weather)) }, t('career.regular.start')))),
    });
  }

  openBase(): void {
    const c = this.c!;
    const ev = eventBase(c);
    this.show({
      el: panel('career', el('h2', null, t('career.base.title')), el('p', { class: 'muted' }, t('career.hub.sub.base')),
        el('div', { class: 'info' }, el('b', null, TRACK_BY_ID[ev.trackId].gp), el('div', { class: 'muted' }, `${t('career.lapsN', { n: ev.laps })} · ${t('weather.dry')}`)),
        el('div', { class: 'actions' }, this.back(), el('button', { class: 'btn primary', onclick: () => this.host.startEvent(c, ev) }, t('career.regular.start')))),
    });
  }

  // ------------------------------------------------------------ garáž
  openShop(): void {
    const c = this.c!;
    const team = teamOf(c);
    const up = c.upgrades[c.teamId];
    const fx = (key: UpgradeKey, lvl: number) => upgradeEffects(key, lvl).map((e) => `${e.pct > 0 ? '+' : ''}${e.pct} % ${t('fx.' + e.id)}`).join(', ') || t('fx.none');
    const rows = UPGRADE_KEYS.map((key) => {
      const lvl = up[key];
      const price = upgradePrice(key, lvl, clsOf(c));
      const pips = el('div', { class: 'pips' }, ...Array.from({ length: MAX_UPGRADE }, (_, i) => el('i', { class: i < lvl ? 'on' : '' })));
      return el('div', { class: 'shoprow' },
        el('div', null, el('b', null, t('upg.' + key)), el('div', { class: 'muted' }, lvl ? fx(key, lvl) : t('fx.none')), pips),
        el('div', { class: 'muted nextfx' }, price == null ? t('career.shop.max') : t('career.shop.next', { fx: fx(key, lvl + 1) })),
        price == null ? el('span', { class: 'muted' }, t('career.shop.max'))
          : el('button', { class: 'btn small primary', disabled: c.coins < price, title: c.coins < price ? t('career.shop.noCoins') : '', onclick: () => { if (buyUpgrade(c, key)) { this.save(); this.openShop(); } } },
            t('career.shop.buy', { price })));
    });
    this.show({
      el: panel('career', el('h2', null, t('career.shop.title')),
        el('p', null, t('career.shop.car', { car: `${CAR_MODEL_BY_ID[team.car].brand} ${CAR_MODEL_BY_ID[team.car].name}` })),
        el('p', { class: 'coinsline' }, t('career.shop.coins', { n: c.coins })),
        ...rows, el('p', { class: 'muted' }, t('career.shop.info')), el('div', { class: 'actions' }, this.back())),
    });
  }

  // ------------------------------------------------------------ rebríček
  openBoard(back: () => void): void {
    const store = this.host.store;
    const own = store.list().map((m) => store.load(m.id)).filter((x): x is Career => !!x)
      .map((x) => ({ name: x.profile.nickname || x.profile.name, country: x.profile.country, level: x.level, teamId: x.teamId, id: x.id }));
    const lb = leaderboard(own, this.c?.id ?? null);
    const shown = lb.slice(0, 30);
    const mine = lb.filter((r) => r.self && !shown.includes(r));
    this.show({
      el: panel('career', el('h2', null, t('career.board.title')), el('p', { class: 'muted' }, t('career.board.note')),
        el('div', { class: 'tablewrap' }, el('table', { class: 'results' },
          el('thead', null, el('tr', null, ...[t('career.board.rank'), t('career.board.player'), t('career.board.country'), t('career.board.team'), t('career.board.level')].map((h) => el('th', null, h)))),
          el('tbody', null, ...[...shown, ...mine].map((r) => el('tr', { class: r.self ? 'me' : '' },
            el('td', { class: 'n' }, r.rank), el('td', null, r.name, r.self ? ` (${t('career.board.you')})` : ''), el('td', { class: 'muted' }, countryName(r.country)), el('td', { class: 'muted' }, r.team), el('td', { class: 'n' }, r.level)))))),
        el('div', { class: 'actions' }, el('button', { class: 'btn ghost', onclick: back }, t('menu.back')))),
    });
  }

  // ------------------------------------------------------------ ponuky po sezóne
  openOffers(): void {
    const c = this.c!;
    const offers = c.offers ?? [];
    const last = c.history[c.history.length - 1];
    const cards = offers.map((o, i) => {
      const tm = TEAM_BY_ID[o.teamId];
      const car = CAR_MODEL_BY_ID[tm.car];
      return el('div', { class: 'offer ' + o.kind, style: `--team:${tm.color}` },
        el('small', null, t('career.offers.' + o.kind)),
        el('h3', null, tm.name),
        el('div', null, t('career.offers.car', { car: `${car.brand} ${car.name}` })),
        el('div', { class: 'muted' }, t('career.offers.signing', { n: o.signing })),
        el('div', { class: 'muted' }, t('career.offers.goal', { goal: goalText(o.goal) }), ' · ', t('goal.reward', { n: o.goal.reward })),
        el('button', { class: 'btn small primary', onclick: () => { acceptOffer(c, i); this.save(); this.openHub(); } }, o.kind === 'stay' ? t('career.offers.stay') : t('career.offers.accept')));
    });
    this.show({
      el: panel('career', el('h2', null, t('career.offers.title', { n: c.season })), el('p', { class: 'muted' }, t('career.offers.info')),
        last?.finalPos != null ? el('p', null, t('career.offers.history', { pos: last.finalPos, level: last.levelEnd })) : el('p', null, t('career.offers.noChamp')),
        el('div', { class: 'offers' }, ...cards), el('p', { class: 'muted' }, t('career.offers.upgradesKept'))),
    });
  }

  // ------------------------------------------------------------ 24-hodinovka
  openEndurance(): void {
    const c = this.c!;
    const ev = eventEndurance(c);
    const tr = TRACK_BY_ID[ev.trackId];
    this.show({
      el: panel('career',
        el('h2', null, t('career.endurance.title')),
        el('p', null, t('career.endurance.info', { min: ENDURANCE_MIN, cars: ev.opponents + 1 })),
        el('div', { class: 'erow' }, el('b', null, tr.gp), el('div', { class: 'muted' }, `${t('weather.' + ev.weather)} · ${t('diff.' + ev.difficulty)}`)),
        el('p', { class: 'muted' }, t('career.endurance.rules')),
        el('p', { class: 'note' }, t('career.endurance.once')),
        el('div', { class: 'actions' }, this.back(), el('button', { class: 'btn primary', onclick: () => this.host.startEvent(c, ev) }, t('career.endurance.start')))),
    });
  }

  // ------------------------------------------------------------ po pretekoch
  finishRace(ev: CareerEvent, rows: ResultRow[], retired = false): RaceOutcome {
    const c = this.c!;
    const out = applyResult(c, ev, rows, retired);
    this.save();
    return out;
  }
}
