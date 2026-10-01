import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import type { Store } from '../data/store';

gsap.registerPlugin(ScrollTrigger);

/**
 * Scroll progress → continuous stage. Holds at 0 (planet), 1 (country) and 2 (event),
 * with linear transitions between; the camera eases on top of this.
 */
export function stageOf(p: number): number {
  if (p <= 0.1) return 0;
  if (p < 0.42) return (p - 0.1) / 0.32;
  if (p <= 0.58) return 1;
  if (p < 0.9) return 1 + (p - 0.58) / 0.32;
  return 2;
}

/** The pinned scroll section: planet → country → event. */
export class Descent {
  private st: ScrollTrigger;

  constructor(
    pin: HTMLElement,
    private store: Store,
  ) {
    const reduced = store.get().reducedMotion;
    const tl = gsap.timeline({ defaults: { ease: 'none' } });
    tl.to('#scroll-hint', { autoAlpha: 0, duration: 0.05 }, 0)
      .to('[data-caption="0"]', { autoAlpha: 0, y: -14, duration: 0.1 }, 0.03)
      .fromTo('[data-caption="1"]', { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.1 }, 0.3)
      .to('[data-caption="1"]', { autoAlpha: 0, y: -14, duration: 0.08 }, 0.64)
      .set({}, {}, 1);

    this.st = ScrollTrigger.create({
      trigger: pin,
      pin: true,
      start: 'top top',
      end: () => `+=${Math.round(window.innerHeight * 3)}`,
      animation: tl,
      scrub: reduced ? true : 0.4,
      snap: reduced
        ? undefined
        : { snapTo: [0, 0.5, 1], duration: { min: 0.25, max: 0.8 }, delay: 0.12, ease: 'power2.inOut' },
      invalidateOnRefresh: true,
      onUpdate: (self) => store.set({ stage: stageOf(self.progress) }),
    });
  }

  /** Scroll the page so the story rests on a stage. */
  scrollToStage(stage: 0 | 1 | 2) {
    const target = this.st.start + (this.st.end - this.st.start) * (stage / 2);
    if (Math.abs(window.scrollY - target) < 4) return;
    window.scrollTo({ top: target, behavior: this.store.get().reducedMotion ? 'auto' : 'smooth' });
  }
}
