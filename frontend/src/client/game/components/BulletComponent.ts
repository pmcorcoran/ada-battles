/**
 * BulletComponent
 *
 * Pure data representing a projectile on the client.
 * Hydrated from BulletDTO each tick.
 */

import type { BulletDTO } from '../../../shared/types';

export class BulletComponent {
  id: number;
  ownerSlot: number;
  x: number;
  y: number;
  rotation: number;

  constructor(dto: BulletDTO) {
    this.id        = dto.id;
    this.ownerSlot = dto.ownerSlot;
    this.x         = dto.x;
    this.y         = dto.y;
    this.rotation  = dto.rotation;
  }

  applyDTO(dto: BulletDTO): void {
    this.x        = dto.x;
    this.y        = dto.y;
    this.rotation = dto.rotation;
  }
}
