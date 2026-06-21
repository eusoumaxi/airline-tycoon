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
  vStart: number; // virtual-clock position of this flight (for advancing the cursor)
  duration: number;
  value: number;
  density: number; // profit per second of aircraft time
  fillWithin: Record<CabinClass, number>;
  fillOver: Record<CabinClass, number>;
}

const ceilTo = (t: number, g: number) => Math.ceil(t / g) * g;

/**
 * Deterministic per-aircraft phase in [0, WEEK), on the 900 s grid. Used to STAGGER
 * the fleet so not every aircraft starts Monday 00:00 (which made the airport "fill
 * up" at one instant — unrealistic). Pure hash of the id, so it's stable across runs.
 */
function phaseOffset(id: number): number {
  let x = (id ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x = (x ^ (x >>> 16)) >>> 0;
  const slots = WEEK_SECONDS / TIME_GRANULARITY; // 672 quarter-hour slots in a week
  return (x % slots) * TIME_GRANULARITY;
}

/**
 * Best next flight for an aircraft on its VIRTUAL clock.
 *
 * The cursor is a virtual time running over [phase, phase+WEEK); the real take-off is
 * `cursor mod WEEK`, so every aircraft flies exactly one week but STARTS at its own
 * phase and wraps around once — departures are staggered across the week instead of
 * all piling onto Monday 00:00. The demand a flight consumes is keyed off its REAL
 * departure day (`floor(real/DAY)`), so per-day balancing is unchanged. If the
 * current day has no profitable route left, it jumps to the next day's start (the
 * rest of that day stays idle — flying it would only oversupply). `vEnd` =
 * phase+WEEK bounds the aircraft to a single week.
 */
function bestMoveFor(a: Aircraft, lines: Line[], vEnd: number): Move | null {
  let v = ceilTo(a.cursor, TIME_GRANULARITY); // virtual position, on the 900 s grid
  while (v < vEnd) {
    const real = v % WEEK_SECONDS; // concrete take-off time in [0, WEEK)
    const day = Math.floor(real / DAY_SECONDS);

    let best: Move | null = null;
    for (const line of lines) {
      if (!canFly(a, line)) continue;
      const duration = roundTripDuration(a, line);
      if (v + duration > vEnd) continue; // must finish inside this aircraft's one week
      const { value, fillWithin, fillOver } = roundTripValue(a, line, day);
      if (value <= 0) continue; // unprofitable on that day -> skip (caps oversupply)
      const density = value / duration;
      if (!best || density > best.density) {
        best = { line, day, takeOffTime: real, vStart: v, duration, value, density, fillWithin, fillOver };
      }
    }
    if (best) return best;
    // nothing profitable on this real day -> jump to the next day's start (wraps at week end)
    v += (day + 1) * DAY_SECONDS - real;
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
  a.cursor = m.vStart + m.duration; // advance the VIRTUAL clock (not the wrapped real time)
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
 * Greedy allocation, DAY-AWARE and CONCENTRATED into a "pyramid".
 *
 * We fill ONE aircraft to its maximum (its whole week, day by day, with the best
 * profitable flights) BEFORE starting the next one. So flying piles onto as few
 * aircraft as possible: the most efficient run at ~100%, the next a bit less, and
 * the SURPLUS aircraft are left completely UNUSED — free to move to another hub or
 * reconfigure for cargo. (The player explicitly does NOT want many aircraft each at
 * 50%; they want a 100 / 99 / 99 / … / 0 pyramid.)
 *
 * Aircraft are ordered by the best profit density they can reach at full demand, so
 * the most capable fill first (and become the most-used), and the routes only a
 * small aircraft can serve are left for it. Oversupply is fine as long as the seats
 * that DO sell pay for the flight — that is exactly the profit test in roundTripValue.
 */
export function greedyAllocate(aircraft: Aircraft[], hubLines: Line[]): void {
  const fleet = aircraft.filter((a) => !(SKIP_RENTALS && a.isRental));

  // Each aircraft gets its own staggered virtual week [phase, phase+WEEK) so the
  // fleet doesn't all depart Monday 00:00 (realistic, spread-out take-offs).
  const vEndOf = new Map<number, number>();
  for (const a of fleet) {
    a.cursor = phaseOffset(a.id);
    vEndOf.set(a.id, a.cursor + WEEK_SECONDS);
  }

  // SCARCITY-AWARE MATCHING + pyramid order. Before an aircraft "burns" a route we
  // must respect that the route may be the ONLY thing another aircraft can fly. So
  // we process the MOST CONSTRAINED aircraft first (fewest flyable routes): it
  // claims its scarce routes before a flexible aircraft consumes them, so no
  // aircraft that COULD fly ends up stranded — maximum fleet usability. Among
  // equally-constrained aircraft the most efficient (best density) goes first, so
  // usage still concentrates into a pyramid (most-used → least-used → unused).
  const options = new Map<number, number>(); // aircraft id -> how many routes it can fly
  for (const a of fleet) options.set(a.id, hubLines.reduce((n, l) => n + (canFly(a, l) ? 1 : 0), 0));

  const order = fleet
    .map((a) => ({ a, opt: options.get(a.id)!, density: bestMoveFor(a, hubLines, vEndOf.get(a.id)!)?.density ?? -Infinity }))
    // most-constrained first, then most-efficient; id breaks ties so the SAME
    // aircraft always fills first and the SAME surplus one stays idle (stable wear).
    .sort((x, y) => x.opt - y.opt || y.density - x.density || x.a.id - y.a.id)
    .map((x) => x.a);

  // Fill each aircraft to the brim before the next: keep taking its best profitable
  // flight until none is left (demand exhausted for it, or its week is full).
  for (const a of order) {
    const vEnd = vEndOf.get(a.id)!;
    for (let move = bestMoveFor(a, hubLines, vEnd); move; move = bestMoveFor(a, hubLines, vEnd)) {
      commitTrip(a, move);
    }
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
