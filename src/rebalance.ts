// ───────────────────────────────────────────────────────────────────────────
// CROSS-HUB REBALANCER  (new, standalone — does NOT touch the existing optimizer)
//
// The existing `optimize()` treats every hub as an island: an aircraft only ever
// flies the routes of ITS OWN hub (canFly enforces a.hubId === line.hubId). That
// is correct for a single-hub pass, but it leaves the network globally lopsided —
// e.g. GRU sits on an idle A380 while a demand-rich hub is starved.
//
// This rebalancer adds the missing degree of freedom: MOVING an aircraft to another
// hub (a real game action — POST /aircraft/show/<id>/attribute hubId=<loadId>). A
// "virtual move" is just setting `a.hubId = targetHub`; from there the UNCHANGED
// canFly / greedyAllocate handle range, category, granularity, anti-burst stagger
// and the break-even profit gate exactly as before. We never reimplement the
// scheduler — we only decide WHICH aircraft each hub gets, then hand the chosen
// set to the real `greedyAllocate`.
//
// Objective: MAXIMUM DEMAND COVERAGE. Serve as much of every route's demand as the
// fleet allows — Economy, Business, First AND Cargo — by sending each aircraft to its
// BEST MATCH hub. How:
//   1. Fetch all hubs + all aircraft (the CLI does this with the live API).
//   2. Start from FULL demand everywhere; reconsider EVERY aircraft (working or idle).
//      A working aircraft is relocated when another hub uses it materially better; a
//      freighter migrates to wherever CARGO is most uncovered.
//   3. Place the MOST CONSTRAINED aircraft first (those that fit the fewest hubs/routes),
//      so a specialist claims its niche before a flexible aircraft drains it (the same
//      scarcity matching greedyAllocate uses, lifted across hubs).
//   4. Score a hub by actually filling the aircraft's week there with the real
//      greedyAllocate (then undo) — this values ALL four classes at once.
//   5. As a hub fills, its marginal value drops, so later aircraft flow to the next
//      neediest hub — the surplus WATER-FILLS across every undercovered hub instead of
//      gorging the first one. Ties favour the higher-route hub (most routes first).
//   6. Every aircraft keeps its real Economy/Business/First/Cargo config (capacityOf)
//      and every existing constraint (canFly category+range, 900s grid, break-even).
//   7. Smaller hubs may end with few or zero aircraft — acceptable: an aircraft goes
//      where it serves the most demand.
//
// Pure (no network). The CLI feeds it the model built from fresh API data, and the
// scheduling itself is the UNMODIFIED greedyAllocate from optimizer.ts.
// ───────────────────────────────────────────────────────────────────────────

import { DAYS_PER_WEEK, LEGS_PER_ROUNDTRIP, WEEK_SECONDS } from "./config.ts";
import { capacityOf, linesByHub, roundTripDuration } from "./model.ts";
import { greedyAllocate } from "./optimizer.ts";
import { computeMetrics, type FleetIndex, type Metrics } from "./report.ts";
import type { Aircraft, CabinClass, Line, ProposedFlight } from "./types.ts";

const CLASSES: CabinClass[] = ["eco", "bus", "first", "cargo"];
const zero = (): Record<CabinClass, number> => ({ eco: 0, bus: 0, first: 0, cargo: 0 });

/** Each hub aims for at least this average aircraft utilisation / demand coverage. */
export const TARGET_UTIL = 0.95;

// ── Result types ─────────────────────────────────────────────────────────────

/** One aircraft's place in the final plan, with its before/after numbers. */
export interface AircraftOutcome {
  id: number;
  name: string;
  model: string;
  category: number;
  range: number;
  isCargo: boolean;
  seats: Record<CabinClass, number>; // its per-flight capacity (eco/bus/first seats, cargo tons)
  originHubId: number;
  originCode: string;
  destHubId: number; // where it ends up (== origin if it didn't move)
  destCode: string;
  moved: boolean;
  status: "kept" | "moved-in" | "activated" | "idle";
  utilBefore: number; // from the live planningList at its origin
  utilAfter: number; // from the new plan
  flightsAfter: number;
  servedAfter: Record<CabinClass, number>; // weekly demand it actually fills at the destination
  routes: string[]; // route names it now flies (with ×count)
  plan: ProposedFlight[]; // the new weekly planning (empty if idle)
}

/** Per-class demand / offer / served / oversupply for a hub, before and after. */
export interface ClassBreakdown {
  demand: number;
  offeredBefore: number;
  servedBefore: number;
  offeredAfter: number;
  servedAfter: number;
  overAfter: number;
}

export interface HubPlan {
  code: string;
  hubId: number;
  routeCount: number;
  order: number; // 1-based processing position
  strategy: "reinforced" | "donor" | "stable" | "starved";
  reasoning: string;
  // aircraft
  aircraftBefore: number; // owned originally
  flyingBefore: number;
  assignedAfter: AircraftOutcome[]; // aircraft based here AFTER the plan
  incoming: AircraftOutcome[]; // moved IN from other hubs
  outgoing: AircraftOutcome[]; // its original aircraft that moved AWAY (or were released idle)
  // utilisation
  utilBefore: number; // avg over originally-flying aircraft
  utilAfter: number; // avg over finally-assigned aircraft
  hitTarget: boolean;
  // capacity / coverage (per class, per-day capped like the game)
  breakdown: Record<CabinClass, ClassBreakdown>;
  coverageBeforeEco: number;
  coverageAfterEco: number;
}

export interface RebalanceResult {
  hubs: HubPlan[]; // in processing order (most routes first)
  moves: AircraftOutcome[]; // every cross-hub move (source -> dest)
  idle: AircraftOutcome[]; // aircraft used nowhere, with the reason in `.reasoning`
  outcomes: Map<number, AircraftOutcome>; // every aircraft by id
  before: Metrics; // network totals (current live state)
  after: Metrics; // network totals (proposed)
  codeByHub: Map<number, string>;
  targetUtil: number;
}

// ── Small helpers ────────────────────────────────────────────────────────────

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

/** Utilisation of a concrete planning (busy seconds / week, capped at 1). */
function utilOfPlan(a: Aircraft, flights: { lineId: number }[], lines: Map<number, Line>): number {
  let used = 0;
  for (const f of flights) {
    const line = lines.get(f.lineId);
    if (line) used += roundTripDuration(a, line);
  }
  return Math.min(1, used / WEEK_SECONDS);
}

/** Can this aircraft physically serve ANY route of the hub once moved there? (range + category) */
function physicallyFits(a: Aircraft, hubLines: Line[]): boolean {
  for (const l of hubLines) if (a.range >= l.distance && l.category >= a.category) return true;
  return false;
}

/** Reset a hub's per-day demand pools so greedyAllocate starts from the full demand. */
function resetLines(hubLines: Line[]): void {
  for (const l of hubLines) {
    l.remaining = Array.from({ length: DAYS_PER_WEEK }, () => ({ ...l.dailyDemand }));
    l.over = Array.from({ length: DAYS_PER_WEEK }, () => ({ eco: 0, bus: 0, first: 0, cargo: 0 }));
  }
}

/** "GRU / POA×3, GRU / REC×2" — compact route description of a plan. */
function describeRoutes(plan: ProposedFlight[], lines: Map<number, Line>): string[] {
  const byLine = new Map<number, number>();
  for (const f of plan) byLine.set(f.lineId, (byLine.get(f.lineId) ?? 0) + 1);
  return [...byLine.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${lines.get(id)?.name ?? id}×${n}`);
}

/** Weekly demand the plan actually fills at the destination (per-day capped, both legs). */
function servedOfPlan(a: Aircraft, plan: ProposedFlight[], lines: Map<number, Line>): Record<CabinClass, number> {
  // Per-day offer, then capped by each day's demand (matches the game + computeMetrics).
  const byLineDay = new Map<number, Record<CabinClass, number>[]>();
  const cap = capacityOf(a);
  for (const f of plan) {
    let days = byLineDay.get(f.lineId);
    if (!days) {
      days = Array.from({ length: DAYS_PER_WEEK }, zero);
      byLineDay.set(f.lineId, days);
    }
    const day = Math.floor((f.takeOffTime % WEEK_SECONDS) / 86400);
    for (const c of CLASSES) days[day][c] += cap[c] * LEGS_PER_ROUNDTRIP;
  }
  const served = zero();
  for (const [lineId, days] of byLineDay) {
    const line = lines.get(lineId);
    if (!line) continue;
    for (const c of CLASSES) for (let d = 0; d < DAYS_PER_WEEK; d++) served[c] += Math.min(days[d][c], line.dailyDemand[c]);
  }
  return served;
}

// ── The rebalancer ───────────────────────────────────────────────────────────

export interface RebalanceOptions {
  /** Per-hub target average utilisation (default TARGET_UTIL = 0.95). */
  targetUtil?: number;
}

export function rebalanceNetwork(aircraft: Aircraft[], lines: Map<number, Line>, opts: RebalanceOptions = {}): RebalanceResult {
  const targetUtil = opts.targetUtil ?? TARGET_UTIL;
  const lbh = linesByHub(lines);
  const fleet: FleetIndex = new Map(aircraft.map((a) => [a.id, a]));

  const codeByHub = new Map<number, string>();
  for (const l of lines.values()) if (!codeByHub.has(l.hubId)) codeByHub.set(l.hubId, l.name.split(" / ")[0]);
  const hubIds = [...lbh.keys()];

  // Snapshot each aircraft's ORIGIN before any virtual move mutates a.hubId.
  const originHub = new Map<number, number>();
  for (const a of aircraft) originHub.set(a.id, a.hubId);

  // ── Network "before" metrics (from the live planningList) ────────────────────
  const beforeFlights = aircraft.map((a) => ({
    aircraftId: a.id,
    flights: a.planningList.map((p) => ({ lineId: p.lineId, takeOffTime: p.takeOffTime })),
  }));
  const before = computeMetrics(beforeFlights, fleet, lines);

  // Per-aircraft current utilisation (origin planning) — needed for the lock test.
  const utilBefore = new Map<number, number>();
  for (const a of aircraft) utilBefore.set(a.id, utilOfPlan(a, a.planningList, lines));

  const hubUtilBefore = new Map<number, number>();
  const hubFlyingBefore = new Map<number, number>();
  for (const hubId of hubIds) {
    const flying = aircraft.filter((a) => originHub.get(a.id) === hubId && a.planningList.length > 0);
    hubUtilBefore.set(hubId, avg(flying.map((a) => utilBefore.get(a.id)!)));
    hubFlyingBefore.set(hubId, flying.length);
  }

  // ── Processing/report order: most routes first, then most demand, then code ──
  const demandOf = (hubId: number) =>
    sum((lbh.get(hubId) ?? []).map((l) => l.weeklyDemand.eco + l.weeklyDemand.bus + l.weeklyDemand.first + l.weeklyDemand.cargo));
  const order = hubIds.slice().sort(
    (x, y) => (lbh.get(y)?.length ?? 0) - (lbh.get(x)?.length ?? 0) || demandOf(y) - demandOf(x) || (codeByHub.get(x) ?? "").localeCompare(codeByHub.get(y) ?? ""),
  );

  // Default everyone idle-at-origin; the assignment overwrites the ones that fly.
  const finalHub = new Map<number, number>();
  const finalPlan = new Map<number, ProposedFlight[]>();
  for (const a of aircraft) {
    finalHub.set(a.id, originHub.get(a.id)!);
    finalPlan.set(a.id, []);
  }

  // ── PRIORITY ECO CASCADE ─────────────────────────────────────────────────────
  // Objective: ECO coverage. Each hub, in priority order (most routes first), is filled
  // toward ~TARGET_ECO eco, then the LEFTOVER fleet cascades to the next hub.
  //   · PASS 1 (eco): add PASSENGER aircraft one at a time until the hub's eco coverage
  //     hits the target, then STOP — surplus aircraft cascade on instead of flying eco
  //     half-empty, so ECO oversupply (the burst that matters) stays minimal. (Business/
  //     First oversupply from fixed cabins is accepted — the user only cares about eco.)
  //   · PASS 2 (cargo): add FREIGHTERS onto whatever cargo the hub still has uncovered —
  //     "fill leftover cargo with freighters".
  //   · SOURCE PRIORITY when pulling aircraft in: the hub's OWN aircraft first (no move),
  //     then the IDLE surplus, then cannibalise WORKING aircraft from OTHER hubs starting
  //     with the FEWEST-route hubs — small hubs are drained to feed the big ones, big hubs
  //     keep their own fleet. Low-priority hubs may end empty — by design.
  for (const [, hl] of lbh) resetLines(hl);
  const routeCountOf = (hubId: number) => lbh.get(hubId)?.length ?? 0;

  const available = new Set<number>(aircraft.map((a) => a.id));
  const usedAt = new Map<number, number[]>();
  for (const hubId of hubIds) usedAt.set(hubId, []);

  // Source hubs ordered by FEWEST routes first (those are cannibalised first, to feed the big hubs).
  const foreignOrder = hubIds.slice().sort((x, y) => routeCountOf(x) - routeCountOf(y));
  const foreignRank = new Map<number, number>(foreignOrder.map((h, i) => [h, i]));

  // Commit the aircraft a batch's greedyAllocate actually used; release the rest to the pool.
  const commitBatch = (batch: Aircraft[], destHub: number): void => {
    for (const a of batch) {
      if (a.assigned.length > 0) {
        available.delete(a.id);
        finalHub.set(a.id, destHub);
        finalPlan.set(a.id, a.assigned.map((t) => ({ takeOffTime: t.takeOffTime, lineId: t.lineId })));
        usedAt.get(destHub)!.push(a.id);
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
    paxBatches.push(aircraft.filter((a) => fit(a) && !a.isCargo && originHub.get(a.id) === destHub && a.planningList.length > 0));
    paxBatches.push(aircraft.filter((a) => fit(a) && !a.isCargo && a.planningList.length === 0));
    for (const src of foreignOrder) {
      if (src === destHub) continue;
      paxBatches.push(aircraft.filter((a) => fit(a) && !a.isCargo && originHub.get(a.id) === src && a.planningList.length > 0));
    }
    for (const batch of paxBatches) {
      if (batch.length === 0) continue;
      greedyAllocate(prep(batch, destHub), hl);
      commitBatch(batch, destHub);
    }

    // CARGO fill — FREIGHTERS onto whatever cargo is still uncovered (fewest-route hubs first).
    const freight = aircraft
      .filter((a) => fit(a) && a.isCargo)
      .sort((x, y) => (foreignRank.get(originHub.get(x.id)!) ?? 0) - (foreignRank.get(originHub.get(y.id)!) ?? 0) || y.payloadUsed - x.payloadUsed);
    if (freight.length > 0) {
      greedyAllocate(prep(freight, destHub), hl);
      commitBatch(freight, destHub);
    }
  }

  const hubPlanDraft = order.map((hubId) => ({ hubId, usedIds: usedAt.get(hubId) ?? [] }));

  // ── Build per-aircraft outcomes ──────────────────────────────────────────────
  const outcomes = new Map<number, AircraftOutcome>();
  for (const a of aircraft) {
    const origin = originHub.get(a.id)!;
    const dest = finalHub.get(a.id)!;
    const plan = finalPlan.get(a.id)!;
    const moved = dest !== origin;
    const flies = plan.length > 0;
    let status: AircraftOutcome["status"];
    if (!flies) status = "idle";
    else if (moved) status = "moved-in"; // a redeployed aircraft (relocated hub)
    else if (a.planningList.length === 0) status = "activated"; // was idle, now flying at home
    else status = "kept"; // was already flying here (pinned working fleet)
    outcomes.set(a.id, {
      id: a.id,
      name: a.name,
      model: a.aircraftListName,
      category: a.category,
      range: a.range,
      isCargo: a.isCargo,
      seats: { eco: a.seatsEco, bus: a.seatsBus, first: a.seatsFirst, cargo: a.payloadUsed },
      originHubId: origin,
      originCode: codeByHub.get(origin) ?? String(origin),
      destHubId: dest,
      destCode: codeByHub.get(dest) ?? String(dest),
      moved,
      status,
      utilBefore: utilBefore.get(a.id) ?? 0,
      utilAfter: utilOfPlan(a, plan, lines),
      flightsAfter: plan.length,
      servedAfter: servedOfPlan(a, plan, lines),
      routes: describeRoutes(plan, lines),
      plan,
    });
  }

  // ── Network "after" metrics ──────────────────────────────────────────────────
  const afterFlights = aircraft.map((a) => ({ aircraftId: a.id, flights: finalPlan.get(a.id)! }));
  const after = computeMetrics(afterFlights, fleet, lines);

  // ── Assemble hub plans ───────────────────────────────────────────────────────
  const hubs: HubPlan[] = [];
  hubPlanDraft.forEach((draft, i) => {
    const { hubId } = draft;
    const hubLines = lbh.get(hubId) ?? [];
    const code = codeByHub.get(hubId) ?? String(hubId);

    const assignedAfter = [...outcomes.values()].filter((o) => o.destHubId === hubId && o.plan.length > 0);
    const incoming = assignedAfter.filter((o) => o.moved);
    const added = assignedAfter.filter((o) => o.status === "moved-in" || o.status === "activated").length;
    // Genuinely relocated away (idle-at-home aircraft show up in the global idle list).
    const outgoing = [...outcomes.values()].filter((o) => o.originHubId === hubId && o.destHubId !== hubId && o.plan.length > 0);

    // Per-class breakdown, aggregated from computeMetrics' per-line numbers.
    const breakdown: Record<CabinClass, ClassBreakdown> = {
      eco: { demand: 0, offeredBefore: 0, servedBefore: 0, offeredAfter: 0, servedAfter: 0, overAfter: 0 },
      bus: { demand: 0, offeredBefore: 0, servedBefore: 0, offeredAfter: 0, servedAfter: 0, overAfter: 0 },
      first: { demand: 0, offeredBefore: 0, servedBefore: 0, offeredAfter: 0, servedAfter: 0, overAfter: 0 },
      cargo: { demand: 0, offeredBefore: 0, servedBefore: 0, offeredAfter: 0, servedAfter: 0, overAfter: 0 },
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
    const covB = breakdown.eco.demand ? breakdown.eco.servedBefore / breakdown.eco.demand : 1;
    const covA = breakdown.eco.demand ? breakdown.eco.servedAfter / breakdown.eco.demand : 1;

    const net = assignedAfter.length - (hubFlyingBefore.get(hubId) ?? 0);
    const strategy: HubPlan["strategy"] = assignedAfter.length === 0 ? "starved" : net > 0 ? "reinforced" : net < 0 ? "donor" : "stable";
    const reasoning = reasonFor(strategy, code, {
      routeCount: hubLines.length,
      order: i + 1,
      utilBefore: utilBeforeHub,
      utilAfter,
      incoming: incoming.length,
      activated: added - incoming.length,
      outgoing: outgoing.length,
      assigned: assignedAfter.length,
      covB,
      covA,
      cargoB: breakdown.cargo.demand ? breakdown.cargo.servedBefore / breakdown.cargo.demand : 1,
      cargoA: breakdown.cargo.demand ? breakdown.cargo.servedAfter / breakdown.cargo.demand : 1,
    });

    hubs.push({
      code,
      hubId,
      routeCount: hubLines.length,
      order: i + 1,
      strategy,
      reasoning,
      aircraftBefore: aircraft.filter((a) => originHub.get(a.id) === hubId).length,
      flyingBefore: hubFlyingBefore.get(hubId) ?? 0,
      assignedAfter,
      incoming,
      outgoing,
      utilBefore: utilBeforeHub,
      utilAfter,
      hitTarget: assignedAfter.length > 0 && utilAfter >= targetUtil,
      breakdown,
      coverageBeforeEco: covB,
      coverageAfterEco: covA,
    });
  });

  // ── Idle (unassigned) aircraft + the reason why ──────────────────────────────
  const idle = [...outcomes.values()].filter((o) => o.plan.length === 0);
  for (const o of idle) {
    const a = fleet.get(o.id)!;
    const reachable = hubIds.filter((h) => physicallyFits(a, lbh.get(h) ?? []));
    o.routes = []; // it flies nothing
    (o as AircraftOutcome & { reasoning?: string }).reasoning = idleReason(a, reachable, codeByHub);
  }

  const moves = [...outcomes.values()].filter((o) => o.moved && o.plan.length > 0);

  return { hubs, moves, idle, outcomes, before, after, codeByHub, targetUtil };
}

/** Human reasoning for a hub's chosen strategy (coverage-centric). */
function reasonFor(
  strategy: HubPlan["strategy"],
  code: string,
  m: { routeCount: number; order: number; utilBefore: number; utilAfter: number; incoming: number; activated: number; outgoing: number; assigned: number; covB: number; covA: number; cargoB: number; cargoA: number },
): string {
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  const cargo = m.cargoA - m.cargoB > 0.005 ? ` Cargo coverage ${p(m.cargoB)} → ${p(m.cargoA)} (freighters/belly pulled in to fill it).` : "";
  const out = m.outgoing > 0 ? ` ${m.outgoing} aircraft that fit a needier hub better were relocated away.` : "";
  if (strategy === "starved")
    return `${code} (#${m.order} by route count, ${m.routeCount} routes) ends with NO aircraft: as one of the FEWEST-route hubs it was drained first to feed the higher-priority hubs (the priority cascade). Acceptable by design — small hubs may end empty.`;
  if (strategy === "donor")
    return `${code} (#${m.order}, ${m.routeCount} routes) is a NET DONOR: ${m.outgoing} of its aircraft were pulled up to higher-priority hubs in the cascade. Eco coverage here ${p(m.covB)} → ${p(m.covA)}${cargo}`;
  if (strategy === "stable")
    return `${code} (#${m.order}, ${m.routeCount} routes) keeps essentially the same fleet — its aircraft are already a best match here. Avg util ${p(m.utilAfter)}, eco coverage ${p(m.covA)}.${cargo}${out}`;
  // reinforced
  return (
    `${code} is the #${m.order} priority hub (${m.routeCount} routes) and was REINFORCED to lift coverage: ${m.incoming + m.activated} aircraft added` +
    `${m.incoming > 0 ? ` (${m.incoming} MOVED IN from other hubs${m.activated > 0 ? `, ${m.activated} idle activated at home` : ""})` : m.activated > 0 ? ` (${m.activated} idle activated at home)` : ""}. ` +
    `Eco coverage ${p(m.covB)} → ${p(m.covA)}, avg util ${p(m.utilBefore)} → ${p(m.utilAfter)}.${cargo}${out}`
  );
}

/** Why a specific aircraft ends up idle (reuses the recommend.ts reasoning style). */
function idleReason(a: Aircraft, reachableHubs: number[], codeByHub: Map<number, string>): string {
  if (reachableHubs.length === 0)
    return `Category ${a.category} / range ${a.range.toLocaleString()}km fits NO route at ANY hub — too big or too short-legged for every airport you own. Sell, or buy a route that fits it.`;
  const codes = reachableHubs.map((h) => codeByHub.get(h) ?? String(h));
  return `It can physically reach ${codes.join(", ")}, but at each the profitable demand was already filled by the working fleet + higher-priority idle aircraft before this one (pyramid surplus). Flying it would mean half-empty legs below break-even (loss + wear). Candidate to reconfigure (e.g. to cargo) or to a newly-bought route.`;
}
