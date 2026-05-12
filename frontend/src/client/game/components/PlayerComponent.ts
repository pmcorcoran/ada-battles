/**
 * PlayerComponent
 *
 * Pure data object representing a player's visual + gameplay state
 * on the client. Hydrated from PlayerDTO received over the network.
 */

import type { PlayerDTO } from '../../../shared/types';

export class PlayerComponent {
  slot: number;
  x: number;
  y: number;
  rotation: number;
  health: number;
  maxHealth: number;
  isEliminated: boolean;

  constructor(dto: PlayerDTO) {
    this.slot        = dto.slot;
    this.x           = dto.x;
    this.y           = dto.y;
    this.rotation    = dto.rotation;
    this.health      = dto.health;
    this.maxHealth   = dto.maxHealth;
    this.isEliminated = dto.isEliminated;
  }

  get isAlive(): boolean {
    return this.health > 0 && !this.isEliminated;
  }

  /** Merge an incoming DTO into this component (avoids re-allocation). */
  applyDTO(dto: PlayerDTO): void {
    this.x           = dto.x;
    this.y           = dto.y;
    this.rotation    = dto.rotation;
    this.health      = dto.health;
    this.maxHealth   = dto.maxHealth;
    this.isEliminated = dto.isEliminated;
  }
}
