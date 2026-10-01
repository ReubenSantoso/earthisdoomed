import { GROUPS, colorOf, groupCount } from '../config';
import type { CountryStat } from '../data/derive';
import type { State, Store } from '../data/store';
import type { DisasterEvent, LegendGroup } from '../data/types';
import { esc } from './dom';
import { fmtCount, fmtWhen } from './format';
import { renderSources } from './sources';

export interface RailActions {
  focusCountry(key: string): void;
  selectEvent(id: string, viaKeyboard: boolean): void;
  clearFocus(): void;
  hover(id: string | null): void;
}

type Tab = State['railTab'];

function typeBar(byGroup: Record<LegendGroup, number>): string {
  return `<span class="type-bar" aria-hidden="true">${GROUPS.filter((g) => byGroup[g.id])
    .map((g) => `<i style="flex:${byGroup[g.id]};background:${g.color}"></i>`)
    .join('')}</span>`;
}

function breakdownText(byGroup: Record<LegendGroup, number>): string {
  return GROUPS.filter((g) => byGroup[g.id])
    .map((g) => groupCount(g.id, byGroup[g.id]))
    .join(', ');
}

const SECTOR_ORDER = ['North', 'North-west', 'North-east', 'West', 'Central', 'East', 'South-west', 'South', 'South-east'];

/**
 * Left rail with two tabs:
 *  - Countries: searchable list grouped by region (every country and region reachable without
 *    scrolling the story), and a country view listing its events grouped by area.
 *  - Sources: every data stream the page reads.
 */
export class Rail {
  private tabs: Record<Tab, HTMLButtonElement>;
  private panels: Record<Tab, HTMLElement>;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private query = '';
  private collapsed = new Set<string>();
  private lastKey = '';
  private lastSourcesRender = 0;

  constructor(
    private el: HTMLElement,
    private store: Store,
    private actions: RailActions,
  ) {
    el.innerHTML = `
      <div class="rail-tabs" role="tablist" aria-label="Side panel">
        <button type="button" role="tab" class="rail-tab" id="tab-countries" aria-controls="panel-countries">Countries<span class="rail-tab-count mono" id="rail-count"></span></button>
        <button type="button" role="tab" class="rail-tab" id="tab-sources" aria-controls="panel-sources">Sources</button>
        <button type="button" class="rail-close" aria-label="Hide side panel" title="Hide panel">&times;</button>
      </div>
      <div class="rail-body">
        <div role="tabpanel" class="rail-panel" id="panel-countries" aria-labelledby="tab-countries">
          <div class="rail-search"><input type="search" placeholder="Search countries or regions" aria-label="Search countries or regions" autocomplete="off" spellcheck="false" /></div>
          <div class="rail-list"></div>
        </div>
        <div role="tabpanel" class="rail-panel rail-sources" id="panel-sources" aria-labelledby="tab-sources" hidden></div>
      </div>`;

    this.tabs = {
      countries: el.querySelector('#tab-countries')!,
      sources: el.querySelector('#tab-sources')!,
    };
    this.panels = {
      countries: el.querySelector('#panel-countries')!,
      sources: el.querySelector('#panel-sources')!,
    };
    this.list = el.querySelector('.rail-list')!;
    this.search = el.querySelector('input')!;

    for (const tab of ['countries', 'sources'] as Tab[]) {
      this.tabs[tab].addEventListener('click', () => {
        const s = this.store.get();
        if (s.railOpen && s.railTab === tab) this.store.set({ railOpen: false, railUserSet: true });
        else this.store.set({ railOpen: true, railTab: tab, railUserSet: true });
      });
    }
    el.querySelector('.rail-tabs')!.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'ArrowLeft' && ke.key !== 'ArrowRight') return;
      const next: Tab = this.store.get().railTab === 'countries' ? 'sources' : 'countries';
      this.store.set({ railOpen: true, railTab: next, railUserSet: true });
      this.tabs[next].focus();
      ke.preventDefault();
    });
    el.querySelector('.rail-close')!.addEventListener('click', () =>
      this.store.set({ railOpen: false, railUserSet: true }),
    );

    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.lastKey = '';
      this.onQuery?.();
    });

    this.list.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const country = t.closest<HTMLElement>('[data-country]');
      if (country) return this.actions.focusCountry(country.dataset.country!);
      const ev = t.closest<HTMLElement>('[data-event]');
      if (ev) return this.actions.selectEvent(ev.dataset.event!, (e as MouseEvent).detail === 0);
      if (t.closest('[data-back]')) return this.actions.clearFocus();
      const region = t.closest<HTMLElement>('[data-region]');
      if (region) {
        const name = region.dataset.region!;
        if (this.collapsed.has(name)) this.collapsed.delete(name);
        else this.collapsed.add(name);
        this.lastKey = '';
        this.onQuery?.();
      }
    });
    this.list.addEventListener('pointerover', (e) => {
      const ev = (e.target as HTMLElement).closest<HTMLElement>('[data-event]');
      this.actions.hover(ev ? ev.dataset.event! : null);
    });
    this.list.addEventListener('pointerleave', () => this.actions.hover(null));
    this.list.addEventListener('focusin', (e) => {
      const ev = (e.target as HTMLElement).closest<HTMLElement>('[data-event]');
      if (ev) this.actions.hover(ev.dataset.event!);
    });
  }

  /** Called when the search box or a region toggle needs a re-render. Wired by main. */
  onQuery?: () => void;

  applyChrome(s: State) {
    this.el.dataset.open = String(s.railOpen);
    for (const tab of ['countries', 'sources'] as Tab[]) {
      const selected = s.railTab === tab;
      this.tabs[tab].setAttribute('aria-selected', String(selected && s.railOpen));
      this.tabs[tab].tabIndex = selected ? 0 : -1;
      this.panels[tab].hidden = !selected;
    }
    this.tabs.countries.setAttribute('aria-expanded', String(s.railOpen && s.railTab === 'countries'));
    this.tabs.sources.setAttribute('aria-expanded', String(s.railOpen && s.railTab === 'sources'));
  }

  renderSources(s: State, force = false) {
    if (!s.railOpen || s.railTab !== 'sources') return;
    const now = performance.now();
    if (!force && now - this.lastSourcesRender < 900) return;
    this.lastSourcesRender = now;
    const scroll = this.panels.sources.scrollTop;
    renderSources(this.panels.sources, s);
    this.panels.sources.scrollTop = scroll;
  }

  update(s: State, stats: CountryStat[], focusStat: CountryStat | undefined, countryMode: boolean) {
    document.getElementById('rail-count')!.textContent = stats.length ? ` ${stats.length}` : '';
    const key = countryMode
      ? `c|${s.focusCountry}|${s.focusEventId}|${focusStat?.events.map((e) => e.id).join(',') ?? ''}`
      : `o|${this.query}|${[...this.collapsed].join(',')}|${stats.map((c) => `${c.key}:${c.count}:${c.region}`).join(',')}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const active = document.activeElement as HTMLElement | null;
    const restore = active && this.list.contains(active) ? this.focusKey(active) : null;
    const scroll = this.panels.countries.scrollTop;

    this.list.innerHTML = countryMode ? this.countryView(s, focusStat) : this.overview(stats);
    this.search.parentElement!.hidden = countryMode;

    if (restore) (this.list.querySelector(restore) as HTMLElement | null)?.focus({ preventScroll: true });
    this.panels.countries.scrollTop = countryMode && !restore ? 0 : scroll;
  }

  private focusKey(el: HTMLElement): string | null {
    const target = el.closest<HTMLElement>('[data-country],[data-event],[data-region],[data-back]');
    if (!target) return null;
    for (const attr of ['country', 'event', 'region']) {
      const v = target.dataset[attr];
      if (v != null) return `[data-${attr}="${CSS.escape(v)}"]`;
    }
    return '[data-back]';
  }

  private overview(stats: CountryStat[]): string {
    const q = this.query.trim().toLowerCase();
    const filtered = q
      ? stats.filter((c) => c.key.toLowerCase().includes(q) || c.region.toLowerCase().includes(q))
      : stats;
    if (!filtered.length) {
      return `<p class="rail-empty">${
        q ? `No country or region matching “${esc(this.query.trim())}” has events in this window.` : 'No events in this window.'
      }</p>`;
    }
    const regions = new Map<string, CountryStat[]>();
    for (const c of filtered) {
      const list = regions.get(c.region);
      if (list) list.push(c);
      else regions.set(c.region, [c]);
    }
    const ordered = [...regions.entries()].sort(
      (a, b) => b[1].reduce((n, c) => n + c.score, 0) - a[1].reduce((n, c) => n + c.score, 0),
    );
    return ordered
      .map(([region, list]) => {
        const collapsed = this.collapsed.has(region) && !q;
        const total = list.reduce((n, c) => n + c.count, 0);
        return `
        <section class="rail-region">
          <h3><button type="button" class="rail-region-btn" data-region="${esc(region)}" aria-expanded="${!collapsed}">
            <span>${esc(region)}</span><span class="mono dim">${list.length} ${list.length === 1 ? 'country' : 'countries'} · ${fmtCount(total)}</span>
          </button></h3>
          ${
            collapsed
              ? ''
              : `<ul>${list
                  .map(
                    (c) => `<li><button type="button" class="rail-country" data-country="${esc(c.key)}">
                      <span class="rc-name">${esc(c.key)}</span>
                      <span class="rc-count mono">${fmtCount(c.count)}</span>
                      ${typeBar(c.byGroup)}
                      <span class="sr-only">: ${esc(breakdownText(c.byGroup))}</span>
                    </button></li>`,
                  )
                  .join('')}</ul>`
          }
        </section>`;
      })
      .join('');
  }

  private countryView(s: State, stat: CountryStat | undefined): string {
    const name = s.focusCountry ?? '';
    const events = stat?.events ?? [];
    const head = `
      <div class="rail-country-head">
        <button type="button" class="rail-back" data-back>&larr; All countries</button>
        <h2>${esc(name)}</h2>
        <p class="mono dim">${fmtCount(events.length)} ${events.length === 1 ? 'event' : 'events'} in view${stat ? ` · ${esc(stat.region)}` : ''}</p>
        ${stat ? typeBar(stat.byGroup) : ''}
        ${
          stat
            ? `<p class="rail-breakdown">${GROUPS.filter((g) => stat.byGroup[g.id])
                .map(
                  (g) =>
                    `<span><i class="dot" style="--c:${g.color}" aria-hidden="true"></i>${esc(groupCount(g.id, stat.byGroup[g.id]))}</span>`,
                )
                .join('')}</p>`
            : ''
        }
      </div>`;
    if (!events.length) {
      return `${head}<p class="rail-empty">Nothing from ${esc(name)} in this window. Widen the timeline or re-enable filters.</p>`;
    }

    const groups = new Map<string, DisasterEvent[]>();
    for (const e of events) {
      const sector = e.sector ?? 'Unplaced';
      const list = groups.get(sector);
      if (list) list.push(e);
      else groups.set(sector, [e]);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
      const sev = b[1][0].severity - a[1][0].severity;
      return Math.abs(sev) > 0.001 ? sev : SECTOR_ORDER.indexOf(a[0]) - SECTOR_ORDER.indexOf(b[0]);
    });
    return (
      head +
      ordered
        .map(
          ([sector, list]) => `
        <section class="rail-group">
          <h3>${esc(sector)} <span class="mono dim">${list.length}</span></h3>
          <ul>${list
            .map((e) => {
              const active = e.id === s.focusEventId;
              const meta = [e.magnitudeLabel, fmtWhen(e)].filter(Boolean).join(' · ');
              return `<li><button type="button" class="rail-event${active ? ' is-active' : ''}" data-event="${esc(e.id)}"${
                active ? ' aria-current="true"' : ''
              }>
                <i class="dot" style="--c:${colorOf(e.type)}" aria-hidden="true"></i>
                <span class="re-title">${esc(e.title)}</span>
                <span class="re-meta mono">${esc(meta)}</span>
              </button></li>`;
            })
            .join('')}</ul>
        </section>`,
        )
        .join('')
    );
  }
}
