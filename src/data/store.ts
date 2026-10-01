import type { StreamId, StreamStatus } from './streams';
import type { DisasterEvent, LegendGroup, RangeKey } from './types';

export interface State {
  /** Merged, deduplicated, geotagged events from every loaded live feed and history chunk. */
  events: DisasterEvent[];
  eventsVersion: number;
  /** Status of every data stream (live feeds, history, imagery, borders). */
  streams: Record<StreamId, StreamStatus>;
  lastLiveUpdate: number | null;
  firstLoadDone: boolean;

  filters: Record<LegendGroup, boolean>;

  range: RangeKey;
  /** End of the visible window, ms. */
  cursor: number;
  /** When true the cursor follows the wall clock. */
  live: boolean;
  playing: boolean;
  speed: number;
  historyLoading: { done: number; total: number; range: RangeKey } | null;
  historyNote: string | null;

  focusCountry: string | null;
  /** The user chose the country; auto-focus leaves it alone. */
  focusPinned: boolean;
  focusEventId: string | null;
  eventPinned: boolean;
  hoverId: string | null;

  /** Scroll depth, 0 = planet, 1 = country, 2 = event (continuous). */
  stage: number;
  railOpen: boolean;
  railUserSet: boolean;
  railTab: 'countries' | 'sources';
  reducedMotion: boolean;
}

export type Key = keyof State;
type Listener = (state: State, changed: ReadonlySet<Key>) => void;

export interface Store {
  get(): State;
  set(patch: Partial<State>): void;
  subscribe(keys: Key[] | null, fn: Listener): () => void;
}

/** A tiny observable store. Changes are batched per microtask. */
export function createStore(initial: State): Store {
  let state = initial;
  let pending = new Set<Key>();
  let scheduled = false;
  const listeners = new Set<{ keys: Set<Key> | null; fn: Listener }>();

  const flush = () => {
    scheduled = false;
    const changed = pending;
    pending = new Set();
    for (const l of listeners) {
      if (!l.keys || [...changed].some((k) => l.keys!.has(k))) l.fn(state, changed);
    }
  };

  return {
    get: () => state,
    set(patch) {
      let dirty = false;
      for (const k of Object.keys(patch) as Key[]) {
        if (!Object.is(state[k], patch[k])) {
          pending.add(k);
          dirty = true;
        }
      }
      if (!dirty) return;
      state = { ...state, ...patch };
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    subscribe(keys, fn) {
      const entry = { keys: keys ? new Set(keys) : null, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
  };
}
