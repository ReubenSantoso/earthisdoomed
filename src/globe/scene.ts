import * as THREE from 'three';

export type FrameFn = (dt: number, time: number) => void;

/** Renderer, scene, camera and the single animation loop. */
export class SceneHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  width = 1;
  height = 1;
  /** Horizontal shift of the globe in CSS px, so side panels never cover the focus. */
  private viewShift = 0;
  private frames = new Set<FrameFn>();
  private last = performance.now();
  private visible = true;
  private onscreen = true;

  constructor(
    canvas: HTMLCanvasElement,
    private host: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x050709, 1);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 4000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xdce6f0, 1.4);
    key.position.set(-0.8, 0.9, 0.6);
    this.camera.add(key);
    this.scene.add(this.camera);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    document.addEventListener('visibilitychange', () => {
      this.visible = document.visibilityState === 'visible';
      this.last = performance.now();
    });
    new IntersectionObserver(([entry]) => {
      this.onscreen = entry.isIntersecting;
      this.last = performance.now();
    }).observe(host);

    requestAnimationFrame(this.tick);
  }

  onFrame(fn: FrameFn): () => void {
    this.frames.add(fn);
    return () => this.frames.delete(fn);
  }

  get pixelRatio() {
    return this.renderer.getPixelRatio();
  }

  setViewShift(px: number) {
    if (Math.abs(px - this.viewShift) < 0.25) return;
    this.viewShift = px;
    this.applyProjection();
  }

  private applyProjection() {
    const { width: w, height: h } = this;
    this.camera.aspect = w / h;
    if (Math.abs(this.viewShift) > 0.5) this.camera.setViewOffset(w, h, -this.viewShift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    this.renderer.setSize(this.width, this.height, false);
    this.applyProjection();
  }

  /** Advance and draw one frame by hand (dev tooling: lets tests drive a hidden tab). */
  step(dt: number) {
    const t = performance.now();
    for (const fn of this.frames) fn(dt, t / 1000);
    this.renderer.render(this.scene, this.camera);
  }

  private tick = (t: number) => {
    requestAnimationFrame(this.tick);
    if (!this.visible || !this.onscreen) return;
    const dt = Math.min(0.05, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    for (const fn of this.frames) fn(dt, t / 1000);
    this.renderer.render(this.scene, this.camera);
  };
}
