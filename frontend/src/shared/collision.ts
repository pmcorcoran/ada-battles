/**
 * Collision — Circle-vs-Triangle hit testing
 *
 * Exact geometric test: does the bullet circle overlap the player
 * triangle? Matches the vertices drawn by RenderSystem exactly.
 */

import { PLAYER_BASE, PLAYER_SIDE, PLAYER_STROKE_WIDTH } from './constants';

interface Vec2 { x: number; y: number }

/**
 * Returns the three world-space vertices of a player's triangle,
 * matching the local-space geometry in RenderSystem.drawPlayer exactly.
 */
export function getPlayerTriangle(
  px: number, py: number, rotation: number,
): [Vec2, Vec2, Vec2] {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const halfBase = PLAYER_BASE / 2;

  // Local-space vertices (from RenderSystem):
  //   tip:   (PLAYER_SIDE, 0)
  //   left:  (-halfBase, -halfBase)
  //   right: (-halfBase,  halfBase)

  return [
    { x: px + PLAYER_SIDE * cos,              y: py + PLAYER_SIDE * sin },
    { x: px - halfBase * cos + halfBase * sin, y: py - halfBase * sin - halfBase * cos },
    { x: px - halfBase * cos - halfBase * sin, y: py - halfBase * sin + halfBase * cos },
  ];
}

/**
 * Returns the player triangle vertices inflated outward by half
 * the stroke width, matching the visible extent of the rendered shape.
 */
export function getPlayerHitTriangle(
  px: number, py: number, rotation: number,
): [Vec2, Vec2, Vec2] {
  const verts = getPlayerTriangle(px, py, rotation);

  const cx = (verts[0].x + verts[1].x + verts[2].x) / 3;
  const cy = (verts[0].y + verts[1].y + verts[2].y) / 3;

  const pad = PLAYER_STROKE_WIDTH / 2;

  return verts.map((v) => {
    const dx = v.x - cx;
    const dy = v.y - cy;
    const len = Math.hypot(dx, dy);
    return {
      x: v.x + (dx / len) * pad,
      y: v.y + (dy / len) * pad,
    };
  }) as [Vec2, Vec2, Vec2];
}

/**
 * Exact circle-vs-triangle intersection.
 * Returns true if a circle at (cx, cy) with radius r overlaps triangle ABC.
 */
export function circleTouchesTriangle(
  cx: number, cy: number, r: number,
  a: Vec2, b: Vec2, c: Vec2,
): boolean {
  const p = { x: cx, y: cy };

  // 1. Bullet center inside triangle — definite hit
  if (pointInTriangle(p, a, b, c)) return true;

  // 2. Bullet circle touches any edge
  if (distToSegment(p, a, b) < r) return true;
  if (distToSegment(p, b, c) < r) return true;
  if (distToSegment(p, c, a) < r) return true;

  return false;
}

/** Point-in-triangle via sign-of-cross-product. Works for any winding order. */
function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);

  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

  return !(hasNeg && hasPos);
}

function sign(p1: Vec2, p2: Vec2, p3: Vec2): number {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

/** Shortest distance from point P to line segment AB. */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;

  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(apx, apy);

  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq));

  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}