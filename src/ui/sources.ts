import type { State } from '../data/store';
import { STREAMS, type StreamInfo, type StreamStatus } from '../data/streams';
import { esc, safeUrl } from './dom';
import { fmtCount, fmtRelative } from './format';

function stateText(info: StreamInfo, st: StreamStatus): string {
  switch (st.state) {
    case 'idle':
      return info.idleText;
    case 'loading':
      return st.count ? `loading · ${fmtCount(st.count)} ${info.unit} so far` : 'loading';
    case 'error': {
      const msg = st.message ? ` · ${st.message.length > 90 ? `${st.message.slice(0, 87)}…` : st.message}` : '';
      return `unavailable${msg}`;
    }
    case 'ok':
      return [
        st.count != null ? `${fmtCount(st.count)} ${info.unit}` : '',
        st.detail ?? '',
        st.updatedAt ? `updated ${fmtRelative(st.updatedAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
  }
}

const STATE_LABEL: Record<StreamStatus['state'], string> = {
  idle: 'Idle',
  loading: 'Loading',
  ok: 'Connected',
  error: 'Unavailable',
};

/** The "Sources" tab: every stream the page reads, how, how often, and what it is doing now. */
export function renderSources(el: HTMLElement, s: State) {
  const groups = new Map<string, StreamInfo[]>();
  for (const info of STREAMS) {
    const list = groups.get(info.provider);
    if (list) list.push(info);
    else groups.set(info.provider, [info]);
  }

  el.innerHTML = `
    <p class="src-intro">Every data stream this page reads. All are free and public, none needs a key, and each one fails on its own without taking the page down.</p>
    ${[...groups.entries()]
      .map(
        ([provider, list]) => `
      <section class="src-group" aria-label="${esc(provider)}">
        <h3 class="src-provider">${esc(provider)}</h3>
        ${list
          .map((info) => {
            const st = s.streams[info.id];
            const docs = safeUrl(info.docs);
            return `
          <article class="src" data-state="${st.state}">
            <header class="src-head">
              <span class="src-dot" aria-hidden="true"></span>
              <h4>${esc(info.name)}</h4>
            </header>
            <p class="src-state mono"><span class="sr-only">${STATE_LABEL[st.state]}: </span>${esc(stateText(info, st))}</p>
            <p class="src-provides">${esc(info.provides)}</p>
            <code class="src-endpoint">${esc(info.endpoint)}</code>
            <dl class="src-facts">
              <dt>Refresh</dt><dd>${esc(info.cadence)}</dd>
              <dt>Access</dt><dd>${esc(info.access)}</dd>
            </dl>
            ${docs ? `<a class="src-docs" href="${esc(docs)}" target="_blank" rel="noopener">Documentation<span aria-hidden="true"> ↗</span></a>` : ''}
          </article>`;
          })
          .join('')}
      </section>`,
      )
      .join('')}`;
}
