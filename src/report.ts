import { DAY_SECONDS, DAYS_PER_WEEK, DEMAND_DAYS, LEGS_PER_ROUNDTRIP, WEEK_SECONDS } from "./config.ts";
import { capacityOf, roundTripDuration } from "./model.ts";
import type { Aircraft, AircraftPlan, CabinClass, Line } from "./types.ts";

const CLASSES: CabinClass[] = ["eco", "bus", "first", "cargo"];
const PAX: CabinClass[] = ["eco", "bus", "first"];
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const money = (n: number) => `€${fmt(n)}`;
const zero = (): Record<CabinClass, number> => ({ eco: 0, bus: 0, first: 0, cargo: 0 });

/** Fleet indexed by id. */
export type FleetIndex = Map<number, Aircraft>;

/** A flight with its take-off time, so offer can be bucketed by DEPARTURE DAY. */
export interface FlightRef {
  lineId: number;
  takeOffTime: number;
}

export interface Metrics {
  /** Average utilization of the flying aircraft. */
  fleetUtil: number;
  /** Minimum / p10 / maximum utilization. */
  utilMin: number;
  utilP10: number;
  utilMax: number;
  /** Aircraft with utilization >= 99%. */
  near100: number;
  /** Aircraft with at least one flight. */
  flying: number;
  /** UNUSED aircraft (0 flights). */
  idle: number;
  totalFlights: number;
  /** Weekly served value (PER-DAY demand-capped) in €. */
  servedValue: number;
  /** Total per-day pax oversupply (Σ over days & routes of seats above that day's demand). */
  oversupply: number;
  /** Demand coverage per class: served / demand (served is per-day capped). */
  coverage: Record<CabinClass, { offered: number; demand: number; served: number }>;
  /** Per-route weekly offer, per-day served, and per-day oversupply (for the route tables). */
  perLine: Map<number, { offered: Record<CabinClass, number>; served: Record<CabinClass, number>; over: Record<CabinClass, number> }>;
}

/**
 * Compute metrics for a set of flights (with take-off times) per aircraft. Crucially
 * the offer is measured PER DAY: the game regenerates demand every day and meters it
 * per day, so a route is served only up to `dailyDemand` EACH day and anything above
 * is oversupply. (The old weekly-only metric hid exactly the bug we are fixing.)
 * Works for both the CURRENT state (real planningList) and the PROPOSED one.
 */
export function computeMetrics(
  flightsByAircraft: { aircraftId: number; flights: FlightRef[] }[],
  fleet: FleetIndex,
  lines: Map<number, Line>,
): Metrics {
  // offeredByDay[lineId][day][class] = seats offered departing that day.
  const offeredByDay = new Map<number, Record<CabinClass, number>[]>();
  let totalFlights = 0;
  let flying = 0;
  let idle = 0;
  const utils: number[] = [];

  for (const { aircraftId, flights } of flightsByAircraft) {
    const a = fleet.get(aircraftId);
    if (!a) continue;
    if (flights.length > 0) flying++;
    else idle++;
    let used = 0;
    const cap = capacityOf(a);
    for (const f of flights) {
      const line = lines.get(f.lineId);
      if (!line) continue;
      used += roundTripDuration(a, line);
      const day = Math.floor((f.takeOffTime % WEEK_SECONDS) / DAY_SECONDS);
      let days = offeredByDay.get(f.lineId);
      if (!days) {
        days = Array.from({ length: DAYS_PER_WEEK }, zero);
        offeredByDay.set(f.lineId, days);
      }
      // A round trip offers BOTH legs against the daily demand (matches the game).
      for (const c of CLASSES) days[day][c] += cap[c] * LEGS_PER_ROUNDTRIP;
      totalFlights++;
    }
    if (flights.length > 0) utils.push(Math.min(1, used / WEEK_SECONDS));
  }

  utils.sort((x, y) => x - y);
  const utilSum = utils.reduce((s, u) => s + u, 0);
  const utilMin = utils[0] ?? 0;
  const utilP10 = utils[Math.floor(utils.length / 10)] ?? 0;
  const utilMax = utils[utils.length - 1] ?? 0;
  const near100 = utils.filter((u) => u >= 0.99).length;

  const coverage: Metrics["coverage"] = {
    eco: { offered: 0, demand: 0, served: 0 },
    bus: { offered: 0, demand: 0, served: 0 },
    first: { offered: 0, demand: 0, served: 0 },
    cargo: { offered: 0, demand: 0, served: 0 },
  };
  const perLine: Metrics["perLine"] = new Map();
  let servedValue = 0;
  let oversupply = 0;

  for (const [lineId, line] of lines) {
    const days = offeredByDay.get(lineId);
    const offered = zero();
    const served = zero();
    const over = zero();
    for (const c of CLASSES) {
      const daily = line.dailyDemand[c];
      for (let d = 0; d < DAYS_PER_WEEK; d++) {
        const o = days?.[d][c] ?? 0;
        offered[c] += o;
        served[c] += Math.min(o, daily); // capped by THAT day's demand
        over[c] += Math.max(0, o - daily); // seats above that day's demand
      }
      coverage[c].offered += offered[c];
      coverage[c].demand += line.weeklyDemand[c];
      coverage[c].served += served[c];
      servedValue += served[c] * line.price[c]; // served already counts both legs
      if (c !== "cargo") oversupply += over[c];
    }
    if (days) perLine.set(lineId, { offered, served, over });
  }

  return {
    fleetUtil: flying ? utilSum / flying : 0,
    utilMin,
    utilP10,
    utilMax,
    near100,
    flying,
    idle,
    totalFlights,
    servedValue,
    oversupply,
    coverage,
    perLine,
  };
}

const hr = (c = "─") => c.repeat(78);

/** Route analysis: demand and potential value per line. */
export function printRouteAnalysis(lines: Map<number, Line>): void {
  console.log(`\n${hr("═")}\n  ROUTE ANALYSIS (${lines.size} routes)  ·  demand x${DEMAND_DAYS} days\n${hr("═")}`);
  const arr = [...lines.values()].map((l) => {
    const value =
      l.weeklyDemand.eco * l.price.eco +
      l.weeklyDemand.bus * l.price.bus +
      l.weeklyDemand.first * l.price.first +
      l.weeklyDemand.cargo * l.price.cargo;
    return { l, value: value * LEGS_PER_ROUNDTRIP };
  });
  arr.sort((a, b) => b.value - a.value);
  console.log(
    `  ${"route".padEnd(13)} ${"cat".padStart(3)} ${"dist".padStart(6)} ` +
      `${"demEco".padStart(7)} ${"demBus".padStart(6)} ${"demFst".padStart(6)} ${"demCgo".padStart(6)} ` +
      `${"value/wk".padStart(12)}`,
  );
  console.log(`  ${hr("─").slice(2)}`);
  for (const { l, value } of arr.slice(0, 20)) {
    console.log(
      `  ${l.name.padEnd(13)} ${String(l.category).padStart(3)} ${fmt(l.distance).padStart(6)} ` +
        `${fmt(l.weeklyDemand.eco).padStart(7)} ${fmt(l.weeklyDemand.bus).padStart(6)} ` +
        `${fmt(l.weeklyDemand.first).padStart(6)} ${fmt(l.weeklyDemand.cargo).padStart(6)} ` +
        `${money(value).padStart(12)}`,
    );
  }
  if (arr.length > 20) console.log(`  ... and ${arr.length - 20} more routes`);
}

/** Fleet analysis: summary by model. */
export function printFleetAnalysis(aircraft: Aircraft[]): void {
  console.log(`\n${hr("═")}\n  FLEET ANALYSIS (${aircraft.length} aircraft)\n${hr("═")}`);
  const byModel = new Map<string, Aircraft[]>();
  for (const a of aircraft) {
    const k = a.aircraftListName;
    (byModel.get(k) ?? byModel.set(k, []).get(k)!).push(a);
  }
  console.log(
    `  ${"model".padEnd(12)} ${"n".padStart(4)} ${"eco".padStart(5)} ${"bus".padStart(5)} ` +
      `${"fst".padStart(4)} ${"cargo".padStart(6)} ${"range".padStart(7)} ${"speed".padStart(6)} ${"util".padStart(6)}`,
  );
  console.log(`  ${hr("─").slice(2)}`);
  for (const [model, list] of byModel) {
    const s = list[0];
    const avgUtil = list.reduce((x, a) => x + a.utilizationPercentage, 0) / list.length;
    console.log(
      `  ${model.padEnd(12)} ${String(list.length).padStart(4)} ${fmt(s.seatsEco).padStart(5)} ` +
        `${fmt(s.seatsBus).padStart(5)} ${fmt(s.seatsFirst).padStart(4)} ${fmt(s.payloadUsed).padStart(6)} ` +
        `${fmt(s.range).padStart(7)} ${fmt(s.speed).padStart(6)} ${avgUtil.toFixed(0).padStart(5)}%`,
    );
  }
}

/** Per-hub summary of the proposed plan (util, routes, oversupply). */
export function printHubSummary(aircraft: Aircraft[], lines: Map<number, Line>): void {
  console.log(`\n${hr("═")}\n  PER-HUB SUMMARY (proposed)\n${hr("═")}`);
  const hubCode = new Map<number, string>();
  const hubRoutes = new Map<number, number>();
  for (const l of lines.values()) {
    if (!hubCode.has(l.hubId)) hubCode.set(l.hubId, l.name.split(" / ")[0]);
    hubRoutes.set(l.hubId, (hubRoutes.get(l.hubId) ?? 0) + 1);
  }

  type Agg = { planes: number; utilSum: number; flights: number; over: number };
  const byHub = new Map<number, Agg>();
  for (const a of aircraft) {
    const g = byHub.get(a.hubId) ?? { planes: 0, utilSum: 0, flights: 0, over: 0 };
    const used = a.assigned.reduce((s, t) => s + t.duration, 0);
    g.planes++;
    g.utilSum += Math.min(1, used / WEEK_SECONDS);
    g.flights += a.assigned.length;
    byHub.set(a.hubId, g);
  }
  for (const l of lines.values()) {
    const g = byHub.get(l.hubId);
    if (!g) continue;
    for (let d = 0; d < DAYS_PER_WEEK; d++) g.over += l.over[d].eco + l.over[d].bus + l.over[d].first;
  }

  console.log(
    `  ${"hub".padEnd(5)} ${"aircraft".padStart(8)} ${"routes".padStart(6)} ${"util".padStart(7)} ${"flights".padStart(7)} ${"pax oversupply".padStart(14)}`,
  );
  console.log(`  ${hr("─").slice(2)}`);
  for (const [hubId, g] of [...byHub.entries()].sort((a, b) => b[1].planes - a[1].planes)) {
    console.log(
      `  ${(hubCode.get(hubId) ?? String(hubId)).padEnd(5)} ${String(g.planes).padStart(8)} ` +
        `${String(hubRoutes.get(hubId) ?? 0).padStart(6)} ${pct(g.planes ? g.utilSum / g.planes : 0).padStart(7)} ` +
        `${fmt(g.flights).padStart(7)} ${fmt(Math.round(g.over)).padStart(14)}`,
    );
  }
}

/** Compare CURRENT vs PROPOSED metrics. */
export function printComparison(before: Metrics, after: Metrics): void {
  console.log(`\n${hr("═")}\n  RESULT: CURRENT  ->  PROPOSED\n${hr("═")}`);
  const row = (label: string, b: string, a: string) =>
    console.log(`  ${label.padEnd(26)} ${b.padStart(16)}   ->  ${a.padStart(16)}`);
  row("Flying aircraft", String(before.flying), String(after.flying));
  row("UNUSED aircraft", String(before.idle), String(after.idle));
  row("Flights / week", fmt(before.totalFlights), fmt(after.totalFlights));
  row("Average utilization", pct(before.fleetUtil), pct(after.fleetUtil));
  row("Minimum utilization", pct(before.utilMin), pct(after.utilMin));
  row("p10 utilization (worst 10%)", pct(before.utilP10), pct(after.utilP10));
  row("Aircraft >= 99% util", `${before.near100}/${before.flying}`, `${after.near100}/${after.flying}`);
  row("Per-day pax OVERSUPPLY", fmt(before.oversupply), fmt(after.oversupply));
  row("Served value / week", money(before.servedValue), money(after.servedValue));
  console.log(`  ${hr("─").slice(2)}`);
  console.log(`  Demand coverage (served / demand, per-day capped):`);
  for (const c of CLASSES) {
    const b = before.coverage[c];
    const a = after.coverage[c];
    const bc = b.demand ? b.served / b.demand : 0;
    const ac = a.demand ? a.served / a.demand : 0;
    console.log(
      `    ${c.toUpperCase().padEnd(6)} ${pct(bc).padStart(7)} (${fmt(b.offered).padStart(8)} off) ` +
        `->  ${pct(ac).padStart(7)} (${fmt(a.offered).padStart(8)} off)  · demand ${fmt(a.demand)}`,
    );
  }
  const delta = after.servedValue - before.servedValue;
  console.log(`  ${hr("─").slice(2)}`);
  console.log(`  Δ Served value: ${delta >= 0 ? "+" : ""}${money(delta)} / week`);
}

const signed = (n: number) => (n >= 0 ? `+${fmt(n)}` : fmt(n));

/**
 * Per-route oversupply (offer − demand). Shows the most "negative" routes to
 * check none blows up, and how much eco demand is left free.
 */
export function printOversupply(after: Metrics, lines: Map<number, Line>, n = 12): void {
  console.log(`\n${hr("═")}\n  PER-DAY OVERSUPPLY PER ROUTE (seats above that day's demand, summed over the week)\n${hr("═")}`);
  const rows = [...lines.values()].map((l) => {
    const pl = after.perLine.get(l.id);
    const over = pl?.over ?? zero();
    const served = pl?.served ?? zero();
    const totalOver = over.eco + over.bus + over.first;
    return { l, over, served, totalOver };
  });

  const most = [...rows].filter((r) => r.totalOver > 0).sort((a, b) => b.totalOver - a.totalOver);
  console.log(`  Most oversupplied (empty seats flown above per-day demand):`);
  if (most.length === 0) console.log("    (no per-day oversupply — every flight serves real demand)");
  for (const r of most.slice(0, n)) {
    console.log(
      `    ${r.l.name.padEnd(13)} eco ${signed(r.over.eco).padStart(7)}  bus ${signed(r.over.bus).padStart(6)}  ` +
        `fst ${signed(r.over.first).padStart(5)}`,
    );
  }

  const free = [...rows]
    .map((r) => ({ name: r.l.name, ecoFree: r.l.weeklyDemand.eco - r.served.eco }))
    .filter((r) => r.ecoFree > 0)
    .sort((a, b) => b.ecoFree - a.ecoFree);
  const freeTotal = free.reduce((s, r) => s + r.ecoFree, 0);
  console.log(`  ${hr("─").slice(2)}`);
  console.log(`  Uncovered ECO demand: ${fmt(freeTotal)} seats/week across ${free.length} routes (room for more aircraft).`);
}

/** Per-aircraft detail of the proposed plan (first N). */
export function printPlanSample(plans: AircraftPlan[], fleet: FleetIndex, lines: Map<number, Line>, n = 12): void {
  console.log(`\n${hr("═")}\n  PROPOSED PLAN — sample of ${Math.min(n, plans.length)} aircraft\n${hr("═")}`);
  for (const plan of plans.slice(0, n)) {
    const a = fleet.get(plan.aircraftId);
    if (!a) continue;
    const byLine = new Map<number, number>();
    for (const f of plan.added) byLine.set(f.lineId, (byLine.get(f.lineId) ?? 0) + 1);
    const desc = [...byLine.entries()]
      .map(([lineId, c]) => `${lines.get(lineId)?.name ?? lineId}×${c}`)
      .join(", ");
    const used = plan.added.reduce((s, f) => {
      const line = lines.get(f.lineId);
      return s + (line ? roundTripDuration(a, line) : 0);
    }, 0);
    console.log(
      `  ${a.name.padEnd(12)} ${a.aircraftListName.padEnd(10)} ` +
        `${String(plan.added.length).padStart(2)} flights  util ${pct(Math.min(1, used / WEEK_SECONDS)).padStart(6)}  ${desc}`,
    );
  }
}
