/**
 * @fileoverview Per-hub greedy scheduler.
 *
 * Fills economy on a 900 s grid with daily demand pools, an overshoot cap, a
 * utilisation floor, and a sell threshold. `optimize` runs one independent pass
 * per hub; `greedyAllocate` is also reused by the rebalancer after virtual moves.
 */
import {
  BREAK_EVEN_LOAD,
  BREAK_EVEN_LOAD_CARGO,
  CARGO_OVERSHOOT_CAP,
  DAY_SECONDS,
  DAYS_PER_WEEK,
  ECO_OVERSHOOT_CAP,
  LEGS_PER_ROUNDTRIP,
  SELL_THRESHOLD,
  SKIP_RENTALS,
  TIME_GRANULARITY,
  UTIL_FLOOR,
  WEEK_SECONDS,
} from "./config.ts";
import { canFly, capacityOf, linesByHub, roundTripDuration } from "./model.ts";
import {
  type Aircraft,
  type AircraftPlan,
  CABIN_CLASSES,
  type CabinClass,
  type Line,
} from "./types.ts";

const CLASSES = CABIN_CLASSES;

/**
 * Fill of one round trip of `a` on `line` departing on `day`.
 *
 * - `fillWithin` — seats/tons that hit remaining demand that day
 * - `fillOver` — empty seats (oversupply)
 * - `value` — estimated profit for reports only; scheduling scores eco seats per second
 */
function roundTripValue(
  a: Aircraft,
  line: Line,
  day: number
): {
  value: number;
  fillWithin: Record<CabinClass, number>;
  fillOver: Record<CabinClass, number>;
} {
  const cap = capacityOf(a);
  const rem = line.remaining[day];
  const fillWithin = { bus: 0, cargo: 0, eco: 0, first: 0 } as Record<
    CabinClass,
    number
  >;
  const fillOver = { bus: 0, cargo: 0, eco: 0, first: 0 } as Record<
    CabinClass,
    number
  >;
  let revenue = 0;
  let fullRevenue = 0;
  for (const c of CLASSES) {
    // A round trip flies BOTH legs (out + back) and the game counts BOTH against the
    // route's DAILY demand pool. Verified live: a 700-eco A380 round trip consumes
    // 1400 eco/day, not 700. So one round trip offers LEGS × seats.
    const seats = cap[c] * LEGS_PER_ROUNDTRIP;
    if (seats <= 0) {
      continue;
    }
    const within = Math.max(0, Math.min(seats, rem[c])); // real demand it fills that day
    fillWithin[c] = within;
    fillOver[c] = seats - within; // empty seats (oversupply), earn nothing
    revenue += within * line.price[c];
    fullRevenue += seats * line.price[c];
  }
  // Fixed cost ≈ break-even load × a full flight's revenue (fuel + wear + fees).
  const breakEven = a.isCargo ? BREAK_EVEN_LOAD_CARGO : BREAK_EVEN_LOAD;
  const cost = breakEven * fullRevenue;
  return { fillOver, fillWithin, value: revenue - cost };
}

/** A concrete flight an aircraft could fly next: route, departure day and take-off. */
interface Move {
  day: number; // departure day (0..6) whose demand it consumes
  density: number; // PRIMARY-class seats filled per second of aircraft time (eco for pax, cargo for freighters)
  duration: number;
  fillOver: Record<CabinClass, number>;
  fillWithin: Record<CabinClass, number>;
  line: Line;
  takeOffTime: number; // concrete take-off (s from week start, multiple of granularity)
  value: number; // reporting-only profit (NOT the objective)
  vStart: number; // virtual-clock position of this flight (for advancing the cursor)
}

/** The class an aircraft optimises for: eco for passenger aircraft, cargo for freighters. */
function primaryClassOf(a: Aircraft): CabinClass {
  return a.isCargo ? "cargo" : "eco";
}

/** Max per-route-per-day overshoot allowed for this aircraft's primary class (seats / tons). */
function overshootCapOf(a: Aircraft): number {
  return a.isCargo ? CARGO_OVERSHOOT_CAP : ECO_OVERSHOOT_CAP;
}

const ceilTo = (t: number, g: number) => Math.ceil(t / g) * g;

/**
 * Deterministic per-aircraft phase in [0, WEEK), on the 900 s grid. Used to STAGGER
 * the fleet so not every aircraft starts Monday 00:00 (which made the airport "fill
 * up" at one instant — unrealistic). Pure hash of the id, so it's stable across runs.
 */
function phaseOffset(id: number): number {
  let x = (id ^ 0x9e_37_79_b9) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85_eb_ca_6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2_b2_ae_35);
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
function bestMoveFor(
  a: Aircraft,
  candLines: Line[],
  vEnd: number
): Move | null {
  const primary = primaryClassOf(a); // eco (pax) or cargo (freighter)
  const cap = overshootCapOf(a); // max per-route-per-day overshoot for the primary class
  let v = ceilTo(a.cursor, TIME_GRANULARITY); // virtual position, on the 900 s grid
  while (v < vEnd) {
    const real = v % WEEK_SECONDS; // concrete take-off time in [0, WEEK)
    const day = Math.floor(real / DAY_SECONDS);

    let best: Move | null = null;
    // candLines is PRE-FILTERED to the routes this aircraft can fly (canFly) AND that are
    // still active (not sold) — so the hot loop does no per-flight canFly work.
    for (const line of candLines) {
      const duration = roundTripDuration(a, line);
      if (v + duration > vEnd) {
        continue; // must finish inside this aircraft's one week
      }
      const { value, fillWithin, fillOver } = roundTripValue(a, line, day);
      // OBJECTIVE = ECO COVERAGE, filled to the brim.
      // Serve a route while it still has POSITIVE eco (cargo for freighters) demand left this
      // day; the flight that crosses zero is allowed to overshoot the demand by coarse seats.
      const primaryWithin = fillWithin[primary];
      if (primaryWithin <= 0) {
        continue; // route's primary demand for this day is exhausted -> use another route
      }
      // HARD RULE: never drive a route below −CAP for a single day. The crossing flight adds
      // fillOver[primary] empty seats on top of whatever this day already oversupplies; skip it
      // if that exceeds the cap (aircraft too big for this route's residual — leave it for a route
      // where it fits). With eco demand the cap is ECO_OVERSHOOT_CAP (1500); cargo uses its own.
      if (line.over[day][primary] + fillOver[primary] > cap) {
        continue;
      }
      // Score = primary seats filled per second -> fill the biggest eco gaps fastest,
      // so the smallest, overshoot-prone slivers are served last (minimal oversupply).
      const density = primaryWithin / duration;
      if (!best || density > best.density) {
        best = {
          day,
          density,
          duration,
          fillOver,
          fillWithin,
          line,
          takeOffTime: real,
          value,
          vStart: v,
        };
      }
    }
    if (best) {
      return best;
    }
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
    day: m.day,
    duration: m.duration,
    lineId: m.line.id,
    over: { ...m.fillOver },
    takeOffTime: m.takeOffTime,
    value: m.value,
    within: { ...m.fillWithin },
  });
}

/** ONE allocation pass: fill each of `planes` to the brim (scarcity-aware pyramid order)
 *  against the CURRENT hub demand state. `candByAircraft` maps each plane to its flyable,
 *  still-active routes (PRE-FILTERED — the hot loop does no per-flight canFly work). Resets
 *  each plane's schedule first. */
function fillOnce(
  planes: Aircraft[],
  candByAircraft: Map<number, Line[]>
): void {
  // Each aircraft gets its own staggered virtual week [phase, phase+WEEK) so the
  // fleet doesn't all depart Monday 00:00 (realistic, spread-out take-offs).
  const vEndOf = new Map<number, number>();
  for (const a of planes) {
    a.cursor = phaseOffset(a.id);
    a.assigned = [];
    vEndOf.set(a.id, a.cursor + WEEK_SECONDS);
  }

  // SCARCITY-AWARE pyramid order. Process the MOST CONSTRAINED aircraft first (fewest
  // flyable active routes): it claims its scarce routes before a flexible aircraft consumes
  // them, so nothing that COULD fly ends up stranded. Among equally-constrained aircraft the
  // best eco-filler goes first → usage concentrates into a pyramid; id breaks ties (stable
  // wear: the SAME aircraft always fills first, the SAME surplus one stays idle).
  const order = planes
    .map((a) => ({
      a,
      density:
        bestMoveFor(a, candByAircraft.get(a.id)!, vEndOf.get(a.id)!)?.density ??
        Number.NEGATIVE_INFINITY,
      opt: candByAircraft.get(a.id)?.length,
    }))
    .sort(
      (x, y) =>
        (x.opt ?? 0) - (y.opt ?? 0) || y.density - x.density || x.a.id - y.a.id
    )
    .map((x) => x.a);

  // Fill each aircraft to the brim before the next: keep taking its best eco-filling
  // flight until none is left (eco demand exhausted for it, or its week is full).
  for (const a of order) {
    const vEnd = vEndOf.get(a.id)!;
    const cand = candByAircraft.get(a.id)!;
    for (
      let move = bestMoveFor(a, cand, vEnd);
      move;
      move = bestMoveFor(a, cand, vEnd)
    ) {
      commitTrip(a, move);
    }
  }
}

/** Reset a hub's per-day demand and oversupply to the daily baseline (for a refill). */
function resetHubDemand(hubLines: Line[]): void {
  for (const l of hubLines) {
    for (let d = 0; d < DAYS_PER_WEEK; d++) {
      const rem = l.remaining[d];
      const ov = l.over[d];
      rem.eco = l.dailyDemand.eco;
      rem.bus = l.dailyDemand.bus;
      rem.first = l.dailyDemand.first;
      rem.cargo = l.dailyDemand.cargo;
      ov.eco = 0;
      ov.bus = 0;
      ov.first = 0;
      ov.cargo = 0;
    }
  }
}

/**
 * Greedy eco fill for one hub, then enforce `utilFloor` and `sellThreshold`.
 *
 * Aircraft below the utilisation floor are grounded and demand is refilled.
 * Routes below the sell threshold are dropped so remaining aircraft cover keepers.
 * The loop only removes assignments, so it terminates. With `utilFloor <= 0`
 * this is a single pass (used by the buy simulator).
 */
export function greedyAllocate(
  aircraft: Aircraft[],
  hubLines: Line[],
  utilFloor = 0,
  sellThreshold = 0
): void {
  const fleet = aircraft.filter((a) => !(SKIP_RENTALS && a.isRental));
  // Static canFly cache: each aircraft -> the hub routes it can physically fly.
  const flyable = new Map<number, Line[]>();
  for (const a of fleet) {
    flyable.set(
      a.id,
      hubLines.filter((l) => canFly(a, l))
    );
  }

  if (utilFloor <= 0) {
    fillOnce(fleet, flyable); // single pass against current demand (buy-simulator path)
    return;
  }

  const usedSecs = (a: Aircraft) =>
    a.assigned.reduce((s, t) => s + t.duration, 0);
  // A plane is "long-haul-maxed" when it can't fit ANOTHER round trip of its LONGEST flown
  // route in the week — e.g. 4× a 33.75h route = 80% util but a 5th won't fit. Such a plane is
  // as full as its routes allow (the 33h gap can't take another long leg); grounding it would
  // only DROP that long-haul eco. So it is NOT groundable even below the util floor — it should
  // instead be combined with other routes (which the greedy already backfills when their eco is
  // available). Only planes that still have room for another of their longest leg are genuinely
  // underfilled and get grounded.
  const longHaulMaxed = (a: Aircraft) => {
    const used = usedSecs(a);
    const longest = a.assigned.reduce((m, t) => Math.max(m, t.duration), 0);
    return WEEK_SECONDS - used < longest;
  };
  const active = new Set<number>(hubLines.map((l) => l.id)); // route ids still worth serving
  const candFor = (planes: Aircraft[]) => {
    const m = new Map<number, Line[]>();
    for (const a of planes) {
      m.set(a.id, flyable.get(a.id)?.filter((l) => active.has(l.id)) ?? []);
    }
    return m;
  };
  let eligible = [...fleet];
  for (let guard = 0; guard < 4000; guard++) {
    resetHubDemand(hubLines);
    fillOnce(eligible, candFor(eligible));

    // Sub-floor aircraft worth grounding: below the util floor AND still have room for another
    // of their longest leg (genuinely underfilled). Long-haul-maxed planes are KEPT (a long
    // route can cap a dedicated plane below the floor — that's full, not waste).
    const badAc = eligible
      .filter(
        (a) =>
          a.assigned.length > 0 &&
          usedSecs(a) / WEEK_SECONDS < utilFloor &&
          !longHaulMaxed(a)
      )
      .sort((x, y) => usedSecs(x) - usedSecs(y));
    // Sell routes: active routes whose eco ended below the sell threshold, worst first.
    const badRt: { l: Line; cov: number }[] = [];
    if (sellThreshold > 0) {
      for (const l of hubLines) {
        if (!active.has(l.id) || l.weeklyDemand.eco <= 0) {
          continue;
        }
        let served = 0;
        for (let d = 0; d < DAYS_PER_WEEK; d++) {
          served += l.dailyDemand.eco - l.remaining[d].eco;
        }
        const cov = served / l.weeklyDemand.eco;
        if (cov < sellThreshold) {
          badRt.push({ cov, l });
        }
      }
      badRt.sort((x, y) => x.cov - y.cov);
    }
    if (badAc.length === 0 && badRt.length === 0) {
      break;
    }

    // Sell the worst HALF of sub-threshold routes (frees capacity) and ground the worst
    // QUARTER of sub-floor aircraft this round; re-check next round so we don't over-prune.
    for (const { l } of badRt.slice(
      0,
      Math.max(1, Math.ceil(badRt.length / 2))
    )) {
      active.delete(l.id);
    }
    const ground = new Set(
      badAc.slice(0, Math.max(1, Math.ceil(badAc.length / 4))).map((a) => a.id)
    );
    for (const a of eligible) {
      if (ground.has(a.id)) {
        a.assigned = [];
      }
    }
    eligible = eligible.filter((a) => !ground.has(a.id));
    if (eligible.length === 0) {
      break;
    }
  }
}

/** Output of `optimize`: one plan per aircraft (empty `added` = idle). */
export interface OptimizationResult {
  plans: AircraftPlan[];
  /** Total scheduled flights. */
  totalFlights: number;
}

/**
 * Run `greedyAllocate` once per hub and return POST-ready plans.
 *
 * Hubs are independent (`canFly` requires the same hub). Passenger aircraft fill
 * economy; freighters fill cargo. Does not talk to the network.
 *
 * @param opts.utilFloor - Override `UTIL_FLOOR` (set `0` for a single fill pass).
 * @param opts.sellThreshold - Override `SELL_THRESHOLD` (set `0` to keep every route).
 */
export function optimize(
  aircraft: Aircraft[],
  lines: Map<number, Line>,
  opts?: { utilFloor?: number; sellThreshold?: number }
): OptimizationResult {
  const utilFloor = opts?.utilFloor ?? UTIL_FLOOR;
  const sellThreshold = opts?.sellThreshold ?? SELL_THRESHOLD;
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
    greedyAllocate(planes, hubLines, utilFloor, sellThreshold);
  }

  const plans: AircraftPlan[] = [];
  let totalFlights = 0;
  for (const a of aircraft) {
    // Flights are committed in take-off order already; sort defensively.
    const added = a.assigned
      .map((t) => ({ lineId: t.lineId, takeOffTime: t.takeOffTime }))
      .sort((x, y) => x.takeOffTime - y.takeOffTime);
    totalFlights += added.length;
    plans.push({ added, aircraftId: a.id });
  }
  return { plans, totalFlights };
}
