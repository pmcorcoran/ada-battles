/**
 * HUDSystem
 *
 * Owns all DOM-based UI overlays (health bar, reload bar, message popup, player count).
 * Keeps DOM manipulation out of the canvas render path.
 */

export class HUDSystem {
  private healthFill:    HTMLElement | null;
  private healthText:    HTMLElement | null;
  private reloadFill:    HTMLElement | null;
  private messageEl:     HTMLElement | null;
  private playerCountEl: HTMLElement | null;

  constructor() {
    this.healthFill    = document.getElementById('healthFill');
    this.healthText    = document.getElementById('healthText');
    this.reloadFill    = document.getElementById('reloadFill');
    this.messageEl     = document.getElementById('message');
    this.playerCountEl = document.getElementById('playerCount');
  }

  //  Health 

  updateHealth(current: number, max: number): void {
    if (!this.healthFill) return;
    const pct = (current / max) * 100;
    this.healthFill.style.width = `${pct}%`;

    this.healthFill.style.background =
      current <= 1
        ? 'linear-gradient(90deg, #ff9900, #ff6600)'
        : 'linear-gradient(90deg, #00ff00, #00cc00)';

    if (this.healthText) {
      this.healthText.textContent = current.toString();
    }
  }

  //  Reload 

  setReloadProgress(progress: number): void {
    if (this.reloadFill) {
      this.reloadFill.style.width = `${Math.min(progress, 1) * 100}%`;
    }
  }

  //  Center message 

  showMessage(html: string): void {
    if (this.messageEl) {
      this.messageEl.innerHTML = html;
      this.messageEl.style.display = 'block';
    }
  }

  hideMessage(): void {
    if (this.messageEl) {
      this.messageEl.style.display = 'none';
    }
  }

  //  Player count 

  updatePlayerCount(alive: number, max: number): void {
    if (this.playerCountEl) {
      this.playerCountEl.textContent = `Players: ${alive}/${max}`;
    }
  }
}
