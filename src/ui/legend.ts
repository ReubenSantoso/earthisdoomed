import { GROUPS } from '../config';
import type { Store } from '../data/store';
import type { LegendGroup } from '../data/types';
import { esc } from './dom';
import { fmtCount } from './format';

/** Thin legend by type that doubles as the filter. Shift- or alt-click shows one type only. */
export class Legend {
  constructor(
    private el: HTMLElement,
    private store: Store,
  ) {
    el.innerHTML =
      GROUPS.map(
        (g) => `<button type="button" class="legend-item" data-group="${g.id}" aria-pressed="true" style="--c:${g.color}"
          title="Show or hide ${esc(g.label.toLowerCase())}. Shift-click to show only this type.">
          <i class="dot" aria-hidden="true"></i><span class="legend-label">${esc(g.label)}</span><span class="legend-count mono">0</span>
        </button>`,
      ).join('') + `<span class="sr-only" aria-live="polite" id="legend-live"></span>`;

    el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.legend-item');
      if (!btn) return;
      const id = btn.dataset.group as LegendGroup;
      const filters = { ...this.store.get().filters };
      if (e.shiftKey || e.altKey) {
        const alreadySolo = GROUPS.every((g) => filters[g.id] === (g.id === id));
        for (const g of GROUPS) filters[g.id] = alreadySolo ? true : g.id === id;
      } else {
        filters[id] = !filters[id];
      }
      this.store.set({ filters });
      const shown = GROUPS.filter((g) => filters[g.id]).map((g) => g.label.toLowerCase());
      document.getElementById('legend-live')!.textContent = shown.length
        ? `Showing ${shown.join(', ')}`
        : 'All event types hidden';
    });
  }

  update(counts: Record<LegendGroup, number>, filters: Record<LegendGroup, boolean>) {
    for (const btn of this.el.querySelectorAll<HTMLButtonElement>('.legend-item')) {
      const id = btn.dataset.group as LegendGroup;
      btn.setAttribute('aria-pressed', String(filters[id]));
      btn.querySelector('.legend-count')!.textContent = fmtCount(counts[id]);
    }
  }
}
