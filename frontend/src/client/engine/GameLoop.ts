/**
 * GameLoop
 *
 * Drives the update → render cycle via requestAnimationFrame.
 * Delegates actual logic to a Scene interface so the loop itself
 * is game-agnostic and reusable.
 */

export interface Scene {
  /** Called once per frame with the elapsed seconds since last frame. */
  update(dt: number): void;
  /** Called once per frame after update. */
  render(ctx: CanvasRenderingContext2D): void;
}

export class GameLoop {
  private scene: Scene | null = null;
  private lastTimestamp = 0;
  private rafId = 0;
  private running = false;

  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.tick = this.tick.bind(this);
  }

  /** Swap the active scene (menu → lobby → gameplay, etc.). */
  setScene(scene: Scene): void {
    this.scene = scene;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimestamp = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick(timestamp: number): void {
    const dt = (timestamp - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestamp;

    if (this.scene) {
      this.scene.update(dt);
      this.scene.render(this.ctx);
    }

    if (this.running) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }
}
