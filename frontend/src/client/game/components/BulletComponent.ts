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
  prevX: number;
  prevY: number;
  rotation: number;
  startX: number;
  startY: number;

  constructor(dto: BulletDTO) {
    this.id        = dto.id;
    this.ownerSlot = dto.ownerSlot;
    this.x         = dto.x;
    this.y         = dto.y;
    this.prevX     = dto.prevX;
    this.prevY     = dto.prevY;
    this.rotation  = dto.rotation;
    this.startX    = dto.startX;
    this.startY    = dto.startY;
  }

  applyDTO(dto: BulletDTO): void {
    this.prevX     = dto.prevX;
    this.prevY     = dto.prevY;
    this.x        = dto.x;
    this.y        = dto.y;
    this.startX   = dto.startX;
    this.startY   = dto.startY;
    this.rotation = dto.rotation;
  }
}
