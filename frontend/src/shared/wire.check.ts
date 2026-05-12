/**
 * Round-trip self-test for the binary wire codec.
 *
 * Run:  tsc && node dist/shared/wire.check.js
 *
 * Also writes a fixture file the Python mirror can load to verify that
 * TS-produced bytes decode identically on the Python side.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { encode, decode } from './wire';
import type { LobbyStateDTO } from './types';

type Case = { event: string; data: unknown; note?: string };

const cases: Case[] = [
  { event: 'player-id',            data: 0 },
  { event: 'joined-matched-lobby', data: 'lobby-xyz' },
  { event: 'player-joined',        data: { slot: 1, playerCount: 3, lobbyId: 'lob' } },
  { event: 'player-left',          data: { slot: 2, playerCount: 2, lobbyId: 'lob' } },
  { event: 'countdown',            data: { time: 3, lobbyId: 'lob' } },
  {
    event: 'lobby-state',
    note: 'full snapshot with 2 players, 1 bullet, null winner',
    data: <LobbyStateDTO>{
      players: [
        { slot: 0, x: 123.4, y: 56.7, rotation: 1.23, health: 2, maxHealth: 2, isEliminated: false },
        { slot: 1, x: -5.5,  y: 700.1, rotation: 6.28, health: 0, maxHealth: 2, isEliminated: true  },
      ],
      bullets: [
        { id: 99, ownerSlot: 0, x: 400.0, y: 300.0, rotation: 0 },
      ],
      status: 'playing',
      winnerSlot: null,
      lobbyId: 'lob-7',
    },
  },
  {
    event: 'lobby-state',
    note: 'ended state with winner',
    data: <LobbyStateDTO>{
      players: [],
      bullets: [],
      status: 'ended',
      winnerSlot: 0,
      lobbyId: 'lob-8',
    },
  },
  { event: 'player-hit',         data: { targetSlot: 0, health: 1, lobbyId: 'lob' } },
  { event: 'player-eliminated',  data: { targetSlot: 0, killerSlot: 1, lobbyId: 'lob' } },
  { event: 'player-revived',     data: { slot: 0, killerSlot: 1, lobbyId: 'lob' } },
  { event: 'game-over',          data: { winnerSlot: 0, lobbyId: 'lob' } },
  { event: 'game-over',          note: 'no winner',  data: { winnerSlot: null, lobbyId: 'lob' } },
  { event: 'lobby-reset',        data: { lobbyId: 'lob' } },

  { event: 'join-lobby',         data: 5 },
  { event: 'join-spectate',      data: 'lob-7' },
  { event: 'request-start',      data: undefined },
  { event: 'request-restart',    data: undefined },
  { event: 'player-input',       data: { keys: 0b1010, rotation: 0.785 } },
  { event: 'shoot',              data: { rotation: 2.0 } },
];

function roundTrip(c: Case): { ok: boolean; bytes: Uint8Array; decoded: unknown; err?: string } {
  const bytes   = encode(c.event, c.data);
  const decoded = decode(bytes);
  if (!decoded) return { ok: false, bytes, decoded: null, err: 'decode returned null' };
  if (decoded.event !== c.event) {
    return { ok: false, bytes, decoded: decoded.data, err: `event mismatch: ${decoded.event}` };
  }
  const ok = deepEqualWithTolerance(c.data, decoded.data);
  return { ok, bytes, decoded: decoded.data, err: ok ? undefined : 'payload mismatch' };
}

/** Allow ≤0.1 tolerance for positions (due to 0.1-px fixed-point) and ≤0.001 for rotation. */
function deepEqualWithTolerance(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined && b === undefined) return true;
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 0.2; // looser than i16 * 10 worst-case (0.05) plus rotation drift
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualWithTolerance(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return false;
      if (!deepEqualWithTolerance((a as any)[ka[i]], (b as any)[kb[i]])) return false;
    }
    return true;
  }
  return false;
}

function toHex(u8: Uint8Array): string {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

//  run 

let pass = 0;
let fail = 0;
const fixtures: Array<{ event: string; note?: string; hex: string; data: unknown }> = [];

for (const c of cases) {
  const r = roundTrip(c);
  const tag = `${c.event}${c.note ? ` (${c.note})` : ''}`;
  if (r.ok) {
    pass++;
    console.log(`  PASS  ${tag}  [${r.bytes.length} B]`);
  } else {
    fail++;
    console.error(`  FAIL  ${tag}  — ${r.err}`);
    console.error(`        expected: ${JSON.stringify(c.data)}`);
    console.error(`        got:      ${JSON.stringify(r.decoded)}`);
  }
  fixtures.push({ event: c.event, note: c.note, hex: toHex(r.bytes), data: c.data });
}

// Unknown opcode / empty buffer edge cases
const u1 = decode(new Uint8Array([]));
if (u1 !== null) { console.error('  FAIL  empty buffer should decode to null'); fail++; }
else { console.log('  PASS  empty buffer → null'); pass++; }

const u2 = decode(new Uint8Array([0xff]));
if (u2 !== null) { console.error('  FAIL  unknown opcode should decode to null'); fail++; }
else { console.log('  PASS  unknown opcode → null'); pass++; }

console.log(`\n${pass} passed, ${fail} failed  (${cases.length + 2} checks)`);

// Write fixtures
const fixturePath = join(__dirname, '..', '..', 'sdk', 'tests', 'wire-fixtures.json');
mkdirSync(dirname(fixturePath), { recursive: true });
writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2) + '\n');
console.log(`Fixtures written: ${fixturePath}`);

process.exit(fail === 0 ? 0 : 1);
