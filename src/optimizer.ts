import {
  BREAK_EVEN_LOAD,
  BREAK_EVEN_LOAD_CARGO,
  DAY_SECONDS,
  DAYS_PER_WEEK,
  LEGS_PER_ROUNDTRIP,
  SKIP_RENTALS,
  TIME_GRANULARITY,
  WEEK_SECONDS,
} from "./config.ts";
import { canFly, capacityOf, linesByHub, roundTripDuration } from "./model.ts";
import type { Aircraft, AircraftPlan, CabinClass, Line } from "./types.ts";

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
 * PROFIT of ONE round trip of `a` on `line` DEPARTING on `day`, given the current
 * per-day demand. A flight's cost is treated as a fixed share of a FULL flight's
 * revenue (the break-even load measured from real accounting), so:
 *   revenue     = Σ_class min(seats, remaining[day])·price      (seats it really fills)
 *   fullRevenue = Σ_class seats·price                           (a 100%-full flight)
 *   cost        = breakEven · fullRevenue                       (fuel + WEAR + fees)
 *   value       = (revenue − cost) · legs
 * The break-even is REVENUE-WEIGHTED across ALL classes, so a half-empty eco cabin
 * is subsidised by business/first/cargo — the flight only counts as a loss if the
 * WHOLE plane can't cover its (almost fixed) cost. If value <= 0 the flight is NOT
 * scheduled: better leave the aircraft idle than fly it at a loss (and wear it out).
 * Demand is per-day, so once a day's demand runs out the next flight there is
 * unprofitable and the optimizer moves to another day/route/aircraft.
 */
function roundTripValue(a: Aircraft, line: Line, day: number): {
  value: number;
  fillWithin: Record<CabinClass, number>;
  fillOver: Record<CabinClass, number>;
} {
  const cap = capacityOf(a);
  const rem = line.remaining[day];
  const fillWithin = { eco: 0, bus: 0, first: 0, cargo: 0 } as Record<CabinClass, number>;
  const fillOver = { eco: 0, bus: 0, first: 0, cargo: 0 } as Record<CabinClass, number>;
  let revenue = 0;
  let fullRevenue = 0;
  for (const c of CLASSES) {
    // A round trip flies BOTH legs (out + back) and the game counts BOTH against the
    // route's DAILY demand pool. Verified live: a 700-eco A380 round trip consumes
    // 1400 eco/day, not 700. So one round trip offers LEGS × seats.
    const seats = cap[c] * LEGS_PER_ROUNDTRIP;
    if (seats <= 0) continue;
    const within = Math.max(0, Math.min(seats, rem[c])); // real demand it fills that day
    fillWithin[c] = within;
    fillOver[c] = seats - within; // empty seats (oversupply), earn nothing
    revenue += within * line.price[c];
    fullRevenue += seats * line.price[c];
  }
  // Fixed cost ≈ break-even load × a full flight's revenue (fuel + wear + fees).
  const breakEven = a.isCargo ? BREAK_EVEN_LOAD_CARGO : BREAK_EVEN_LOAD;
  const cost = breakEven * fullRevenue;
  return { value: revenue - cost, fillWithin, fillOver };
}

/** A concrete flight an aircraft could fly next: route, departure day and take-off. */
interface Move {
  line: Line;
  day: number; // departure day (0..6) whose demand it consumes
  takeOffTime: number; // concrete take-off (s from week start, multiple of granularity)
  duration: number;
  value: number;
  density: number; // profit per second of aircraft time
  fillWithin: Record<CabinClass, number>;
  fillOver: Record<CabinClass, number>;
}

const ceilTo = (t: number, g: number) => Math.ceil(t / g) * g;

/**
 * Best next flight for an aircraft given its scheduling cursor.
 *
 * Starting at the cursor's day, it looks for the most profitable (per second) route
 * that can DEPART that day and finish within the week. If the current day has no
 * profitable demand left for any reachable route, it advances to the next day's
 * start and tries again (leaving the rest of that day idle — flying more would
 * oversupply it). A flight always departs within its `day`, so the demand it
 * consumes matches what the game meters; long flights (>24 h) simply span into the
 * following days via the cursor, with their demand booked on the departure day.
 */
function bestMoveFor(a: Aircraft, lines: Line[]): Move | null {
  const startDay = Math.floor(a.cursor / DAY_SECONDS);
  for (let d = startDay; d < DAYS_PER_WEEK; d++) {
    // Where a flight on day d would take off: the cursor (same day) or the day's
    // start (after skipping earlier, exhausted days), snapped to the 900 s grid.
    const base = d === startDay ? a.cursor : d * DAY_SECONDS;
    const takeOff = ceilTo(base, TIME_GRANULARITY);
    if (takeOff >= (d + 1) * DAY_SECONDS) continue; // no room left before midnight -> next day
    if (takeOff >= WEEK_SECONDS) break;

    let best: Move | null = null;
    for (const line of lines) {
      if (!canFly(a, line)) continue;
      const duration = roundTripDuration(a, line);
      if (takeOff + duration > WEEK_SECONDS) continue; // must finish inside the week
      const { value, fillWithin, fillOver } = roundTripValue(a, line, d);
      if (value <= 0) continue; // unprofitable on day d -> skip (caps oversupply)
      const density = value / duration;
      if (!best || density > best.density) {
        best = { line, day: d, takeOffTime: takeOff, duration, value, density, fillWithin, fillOver };
      }
    }
    if (best) return best;
    // day d has no profitable flight for this aircraft -> try the next day
  }
  return null;
}

/** Apply a flight: consume the departure day's demand, advance the cursor, record it. */
function commitTrip(a: Aircraft, m: Move): void {
  const rem = m.line.remaining[m.day];
  const over = m.line.over[m.day];
  for (const c of CLASSES) {
    rem[c] = Math.max(0, rem[c] - m.fillWithin[c]);
    over[c] += m.fillOver[c];
  }
  a.cursor = m.takeOffTime + m.duration;
  a.assigned.push({
    lineId: m.line.id,
    day: m.day,
    takeOffTime: m.takeOffTime,
    duration: m.duration,
    within: { ...m.fillWithin },
    over: { ...m.fillOver },
    value: m.value,
  });
}

/**
 * Greedy allocation, DAY-AWARE and BALANCED across the fleet.
 *
 * We always advance the aircraft that is FURTHEST BEHIND in the week (smallest
 * cursor) and give it the densest profitable flight available for its current day.
 * Because all aircraft march through time together, they share each day's demand
 * evenly and reach similar utilisation — no aircraft is packed solid while another
 * sits empty (the player wants every aircraft used, spread across routes). Each
 * aircraft still picks its OWN best route per day, so as a route's daily demand
 * fills up its density drops and the next aircraft naturally moves to another route.
 *
 * The min-cursor key is exact (an aircraft's cursor only changes when IT flies), so
 * no stale-entry bookkeeping is needed: pop the earliest, fly one leg, re-insert.
 */
function greedyAllocate(aircraft: Aircraft[], hubLines: Line[]): void {
  const fleet = aircraft.filter((a) => !(SKIP_RENTALS && a.isRental));
  const byId = new Map(fleet.map((a) => [a.id, a]));

  // MaxHeap keyed by -cursor ⇒ pops the aircraft with the EARLIEST cursor first.
  const heap = new MaxHeap();
  for (const a of fleet) {
    if (bestMoveFor(a, hubLines)) heap.push({ key: -a.cursor, id: a.id, epoch: 0 });
  }

  for (let top = heap.pop(); top; top = heap.pop()) {
    const a = byId.get(top.id)!;
    const move = bestMoveFor(a, hubLines);
    if (!move) continue; // nothing profitable left for this aircraft -> it stops (idle tail)
    commitTrip(a, move); // advances a.cursor
    heap.push({ key: -a.cursor, id: a.id, epoch: 0 }); // re-queue at its new (later) position
  }
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
    greedyAllocate(planes, hubLines); // serve each day's profitable demand, day by day
  }

  const plans: AircraftPlan[] = [];
  let totalFlights = 0;
  for (const a of aircraft) {
    // Flights are committed in take-off order already; sort defensively.
    const added = a.assigned
      .map((t) => ({ takeOffTime: t.takeOffTime, lineId: t.lineId }))
      .sort((x, y) => x.takeOffTime - y.takeOffTime);
    totalFlights += added.length;
    plans.push({ aircraftId: a.id, added });
  }
  return { plans, totalFlights };
}
