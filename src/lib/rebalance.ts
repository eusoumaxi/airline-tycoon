/**
 * @fileoverview Cross-hub fleet assignment.
 *
 * `optimize()` never moves aircraft between hubs. This module virtually sets
 * `aircraft.hubId`, then reuses `greedyAllocate`. The CLI (`rebalance:apply`)
 * performs the real POST moves.
 */
import { DAYS_PER_WEEK, LEGS_PER_ROUNDTRIP, WEEK_SECONDS } from "./config.ts";
import {
  capacityOf,
  hubCodes,
  linesByHub,
  roundTripDuration,
} from "./model.ts";
import { greedyAllocate } from "./optimizer.ts";
import { computeMetrics, type FleetIndex, type Metrics } from "./report.ts";
import {
  type Aircraft,
  CABIN_CLASSES,
  type CabinClass,
  emptyCabin,
  type Line,
  type ProposedFlight,
} from "./types.ts";

const CLASSES = CABIN_CLASSES;
const zero = emptyCabin;

/** Each hub aims for at least this average aircraft utilisation / demand coverage. */
export const TARGET_UTIL = 0.95;

// ── Result types ─────────────────────────────────────────────────────────────

/** One aircraft's place in the final plan, with its before/after numbers. */
export interface AircraftOutcome {
  category: number;
  destCode: string;
  destHubId: number; // where it ends up (== origin if it didn't move)
  flightsAfter: number;
  id: number;
  isCargo: boolean;
  model: string;
  moved: boolean;
  name: string;
  originCode: string;
  originHubId: number;
  plan: ProposedFlight[]; // the new weekly planning (empty if idle)
  range: number;
  routes: string[]; // route names it now flies (with ×count)
  seats: Record<CabinClass, number>; // its per-flight capacity (eco/bus/first seats, cargo tons)
  servedAfter: Record<CabinClass, number>; // weekly demand it actually fills at the destination
  status: "kept" | "moved-in" | "activated" | "idle";
  utilAfter: number; // from the new plan
  utilBefore: number; // from the live planningList at its origin
}

/** Per-class demand / offer / served / oversupply for a hub, before and after. */
export interface ClassBreakdown {
  demand: number;
  offeredAfter: number;
  offeredBefore: number;
  overAfter: number;
  servedAfter: number;
  servedBefore: number;
}

export interface HubPlan {
  // aircraft
  aircraftBefore: number; // owned originally
  assignedAfter: AircraftOutcome[]; // aircraft based here AFTER the plan
  // capacity / coverage (per class, per-day capped like the game)
  breakdown: Record<CabinClass, ClassBreakdown>;
  code: string;
  coverageAfterEco: number;
  coverageBeforeEco: number;
  flyingBefore: number;
  hitTarget: boolean;
  hubId: number;
  incoming: AircraftOutcome[]; // moved IN from other hubs
  order: number; // 1-based processing position
  outgoing: AircraftOutcome[]; // its original aircraft that moved AWAY (or were released idle)
  reasoning: string;
  routeCount: number;
  strategy: "reinforced" | "donor" | "stable" | "starved";
  utilAfter: number; // avg over finally-assigned aircraft
  // utilisation
  utilBefore: number; // avg over originally-flying aircraft
}

export interface RebalanceResult {
  after: Metrics; // network totals (proposed)
  before: Metrics; // network totals (current live state)
  codeByHub: Map<number, string>;
  hubs: HubPlan[]; // in processing order (most routes first)
  idle: AircraftOutcome[]; // aircraft used nowhere, with the reason in `.reasoning`
  moves: AircraftOutcome[]; // every cross-hub move (source -> dest)
  outcomes: Map<number, AircraftOutcome>; // every aircraft by id
  targetUtil: number;
}

// ── Small helpers ────────────────────────────────────────────────────────────

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

/** Utilisation of a concrete planning (busy seconds / week, capped at 1). */
function utilOfPlan(
  a: Aircraft,
  flights: { lineId: number }[],
  lines: Map<number, Line>
): number {
  let used = 0;
  for (const f of flights) {
    const line = lines.get(f.lineId);
    if (line) {
      used += roundTripDuration(a, line);
    }
  }
  return Math.min(1, used / WEEK_SECONDS);
}

/** Can this aircraft physically serve ANY route of the hub once moved there? (range + category) */
function physicallyFits(a: Aircraft, hubLines: Line[]): boolean {
  for (const l of hubLines) {
    if (a.range >= l.distance && l.category >= a.category) {
      return true;
    }
  }
  return false;
}

/** Reset a hub's per-day demand pools so greedyAllocate starts from the full demand. */
function resetLines(hubLines: Line[]): void {
  for (const l of hubLines) {
    l.remaining = Array.from({ length: DAYS_PER_WEEK }, () => ({
      ...l.dailyDemand,
    }));
    l.over = Array.from({ length: DAYS_PER_WEEK }, () => ({
      bus: 0,
      cargo: 0,
      eco: 0,
      first: 0,
    }));
  }
}

/** Compact route description of a plan, e.g. `"LHR / CDG×3, LHR / AMS×2"`. */
function describeRoutes(
  plan: ProposedFlight[],
  lines: Map<number, Line>
): string[] {
  const byLine = new Map<number, number>();
  for (const f of plan) {
    byLine.set(f.lineId, (byLine.get(f.lineId) ?? 0) + 1);
  }
  return [...byLine.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${lines.get(id)?.name ?? id}×${n}`);
}

/** Weekly demand the plan actually fills at the destination (per-day capped, both legs). */
function servedOfPlan(
  a: Aircraft,
  plan: ProposedFlight[],
  lines: Map<number, Line>
): Record<CabinClass, number> {
  // Per-day offer, then capped by each day's demand (matches the game + computeMetrics).
  const byLineDay = new Map<number, Record<CabinClass, number>[]>();
  const cap = capacityOf(a);
  for (const f of plan) {
    let days = byLineDay.get(f.lineId);
    if (!days) {
      days = Array.from({ length: DAYS_PER_WEEK }, zero);
      byLineDay.set(f.lineId, days);
    }
    const day = Math.floor((f.takeOffTime % WEEK_SECONDS) / 86_400);
    for (const c of CLASSES) {
      days[day][c] += cap[c] * LEGS_PER_ROUNDTRIP;
    }
  }
  const served = zero();
  for (const [lineId, days] of byLineDay) {
    const line = lines.get(lineId);
    if (!line) {
      continue;
    }
    for (const c of CLASSES) {
      for (let d = 0; d < DAYS_PER_WEEK; d++) {
        served[c] += Math.min(days[d][c], line.dailyDemand[c]);
      }
    }
  }
  return served;
}

// ── The rebalancer ───────────────────────────────────────────────────────────

export interface RebalanceOptions {
  /** Per-hub target average utilisation (default TARGET_UTIL = 0.95). */
  targetUtil?: number;
}

/**
 * Assign aircraft across hubs for maximum demand coverage, then schedule each
 * hub with `greedyAllocate`. Pure: mutates the in-memory `aircraft` hubIds.
 */
export function rebalanceNetwork(
  aircraft: Aircraft[],
  lines: Map<number, Line>,
  opts: RebalanceOptions = {}
): RebalanceResult {
  const targetUtil = opts.targetUtil ?? TARGET_UTIL;
  const lbh = linesByHub(lines);
  const fleet: FleetIndex = new Map(aircraft.map((a) => [a.id, a]));

  const codeByHub = hubCodes(lines.values());
  const hubIds = [...lbh.keys()];

  // Snapshot each aircraft's ORIGIN before any virtual move mutates a.hubId.
  const originHub = new Map<number, number>();
  for (const a of aircraft) {
    originHub.set(a.id, a.hubId);
  }

  // ── Network "before" metrics (from the live planningList) ────────────────────
  const beforeFlights = aircraft.map((a) => ({
    aircraftId: a.id,
    flights: a.planningList.map((p) => ({
      lineId: p.lineId,
      takeOffTime: p.takeOffTime,
    })),
  }));
  const before = computeMetrics(beforeFlights, fleet, lines);

  // Per-aircraft current utilisation (origin planning) — needed for the lock test.
  const utilBefore = new Map<number, number>();
  for (const a of aircraft) {
    utilBefore.set(a.id, utilOfPlan(a, a.planningList, lines));
  }

  const hubUtilBefore = new Map<number, number>();
  const hubFlyingBefore = new Map<number, number>();
  for (const hubId of hubIds) {
    const flying = aircraft.filter(
      (a) => originHub.get(a.id) === hubId && a.planningList.length > 0
    );
    hubUtilBefore.set(hubId, avg(flying.map((a) => utilBefore.get(a.id)!)));
    hubFlyingBefore.set(hubId, flying.length);
  }

  // ── Processing/report order: most routes first, then most demand, then code ──
  const demandOf = (hubId: number) =>
    sum(
      (lbh.get(hubId) ?? []).map(
        (l) =>
          l.weeklyDemand.eco +
          l.weeklyDemand.bus +
          l.weeklyDemand.first +
          l.weeklyDemand.cargo
      )
    );
  const order = hubIds
    .slice()
    .sort(
      (x, y) =>
        (lbh.get(y)?.length ?? 0) - (lbh.get(x)?.length ?? 0) ||
        demandOf(y) - demandOf(x) ||
        (codeByHub.get(x) ?? "").localeCompare(codeByHub.get(y) ?? "")
    );

  // Default everyone idle-at-origin; the assignment overwrites the ones that fly.
  const finalHub = new Map<number, number>();
  const finalPlan = new Map<number, ProposedFlight[]>();
  for (const a of aircraft) {
    finalHub.set(a.id, originHub.get(a.id)!);
    finalPlan.set(a.id, []);
  }

  // Fill hubs in route-count order (largest first). Surplus cascade to the next hub.
  // Pass 1: passenger aircraft until eco coverage hits the target.
  // Pass 2: freighters onto leftover cargo.
  // Source order: own fleet, then idle surplus, then working aircraft from smaller hubs.
  for (const [, hl] of lbh) {
    resetLines(hl);
  }
  const routeCountOf = (hubId: number) => lbh.get(hubId)?.length ?? 0;

  const available = new Set<number>(aircraft.map((a) => a.id));
  const usedAt = new Map<number, number[]>();
  for (const hubId of hubIds) {
    usedAt.set(hubId, []);
  }

  // Source hubs ordered by FEWEST routes first (those are cannibalised first, to feed the big hubs).
  const foreignOrder = hubIds
    .slice()
    .sort((x, y) => routeCountOf(x) - routeCountOf(y));
  const foreignRank = new Map<number, number>(
    foreignOrder.map((h, i) => [h, i])
  );

  // Commit the aircraft a batch's greedyAllocate actually used; release the rest to the pool.
  const commitBatch = (batch: Aircraft[], destHub: number): void => {
    for (const a of batch) {
      if (a.assigned.length > 0) {
        available.delete(a.id);
        finalHub.set(a.id, destHub);
        finalPlan.set(
          a.id,
          a.assigned.map((t) => ({
            lineId: t.lineId,
            takeOffTime: t.takeOffTime,
          }))
        );
        usedAt.get(destHub)?.push(a.id);
      } else {
        a.hubId = originHub.get(a.id)!;
        a.cursor = 0;
        a.assigned = [];
      }
    }
  };
  const prep = (batch: Aircraft[], destHub: number): Aircraft[] => {
    for (const a of batch) {
      a.hubId = destHub;
      a.cursor = 0;
      a.assigned = [];
    }
    return batch;
  };

  for (const destHub of order) {
    const hl = lbh.get(destHub)!;
    const fit = (a: Aircraft) => available.has(a.id) && physicallyFits(a, hl);

    // PASSENGER fill, fed in source-priority batches so greedyAllocate (which stops near eco
    // saturation, leaving the surplus to cascade) draws from the right hubs first:
    //   own working → idle surplus → foreign working, FEWEST-route hubs first (drain small hubs).
    const paxBatches: Aircraft[][] = [];
    paxBatches.push(
      aircraft.filter(
        (a) =>
          fit(a) &&
          !a.isCargo &&
          originHub.get(a.id) === destHub &&
          a.planningList.length > 0
      )
    );
    paxBatches.push(
      aircraft.filter(
        (a) => fit(a) && !a.isCargo && a.planningList.length === 0
      )
    );
    for (const src of foreignOrder) {
      if (src === destHub) {
        continue;
      }
      paxBatches.push(
        aircraft.filter(
          (a) =>
            fit(a) &&
            !a.isCargo &&
            originHub.get(a.id) === src &&
            a.planningList.length > 0
        )
      );
    }
    for (const batch of paxBatches) {
      if (batch.length === 0) {
        continue;
      }
      greedyAllocate(prep(batch, destHub), hl);
      commitBatch(batch, destHub);
    }

    // CARGO fill — FREIGHTERS onto whatever cargo is still uncovered (fewest-route hubs first).
    const freight = aircraft
      .filter((a) => fit(a) && a.isCargo)
      .sort(
        (x, y) =>
          (foreignRank.get(originHub.get(x.id)!) ?? 0) -
            (foreignRank.get(originHub.get(y.id)!) ?? 0) ||
          y.payloadUsed - x.payloadUsed
      );
    if (freight.length > 0) {
      greedyAllocate(prep(freight, destHub), hl);
      commitBatch(freight, destHub);
    }
  }

  const hubPlanDraft = order.map((hubId) => ({
    hubId,
    usedIds: usedAt.get(hubId) ?? [],
  }));

  // ── Build per-aircraft outcomes ──────────────────────────────────────────────
  const outcomes = new Map<number, AircraftOutcome>();
  for (const a of aircraft) {
    const origin = originHub.get(a.id)!;
    const dest = finalHub.get(a.id)!;
    const plan = finalPlan.get(a.id)!;
    const moved = dest !== origin;
    const flies = plan.length > 0;
    let status: AircraftOutcome["status"];
    if (!flies) {
      status = "idle";
    } else if (moved) {
      status = "moved-in"; // a redeployed aircraft (relocated hub)
    } else if (a.planningList.length === 0) {
      status = "activated"; // was idle, now flying at home
    } else {
      status = "kept"; // was already flying here (pinned working fleet)
    }
    outcomes.set(a.id, {
      category: a.category,
      destCode: codeByHub.get(dest) ?? String(dest),
      destHubId: dest,
      flightsAfter: plan.length,
      id: a.id,
      isCargo: a.isCargo,
      model: a.aircraftListName,
      moved,
      name: a.name,
      originCode: codeByHub.get(origin) ?? String(origin),
      originHubId: origin,
      plan,
      range: a.range,
      routes: describeRoutes(plan, lines),
      seats: {
        bus: a.seatsBus,
        cargo: a.payloadUsed,
        eco: a.seatsEco,
        first: a.seatsFirst,
      },
      servedAfter: servedOfPlan(a, plan, lines),
      status,
      utilAfter: utilOfPlan(a, plan, lines),
      utilBefore: utilBefore.get(a.id) ?? 0,
    });
  }

  // ── Network "after" metrics ──────────────────────────────────────────────────
  const afterFlights = aircraft.map((a) => ({
    aircraftId: a.id,
    flights: finalPlan.get(a.id)!,
  }));
  const after = computeMetrics(afterFlights, fleet, lines);

  // ── Assemble hub plans ───────────────────────────────────────────────────────
  const hubs: HubPlan[] = [];
  hubPlanDraft.forEach((draft, i) => {
    const { hubId } = draft;
    const hubLines = lbh.get(hubId) ?? [];
    const code = codeByHub.get(hubId) ?? String(hubId);

    const assignedAfter = [...outcomes.values()].filter(
      (o) => o.destHubId === hubId && o.plan.length > 0
    );
    const incoming = assignedAfter.filter((o) => o.moved);
    const added = assignedAfter.filter(
      (o) => o.status === "moved-in" || o.status === "activated"
    ).length;
    // Genuinely relocated away (idle-at-home aircraft show up in the global idle list).
    const outgoing = [...outcomes.values()].filter(
      (o) =>
        o.originHubId === hubId && o.destHubId !== hubId && o.plan.length > 0
    );

    // Per-class breakdown, aggregated from computeMetrics' per-line numbers.
    const breakdown: Record<CabinClass, ClassBreakdown> = {
      bus: {
        demand: 0,
        offeredAfter: 0,
        offeredBefore: 0,
        overAfter: 0,
        servedAfter: 0,
        servedBefore: 0,
      },
      cargo: {
        demand: 0,
        offeredAfter: 0,
        offeredBefore: 0,
        overAfter: 0,
        servedAfter: 0,
        servedBefore: 0,
      },
      eco: {
        demand: 0,
        offeredAfter: 0,
        offeredBefore: 0,
        overAfter: 0,
        servedAfter: 0,
        servedBefore: 0,
      },
      first: {
        demand: 0,
        offeredAfter: 0,
        offeredBefore: 0,
        overAfter: 0,
        servedAfter: 0,
        servedBefore: 0,
      },
    };
    for (const l of hubLines) {
      const pb = before.perLine.get(l.id);
      const pa = after.perLine.get(l.id);
      for (const c of CLASSES) {
        breakdown[c].demand += l.weeklyDemand[c];
        breakdown[c].offeredBefore += pb?.offered[c] ?? 0;
        breakdown[c].servedBefore += pb?.served[c] ?? 0;
        breakdown[c].offeredAfter += pa?.offered[c] ?? 0;
        breakdown[c].servedAfter += pa?.served[c] ?? 0;
        breakdown[c].overAfter += pa?.over[c] ?? 0;
      }
    }

    const utilAfter = avg(assignedAfter.map((o) => o.utilAfter));
    const utilBeforeHub = hubUtilBefore.get(hubId) ?? 0;
    const covB = breakdown.eco.demand
      ? breakdown.eco.servedBefore / breakdown.eco.demand
      : 1;
    const covA = breakdown.eco.demand
      ? breakdown.eco.servedAfter / breakdown.eco.demand
      : 1;

    const net = assignedAfter.length - (hubFlyingBefore.get(hubId) ?? 0);
    const strategy: HubPlan["strategy"] =
      assignedAfter.length === 0
        ? "starved"
        : net > 0
          ? "reinforced"
          : net < 0
            ? "donor"
            : "stable";
    const reasoning = reasonFor(strategy, code, {
      activated: added - incoming.length,
      assigned: assignedAfter.length,
      cargoA: breakdown.cargo.demand
        ? breakdown.cargo.servedAfter / breakdown.cargo.demand
        : 1,
      cargoB: breakdown.cargo.demand
        ? breakdown.cargo.servedBefore / breakdown.cargo.demand
        : 1,
      covA,
      covB,
      incoming: incoming.length,
      order: i + 1,
      outgoing: outgoing.length,
      routeCount: hubLines.length,
      utilAfter,
      utilBefore: utilBeforeHub,
    });

    hubs.push({
      aircraftBefore: aircraft.filter((a) => originHub.get(a.id) === hubId)
        .length,
      assignedAfter,
      breakdown,
      code,
      coverageAfterEco: covA,
      coverageBeforeEco: covB,
      flyingBefore: hubFlyingBefore.get(hubId) ?? 0,
      hitTarget: assignedAfter.length > 0 && utilAfter >= targetUtil,
      hubId,
      incoming,
      order: i + 1,
      outgoing,
      reasoning,
      routeCount: hubLines.length,
      strategy,
      utilAfter,
      utilBefore: utilBeforeHub,
    });
  });

  // ── Idle (unassigned) aircraft + the reason why ──────────────────────────────
  const idle = [...outcomes.values()].filter((o) => o.plan.length === 0);
  for (const o of idle) {
    const a = fleet.get(o.id)!;
    const reachable = hubIds.filter((h) => physicallyFits(a, lbh.get(h) ?? []));
    o.routes = []; // it flies nothing
    (o as AircraftOutcome & { reasoning?: string }).reasoning = idleReason(
      a,
      reachable,
      codeByHub
    );
  }

  const moves = [...outcomes.values()].filter(
    (o) => o.moved && o.plan.length > 0
  );

  return { after, before, codeByHub, hubs, idle, moves, outcomes, targetUtil };
}

/** Human reasoning for a hub's chosen strategy (coverage-centric). */
function reasonFor(
  strategy: HubPlan["strategy"],
  code: string,
  m: {
    routeCount: number;
    order: number;
    utilBefore: number;
    utilAfter: number;
    incoming: number;
    activated: number;
    outgoing: number;
    assigned: number;
    covB: number;
    covA: number;
    cargoB: number;
    cargoA: number;
  }
): string {
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  const cargo =
    m.cargoA - m.cargoB > 0.005
      ? ` Cargo coverage ${p(m.cargoB)} → ${p(m.cargoA)} (freighters/belly pulled in to fill it).`
      : "";
  const out =
    m.outgoing > 0
      ? ` ${m.outgoing} aircraft that fit a needier hub better were relocated away.`
      : "";
  if (strategy === "starved") {
    return `${code} (#${m.order} by route count, ${m.routeCount} routes) ends with NO aircraft: as one of the FEWEST-route hubs it was drained first to feed the higher-priority hubs (the priority cascade). Acceptable by design — small hubs may end empty.`;
  }
  if (strategy === "donor") {
    return `${code} (#${m.order}, ${m.routeCount} routes) is a NET DONOR: ${m.outgoing} of its aircraft were pulled up to higher-priority hubs in the cascade. Eco coverage here ${p(m.covB)} → ${p(m.covA)}${cargo}`;
  }
  if (strategy === "stable") {
    return `${code} (#${m.order}, ${m.routeCount} routes) keeps essentially the same fleet — its aircraft are already a best match here. Avg util ${p(m.utilAfter)}, eco coverage ${p(m.covA)}.${cargo}${out}`;
  }
  // reinforced
  return (
    `${code} is the #${m.order} priority hub (${m.routeCount} routes) and was REINFORCED to lift coverage: ${m.incoming + m.activated} aircraft added` +
    `${m.incoming > 0 ? ` (${m.incoming} MOVED IN from other hubs${m.activated > 0 ? `, ${m.activated} idle activated at home` : ""})` : m.activated > 0 ? ` (${m.activated} idle activated at home)` : ""}. ` +
    `Eco coverage ${p(m.covB)} → ${p(m.covA)}, avg util ${p(m.utilBefore)} → ${p(m.utilAfter)}.${cargo}${out}`
  );
}

/** Why a specific aircraft ends up idle (reuses the recommend.ts reasoning style). */
function idleReason(
  a: Aircraft,
  reachableHubs: number[],
  codeByHub: Map<number, string>
): string {
  if (reachableHubs.length === 0) {
    return `Category ${a.category} / range ${a.range.toLocaleString()}km fits NO route at ANY hub — too big or too short-legged for every airport you own. Sell, or buy a route that fits it.`;
  }
  const codes = reachableHubs.map((h) => codeByHub.get(h) ?? String(h));
  return `It can physically reach ${codes.join(", ")}, but at each the profitable demand was already filled by the working fleet + higher-priority idle aircraft before this one (pyramid surplus). Flying it would mean half-empty legs below break-even (loss + wear). Candidate to reconfigure (e.g. to cargo) or to a newly-bought route.`;
}
