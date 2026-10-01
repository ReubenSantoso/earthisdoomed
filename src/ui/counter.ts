import { gsap } from 'gsap';
import { $ } from './dom';
import { fmtCount, fmtUtc } from './format';

/** The big mono number. Counts up once on first data, then follows the window quietly. */
export class Counter {
  private num = $('#counter-num');
  private label = $('#counter-label');
  private shown = { n: 0 };
  private target = -1;
  private tween: gsap.core.Tween | null = null;
  private introDone = false;
  private introStarted = false;

  constructor(private reducedMotion: boolean) {}

  update(count: number, live: boolean, cursor: number, animate: boolean) {
    this.label.textContent = live ? 'events in the last 24 hours' : `events in the 24 hours to ${fmtUtc(cursor, false)}`;
    if (count === this.target) return;
    this.target = count;

    if (this.reducedMotion) return this.render(count);
    if (!this.introStarted) {
      this.introStarted = true;
      this.animateTo(count, 2.6, 'power3.out', () => (this.introDone = true));
      return;
    }
    if (!this.introDone) return; // the intro catches up to the latest target when it ends
    if (animate) this.animateTo(count, 0.6, 'power2.out');
    else {
      this.tween?.kill();
      this.render(count);
    }
  }

  /** Every feed failed and nothing is loaded: say so rather than claiming zero events. */
  unavailable() {
    this.tween?.kill();
    this.target = -1;
    this.introStarted = false;
    this.introDone = false;
    this.shown.n = 0;
    this.num.textContent = '—';
    this.label.textContent = 'feeds unavailable';
  }

  private animateTo(n: number, duration: number, ease: string, done?: () => void) {
    this.tween?.kill();
    this.tween = gsap.to(this.shown, {
      n,
      duration,
      ease,
      onUpdate: () => this.render(this.shown.n, false),
      onComplete: () => {
        done?.();
        if (Math.round(this.shown.n) !== this.target) this.animateTo(this.target, 0.4, 'power2.out');
      },
    });
  }

  private render(n: number, sync = true) {
    if (sync) this.shown.n = n;
    this.num.textContent = fmtCount(n);
  }
}
