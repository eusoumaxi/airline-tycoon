import {
  COST_PER_KM,
  LEGS_PER_ROUNDTRIP,
  MIN_FILL,
  SKIP_RENTALS,
  TIGHTEN_ROUNDS,
  TIME_GRANULARITY,
  WEEK_SECONDS,
} from "./config.ts";
import { canFly, capacityOf, linesByHub, roundTripDuration } from "./model.ts";
import type { Aircraft, AircraftPlan, AssignedTrip, CabinClass, Line } from "./types.ts";

const CLASSES: CabinClass[] = ["eco", "bus", "first", "cargo"];

/** Heap entry: key (profit density), aircraft id and epoch (for invalidation). */
interface HeapEntry {
  key: number;
  id: number;
  epoch: number;
}

/** Simple binary max-heap by `key`. */
class MaxHeap {
  private h: HeapEntry[] = [];
  get size(): number {
    return this.h.length;
  }
  push(e: HeapEntry): void {
    const h = this.h;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].key >= h[i].key) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop(): HeapEntry | undefined {
    const h = this.h;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l].key > h[m].key) m = l;
        if (r < h.length && h[r].key > h[m].key) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * PROFIT of ONE round trip of `a` on `line`, given the current demand state:
 * revenue from the REAL demand it would fill minus the flight cost.
 *   value = Σ_class min(seats, remaining)·price        (revenue)
 *         − COST_PER_KM · distance · 2                 (cost)
 * Seats above demand fly empty and earn 0. If value <= 0 the flight is NOT
 * scheduled (it loses money) -> the slot stays free. This caps oversupply on its
 * own: once demand runs out, extra flights stop being profitable and aren't flown.
 */
function roundTripValue(a: Aircraft, line: Line): {
  value: number;
  fillWithin: Record<CabinClass, number>;
  fillOver: Record<CabinClass, number>;
} {
  const cap = capacityOf(a);
  const fillWithin = { eco: 0, bus: 0, first: 0, cargo: 0 } as Record<CabinClass, number>;
  const fillOver = { eco: 0, bus: 0, first: 0, cargo: 0 } as Record<CabinClass, number>;
  let revenue = 0;
  let paxSeats = 0;
  let paxFilled = 0;
  for (const c of CLASSES) {
    const seats = cap[c];
    if (seats <= 0) continue;
    const within = Math.max(0, Math.min(seats, line.remaining[c])); // real demand it fills
    fillWithin[c] = within;
    fillOver[c] = seats - within; // empty seats (oversupply), earn nothing
    revenue += within * line.price[c];
    if (c !== "cargo") {
      paxSeats += seats;
      paxFilled += within;
    }
  }
  // Optional safeguard: require a minimum pax load factor to fly.
  if (MIN_FILL > 0 && paxSeats > 0 && paxFilled < MIN_FILL * paxSeats) {
    return { value: 0, fillWithin, fillOver };
  }
  const cost = COST_PER_KM * line.distance * LEGS_PER_ROUNDTRIP;
  return { value: revenue * LEGS_PER_ROUNDTRIP - cost, fillWithin, fillOver };
}

interface Candidate {
  line: Line;
  duration: number;
  value: number;
  density: number; // profit per second of aircraft time
  fillWithin: Record<CabinClass, number>;
  fillOver: Record<CabinClass, number>;
}

/** Best line (highest profit per second) for an aircraft in the current state. */
function bestLineFor(a: Aircraft, lines: Line[]): Candidate | null {
  let best: Candidate | null = null;
  for (const line of lines) {
    if (!canFly(a, line)) continue;
    const duration = roundTripDuration(a, line);
    if (duration > a.freeTime) continue;
    const { value, fillWithin, fillOver } = roundTripValue(a, line);
    if (value <= 0) continue; // not profitable -> not flown (slot stays free)
    const density = value / duration;
    if (!best || density > best.density) best = { line, duration, value, density, fillWithin, fillOver };
  }
  return best;
}

/** Apply a flight: subtract demand/time, record the assignment. */
function commitTrip(a: Aircraft, cand: Candidate): void {
  for (const c of CLASSES) {
    cand.line.remaining[c] = Math.max(0, cand.line.remaining[c] - cand.fillWithin[c]);
    cand.line.over[c] += cand.fillOver[c];
  }
  a.freeTime -= cand.duration;
  a.assigned.push({
    lineId: cand.line.id,
    duration: cand.duration,
    within: { ...cand.fillWithin },
    over: { ...cand.fillOver },
    value: cand.value,
  });
}

/** Undo a flight: give back demand/time (for the grow-swap). */
function uncommitTrip(a: Aircraft, line: Line, trip: AssignedTrip): void {
  for (const c of CLASSES) {
    line.remaining[c] += trip.within[c];
    line.over[c] = Math.max(0, line.over[c] - trip.over[c]);
  }
  a.freeTime += trip.duration;
}

/**
 * Greedy allocation by profit density (lazy heap).
 *
 * An aircraft's density can only DROP when another aircraft consumes demand from
 * its best line. So a heap entry is an upper bound: when popped, recompute it; if
 * unchanged it is the true max and is committed; if it dropped, re-insert with the
 * new density. The epoch discards stale entries of an aircraft that already moved on.
 */
function greedyAllocate(aircraft: Aircraft[], hubLines: Line[]): void {
  const fleet = aircraft.filter((a) => !(SKIP_RENTALS && a.isRental));
  const byId = new Map(fleet.map((a) => [a.id, a]));

  const heap = new MaxHeap();
  const epoch = new Map<number, number>();
  const bump = (id: number) => {
    const e = (epoch.get(id) ?? 0) + 1;
    epoch.set(id, e);
    return e;
  };

  for (const a of fleet) {
    const c = bestLineFor(a, hubLines);
    if (c) heap.push({ key: c.density, id: a.id, epoch: bump(a.id) });
  }

  for (let top = heap.pop(); top; top = heap.pop()) {
    if (top.epoch !== epoch.get(top.id)) continue; // superseded entry
    const a = byId.get(top.id)!;
    const fresh = bestLineFor(a, hubLines);
    if (!fresh) continue; // nothing fits for this aircraft anymore
    if (fresh.density < top.key - 1e-6) {
      heap.push({ key: fresh.density, id: a.id, epoch: bump(a.id) }); // dropped: re-insert
      continue;
    }
    commitTrip(a, fresh); // it is the true max -> schedule the flight
    const next = bestLineFor(a, hubLines);
    if (next) heap.push({ key: next.density, id: a.id, epoch: bump(a.id) });
  }
}

/**
 * TIGHTEN (grow-swap + gap-fill) to push toward more profit / less idle time.
 *
 * Per aircraft:
 *   - GROW-SWAP: replace a flight with a LONGER/more profitable one that fits the
 *     gap, without losing value.
 *   - GAP-FILL: add any profitable flight that still fits the gap.
 * It is demand-aware (un-assigns and re-evaluates) so it doesn't break the split.
 */
function tightenPacking(aircraft: Aircraft[], lines: Map<number, Line>, candLines: Line[]): void {
  const fleet = aircraft.filter((a) => !(SKIP_RENTALS && a.isRental));

  for (const a of fleet) {
    for (let round = 0; round < TIGHTEN_ROUNDS; round++) {
      let improved = false;

      // GROW-SWAP: for each flight, try a longer one that fills more.
      for (let i = 0; i < a.assigned.length; i++) {
        const trip = a.assigned[i];
        const oldLine = lines.get(trip.lineId)!;
        uncommitTrip(a, oldLine, trip); // free time and demand

        // Best route longer than the current flight that fits.
        let best: Candidate | null = null;
        for (const line of candLines) {
          if (!canFly(a, line)) continue;
          const duration = roundTripDuration(a, line);
          if (duration <= trip.duration || duration > a.freeTime) continue; // must be LONGER and fit
          const { value, fillWithin, fillOver } = roundTripValue(a, line);
          const density = value / duration;
          if (!best || density > best.density) best = { line, duration, value, density, fillWithin, fillOver };
        }

        // Accept only if we don't lose value (a longer route usually pays more).
        if (best && best.value >= trip.value) {
          commitTrip(a, best);
          a.assigned[i] = a.assigned[a.assigned.length - 1];
          a.assigned.pop(); // the new flight went to the end; drop the slot at i
          improved = true;
        } else {
          // Restore the original flight as-is.
          for (const c of CLASSES) {
            oldLine.remaining[c] = Math.max(0, oldLine.remaining[c] - trip.within[c]);
            oldLine.over[c] += trip.over[c];
          }
          a.freeTime -= trip.duration;
        }
      }

      // GAP-FILL: add any flight that still fits the gap.
      let fill = bestLineFor(a, candLines);
      while (fill) {
        commitTrip(a, fill);
        improved = true;
        fill = bestLineFor(a, candLines);
      }

      if (!improved) break;
    }
  }
}

/** Deterministic hash of an id -> [0, WEEK) to phase each aircraft differently. */
function phaseOffset(id: number): number {
  let x = (id ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x = (x ^ (x >>> 16)) >>> 0;
  return x % WEEK_SECONDS;
}

/**
 * Generate an aircraft's takeOffTimes. Works on a TIME_GRANULARITY (900 s) grid
 * because the game requires every takeOffTime to be a multiple of it. Each flight
 * reserves ceil(duration / 900) slots (so they never overlap), the slack is
 * spread uniformly, and a per-aircraft pseudo-random PHASE offset (cyclic) means
 * they don't all start Monday 00:00 — aircraft on the same route are staggered.
 */
function scheduleTimes(a: Aircraft): { takeOffTime: number; lineId: number }[] {
  const n = a.assigned.length;
  if (n === 0) return [];
  const G = TIME_GRANULARITY;
  const totalSlots = Math.floor(WEEK_SECONDS / G); // 672
  const durSlots = a.assigned.map((t) => Math.ceil(t.duration / G)); // footprint per flight
  const usedSlots = durSlots.reduce((s, d) => s + d, 0);
  const slackSlots = Math.max(0, totalSlots - usedSlots);
  const gap = Math.floor(slackSlots / n);
  const offset = Math.floor(phaseOffset(a.id) / G) % totalSlots;

  const out: { takeOffTime: number; lineId: number }[] = [];
  let slot = 0;
  for (let i = 0; i < n; i++) {
    const takeoffSlot = (slot + offset) % totalSlots;
    out.push({ takeOffTime: takeoffSlot * G, lineId: a.assigned[i].lineId }); // multiple of 900
    slot += durSlots[i] + gap;
  }
  out.sort((x, y) => x.takeOffTime - y.takeOffTime);
  return out;
}

export interface OptimizationResult {
  plans: AircraftPlan[];
  /** Total scheduled flights. */
  totalFlights: number;
}

/** Run the full algorithm and return the per-aircraft plan (without sending it). */
export function optimize(aircraft: Aircraft[], lines: Map<number, Line>): OptimizationResult {
  // Hubs are independent (no aircraft flies another hub's routes), so optimize
  // each hub separately: same result, much faster.
  const hubIdx = linesByHub(lines);
  const byHub = new Map<number, Aircraft[]>();
  for (const a of aircraft) {
    const arr = byHub.get(a.hubId) ?? byHub.set(a.hubId, []).get(a.hubId)!;
    arr.push(a);
  }
  for (const [hubId, planes] of byHub) {
    const hubLines = hubIdx.get(hubId) ?? [];
    greedyAllocate(planes, hubLines); // serve profitable demand (unprofitable slots stay free)
    tightenPacking(planes, lines, hubLines); // re-tile toward more profitable flights
  }

  const plans: AircraftPlan[] = [];
  let totalFlights = 0;
  for (const a of aircraft) {
    const added = scheduleTimes(a);
    totalFlights += added.length;
    plans.push({ aircraftId: a.id, added });
  }
  return { plans, totalFlights };
}
