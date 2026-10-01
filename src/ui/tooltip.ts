import { colorOf } from '../config';
import type { DisasterEvent } from '../data/types';
import { $, esc } from './dom';
import { fmtUtc, fmtWhen, typeName } from './format';

export class Tooltip {
  private el = $('#tooltip');
  private currentId: string | null = null;

  show(e: DisasterEvent, x: number, y: number) {
    if (this.currentId !== e.id) {
      this.currentId = e.id;
      const alert = e.alert && e.alert !== 'green' ? `<span class="chip chip-${e.alert}">${e.alert} alert</span>` : '';
      this.el.innerHTML = `
        <div class="tt-type" style="--c:${colorOf(e.type)}"><i class="dot" aria-hidden="true"></i>${esc(typeName(e))}${alert}</div>
        <div class="tt-title">${esc(e.title)}</div>
        <div class="tt-meta">${esc(e.country ?? 'Location not tagged')}</div>
        ${e.magnitudeLabel ? `<div class="tt-meta mono">${esc(e.magnitudeLabel)}</div>` : ''}
        <div class="tt-meta mono dim">${esc(fmtWhen(e))} · ${esc(fmtUtc(e.t0, false))}</div>`;
    }
    this.el.hidden = false;
    const pad = 16;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = x + pad + w > vw - 8 ? x - pad - w : x + pad;
    const top = y + pad + h > vh - 8 ? y - pad - h : y + pad;
    this.el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }

  hide() {
    this.currentId = null;
    this.el.hidden = true;
  }
}
