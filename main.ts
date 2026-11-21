// Sokoban solver: push-optimal, room by room.
//
// Every level the generator draws is a hallway with one to four rooms off
// it, and a box pushed out of a room is lost, so each room is its own
// problem: the level's push-optimal count is the sum of its rooms' optima.
// This program cuts a level into its rooms (the dead squares of the
// player's row come out of the floor, and each part left that holds a box
// is a room), solves each room on its own with a push-optimal A* over box
// configurations, and stitches the rooms' push sequences together with the
// player's walks between doors.
//
// The search: a state is the boxes' squares and the player's reachable
// region (named by its lowest square). A step costs one push. The estimate
// is the cheapest assignment of boxes to goals, where one box's cost is
// the fewest pushes it needs alone (other boxes ignored), so the estimate
// never overshoots and the first solved state the search takes off the
// open list is push-optimal. Two deadlocks are pruned, both safe: a box on
// a square no lone push can ever leave toward a goal, and a frozen 2 x 2
// block of walls and boxes holding a box off its goal.
//
// The budget is work, never the clock: a fixed number of expansions for
// the whole run, split across rooms and across three phases per room
// (plain A*, then a weighted A*, then a breadth-first search), so two
// executions write the same bytes. No randomness, no clock, no
// environment read except the input and output directories.
//
// Original work, written for this competition. It leans on no solver
// but the textbook: A* (Hart, Nilsson and Raphael, 1968) over pushes,
// the assignment bound, and the two deadlock prunes above.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Expansions for the whole run, every instance together. */
const TOTAL_BUDGET = 1_000_000;
/** Expansions one room may spend across its three phases. */
const PER_ROOM_CAP = 150_000;

/** The four steps: up, down, left, right. */
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

interface Budget {
  left: number;
}

interface RoomSolution {
  pushes: number;
  moves: string;
  endPlayer: number;
}

/** A level in XSB (# wall, space floor, . goal, $ box, * box on a goal, @ the player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a lone box can be pushed from onto a goal, and, for each
 * goal, the fewest lone pushes from every square to it. A lone push moves
 * a box one square and needs the square behind it open floor, other boxes
 * ignored, so these distances never overshoot the true push counts.
 */
function liveAndDist(
  w: number,
  h: number,
  wall: Uint8Array,
  goals: number[],
): { live: Uint8Array; dist: Int32Array[] } {
  const size = w * h;
  const live = new Uint8Array(size);
  const dist: Int32Array[] = [];
  for (const g of goals) {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (let k = 0; k < 4; k++) {
        const dd = DY[k] * w + DX[k];
        const y = x - dd;
        const behind = y - dd;
        if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
        if (wall[y] || wall[behind] || d[y] >= 0) continue;
        d[y] = d[x] + 1;
        queue.push(y);
      }
    }
    dist.push(d);
    for (let i = 0; i < size; i++) if (d[i] >= 0) live[i] = 1;
  }
  return { live, dist };
}

/**
 * The level's rooms: the dead squares of the player's row (the hallway: a
 * box there reaches no goal) come out of the floor, and each part left
 * that holds a box is a room. Null when some part holds more or fewer
 * boxes than goals, a goal stands in the cut, or a box starts in the
 * hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const { live } = liveAndDist(w, h, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DY[k] * w + DX[k];
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters, or null. */
function walkTo(
  w: number,
  h: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const size = w * h;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = LETTER[k];
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/**
 * One push-optimal search over a room: the board `wall` (other rooms'
 * boxes already walls), this room's `goals` and `boxes`, the player at
 * `player`. `weight` 1 is A*, 0 is breadth-first, anything else a
 * weighted A*. `phaseCap` bounds this phase's expansions; `budget` bounds
 * the whole run. Null when the phase gives up.
 */
function searchRoom(
  w: number,
  h: number,
  wall: Uint8Array,
  goals: number[],
  boxes: number[],
  player: number,
  budget: Budget,
  phaseCap: number,
  weight: number,
): RoomSolution | null {
  const size = w * h;
  const n = boxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const { live, dist } = liveAndDist(w, h, wall, goals);
  const startBoxes = boxes.slice().sort((a, b) => a - b);
  if (startBoxes.some((b) => !live[b])) return null;
  if (startBoxes.every((b) => goalSet[b])) return { pushes: 0, moves: '', endPlayer: player };

  // The cheapest assignment of boxes to goals, from the lone-push
  // distances: Infinity when no assignment reaches every goal.
  const popcount = (m: number): number => {
    let c = 0;
    while (m > 0) {
      c += m & 1;
      m >>= 1;
    }
    return c;
  };
  const heuristic = (bs: number[]): number => {
    if (n <= 6) {
      const total = 1 << n;
      const dp = new Float64Array(total).fill(Infinity);
      dp[0] = 0;
      for (let mask = 0; mask < total; mask++) {
        const k = popcount(mask);
        if (k >= n || dp[mask] === Infinity) continue;
        for (let j = 0; j < n; j++) {
          if (mask & (1 << j)) continue;
          const v = dist[j][bs[k]];
          if (v < 0) continue;
          const nm = mask | (1 << j);
          const nv = dp[mask] + v;
          if (nv < dp[nm]) dp[nm] = nv;
        }
      }
      return dp[total - 1];
    }
    let sum = 0;
    for (const b of bs) {
      let best = Infinity;
      for (let j = 0; j < n; j++) {
        const v = dist[j][b];
        if (v >= 0 && v < best) best = v;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  };

  // Whether the box just pushed to `t` sits in a frozen 2 x 2 block of
  // walls and boxes holding a box off its goal.
  const frozenBlock = (t: number, occupied: Uint8Array): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      if (a < 0 || a % w === w - 1 || a + w + 1 >= size) continue;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) || (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
    }
    return false;
  };

  const useNumericKey = n <= 5;
  const keyOf = (bs: number[], low: number): number | string => {
    if (!useNumericKey) return low + '|' + bs.join(',');
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };

  // The states in the order found: boxes, player square, parent, the
  // push that made them, pushes so far, key, estimate and f.
  const sBoxes: number[][] = [startBoxes];
  const sPlayer: number[] = [player];
  const sParent: number[] = [-1];
  const sPushFrom: number[] = [-1];
  const sPushDir: number[] = [-1];
  const sG: number[] = [0];
  const sKey: (number | string)[] = [];
  const hVal: number[] = [];
  const fVal: number[] = [];
  const best = new Map<number | string, number>();

  // Flood fill from `from` around walls and `occupied`: marks `seen`
  // with a fresh stamp and returns the lowest square reached. The key
  // fills use their own marks, so they never clobber a region in use.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let markStamp = 0;
  const flood = (into: Int32Array, occupied: Uint8Array, from: number): { low: number; stamp: number } => {
    const st = into === seen ? ++stamp : ++markStamp;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    into[from] = st;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (q < 0 || q >= size) continue;
        if (wall[q] || occupied[q] || into[q] === st) continue;
        into[q] = st;
        stack[sp++] = q;
      }
    }
    return { low, stamp: st };
  };
  const floodLow = (occupied: Uint8Array, from: number): number => flood(seen, occupied, from).low;
  const markLow = (occupied: Uint8Array, from: number): number => flood(mark, occupied, from).low;

  const occupied0 = new Uint8Array(size);
  for (const b of startBoxes) occupied0[b] = 1;
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  sKey.push(keyOf(startBoxes, floodLow(occupied0, player)));
  hVal.push(h0);
  fVal.push(h0 * weight);
  best.set(sKey[0], 0);

  // The open list: a heap of state indexes on (f, h, index).
  const heap: number[] = [0];
  const less = (a: number, b: number): boolean =>
    fVal[a] !== fVal[b] ? fVal[a] < fVal[b] : hVal[a] !== hVal[b] ? hVal[a] < hVal[b] : a < b;
  const heapPush = (s: number): void => {
    let i = heap.length;
    heap.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };

  const occupied = new Uint8Array(size);
  let expansions = 0;
  let found = -1;
  while (heap.length > 0) {
    const s = heapPop();
    if (best.get(sKey[s]) !== sG[s]) continue;
    const bs = sBoxes[s];
    if (bs.every((b) => goalSet[b])) {
      found = s;
      break;
    }
    expansions++;
    budget.left--;
    if (expansions > phaseCap || budget.left < 0) return null;
    for (const b of bs) occupied[b] = 1;
    floodLow(occupied, sPlayer[s]);
    const regionStamp = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const t = b + d;
        const behind = b - d;
        if (t < 0 || t >= size || behind < 0 || behind >= size) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        if (seen[behind] !== regionStamp) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(t, occupied);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h2 = Infinity;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((a, b) => a - b);
          const low = markLow(occupied, b);
          key = keyOf(next, low);
          const prev = best.get(key);
          const g2 = sG[s] + 1;
          if (prev === undefined || prev > g2) h2 = heuristic(next);
          else key = -1;
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || key === -1 || h2 === Infinity) continue;
        const g2 = sG[s] + 1;
        best.set(key, g2);
        const ns = sBoxes.length;
        sBoxes.push(next!);
        sPlayer.push(b);
        sParent.push(s);
        sPushFrom.push(b);
        sPushDir.push(k);
        sG.push(g2);
        sKey.push(key);
        hVal.push(h2);
        fVal.push(g2 + weight * h2);
        heapPush(ns);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The push sequence, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let pl = player;
  const cur = startBoxes.slice();
  for (const s of path) {
    const from = sPushFrom[s];
    const dir = sPushDir[s];
    const d = DY[dir] * w + DX[dir];
    const occ = new Uint8Array(size);
    for (const b of cur) occ[b] = 1;
    const walk = walkTo(w, h, wall, occ, pl, from - d);
    if (walk === null) return null;
    moves += walk;
    moves += LETTER[dir].toUpperCase();
    pl = from;
    const idx = cur.indexOf(from);
    cur[idx] = from + d;
    cur.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves, endPlayer: pl };
}

/** A room through its three phases, or null when they all give up. */
function solveRoomPhases(
  w: number,
  h: number,
  wall: Uint8Array,
  goals: number[],
  boxes: number[],
  player: number,
  budget: Budget,
): RoomSolution | null {
  const roomCap = Math.min(budget.left, PER_ROOM_CAP);
  if (roomCap <= 0) return null;
  const capA = Math.floor(roomCap * 0.7);
  const capB = Math.floor(roomCap * 0.2);
  const capC = roomCap - capA - capB;
  let sol = searchRoom(w, h, wall, goals, boxes, player, budget, capA, 1);
  if (sol !== null) return sol;
  sol = searchRoom(w, h, wall, goals, boxes, player, budget, capB, 5);
  if (sol !== null) return sol;
  return searchRoom(w, h, wall, goals, boxes, player, budget, capC, 0);
}

/** The level's moves: each room in turn, the player walking on. */
function solveLevel(text: string): { moves: string; rooms: number; pushes: number } {
  const level = parseLevel(text);
  const budget: Budget = { left: TOTAL_BUDGET };
  if (level.player < 0 || level.boxes.length === 0) return { moves: '', rooms: 0, pushes: 0 };
  const rooms = roomsOf(level);
  if (rooms === null) {
    const sol = solveRoomPhases(level.w, level.h, level.wall, level.goals, level.boxes, level.player, budget);
    if (sol === null) return { moves: '', rooms: 0, pushes: 0 };
    return { moves: sol.moves, rooms: 1, pushes: sol.pushes };
  }
  let player = level.player;
  let moves = '';
  let pushes = 0;
  const roomBoxes: number[][] = rooms.map((r) => r.boxes.slice());
  const roomGoals: number[][] = rooms.map((r) => r.goals.slice());
  for (let ri = 0; ri < rooms.length; ri++) {
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      for (const b of roomBoxes[oj]) wall[b] = 1;
    }
    const sol = solveRoomPhases(level.w, level.h, wall, roomGoals[ri], roomBoxes[ri], player, budget);
    if (sol === null) return { moves: '', rooms: rooms.length, pushes: 0 };
    moves += sol.moves;
    pushes += sol.pushes;
    player = sol.endPlayer;
    roomBoxes[ri] = roomGoals[ri].slice();
  }
  return { moves, rooms: rooms.length, pushes };
}

for (const id of readdirSync(I).sort()) {
  let out = '';
  let rooms = 0;
  let pushes = 0;
  try {
    const res = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    out = res.moves;
    rooms = res.rooms;
    pushes = res.pushes;
  } catch {
    out = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${out}\n`);
  console.error(`${id}: ${rooms} rooms, ${pushes} pushes, ${out.length} moves`);
}
