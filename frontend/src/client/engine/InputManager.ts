/**
 * InputManager
 *
 * Engine-level abstraction over keyboard + mouse state.
 * Knows nothing about game rules — just tracks what's pressed / where the cursor is.
 */

export interface MouseState {
  x: number;
  y: number;
  down: boolean;
}

export class InputManager {
  readonly keys = new Set<string>();
  readonly mouse: MouseState = { x: 0, y: 0, down: false };

  private readonly canvas: HTMLCanvasElement;

  // Bound references so we can cleanly remove listeners on dispose.
  private readonly onKeyDown:    (e: KeyboardEvent) => void;
  private readonly onKeyUp:      (e: KeyboardEvent) => void;
  private readonly onMouseMove:  (e: MouseEvent) => void;
  private readonly onMouseDown:  (e: MouseEvent) => void;
  private readonly onMouseUp:    (e: MouseEvent) => void;
  private readonly onCtxMenu:    (e: Event) => void;

  /** Keys that should not trigger default browser behaviour (scrolling, etc.). */
  private static readonly SUPPRESSED_KEYS = new Set([
    'w', 'a', 's', 'd',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
    ' ',
  ]);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.onKeyDown = (e) => {
      const key = e.key.toLowerCase();
      this.keys.add(key);
      if (InputManager.SUPPRESSED_KEYS.has(key)) e.preventDefault();
    };

    this.onKeyUp = (e) => {
      this.keys.delete(e.key.toLowerCase());
    };

    this.onMouseMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - rect.left;
      this.mouse.y = e.clientY - rect.top;
    };

    this.onMouseDown = (e) => {
      if (e.button === 0) this.mouse.down = true;
    };

    this.onMouseUp = (e) => {
      if (e.button === 0) this.mouse.down = false;
    };

    this.onCtxMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup',   this.onKeyUp);
    canvas.addEventListener('mousemove',  this.onMouseMove);
    canvas.addEventListener('mousedown',  this.onMouseDown);
    canvas.addEventListener('mouseup',    this.onMouseUp);
    canvas.addEventListener('contextmenu', this.onCtxMenu);
  }

  isKeyDown(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  /** Removes all listeners — call when tearing down the game. */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup',   this.onKeyUp);
    this.canvas.removeEventListener('mousemove',   this.onMouseMove);
    this.canvas.removeEventListener('mousedown',   this.onMouseDown);
    this.canvas.removeEventListener('mouseup',     this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onCtxMenu);
  }
}
