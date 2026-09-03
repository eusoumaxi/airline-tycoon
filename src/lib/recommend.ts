/**
 * @fileoverview Buy / reconfigure / surplus advice from an optimized plan.
 *
 * Pure (no network). Optional cached `BuyableRoute[]` from `bun run buyroute`.
 */
import {
  BUY_CATALOG,
  CABIN_EQUIV,
  DAY_SECONDS,
  DAYS_PER_WEEK,
  DEFAULT_TURNAROUND,
  LEGS_PER_ROUNDTRIP,
  TIME_GRANULARITY,
  WEEK_SECONDS,
} from "./config.ts";
import { fmt } from "./format.ts";
import { canFly, capacityOf } from "./model.ts";
import { greedyAllocate } from "./optimizer.ts";
import {
  type Aircraft,
  type BuyableRoute,
  type BuyModel,
  type BuyOrder,
  CABIN_CLASSES,
  type CabinClass,
  type CabinConfig,
  emptyCabin,
  type FillPlan,
  type HubAdvice,
  type Line,
  PAX_CLASSES,
  type ProposedFlight,
  type SurplusAction,
  type SurplusGroup,
  type UnderservedRoute,
} from "./types.ts";

const CLASSES = CABIN_CLASSES;
const PAX = PAX_CLASSES;
const zero = emptyCabin;

/**
 * Weekly served seats/tons per line, PER-DAY capped (matches the game). Computed
 * once for the whole fleet so any hub can read any line's served amount.
 */
export function computeServedByLine(
  aircraft: Aircraft[],
  lines: Map<number, Line>,
  plansById: Map<number, ProposedFlight[]>
): Map<number, Record<CabinClass, number>> {
  const offeredByDay = new Map<number, Record<CabinClass, number>[]>();
  for (const a of aircraft) {
    const plan = plansById.get(a.id) ?? [];
    const cap = capacityOf(a);
    for (const f of plan) {
      let days = offeredByDay.get(f.lineId);
      if (!days) {
        days = Array.from({ length: DAYS_PER_WEEK }, zero);
        offeredByDay.set(f.lineId, days);
      }
      const day = Math.floor((f.takeOffTime % WEEK_SECONDS) / DAY_SECONDS);
      for (const c of CLASSES) {
        days[day][c] += cap[c] * LEGS_PER_ROUNDTRIP;
      }
    }
  }
  const served = new Map<number, Record<CabinClass, number>>();
  for (const [lineId, line] of lines) {
    const days = offeredByDay.get(lineId);
    const s = zero();
    for (const c of CLASSES) {
      for (let d = 0; d < DAYS_PER_WEEK; d++) {
        s[c] += Math.min(days?.[d][c] ?? 0, line.dailyDemand[c]);
      }
    }
    served.set(lineId, s);
  }
  return served;
}

/** Does a catalog model qualify to fly this route? (route.category >= model.cat, in range) */
function modelFits(m: BuyModel, line: Line): boolean {
  return line.category >= m.cat && m.range >= line.distance;
}

/** Pick the catalog model for a route (passenger or freighter): highest-cat that fits. */
function pickModel(line: Line, cargo: boolean): BuyModel | undefined {
  return BUY_CATALOG.filter(
    (m) => !!m.cargo === cargo && modelFits(m, line)
  ).sort(
    (a, b) =>
      b.cat - a.cat || b.paxMax - a.paxMax || b.payloadMax - a.payloadMax
  )[0];
}

/** Round-trip duration (s) of a catalog model on a distance (same rounding as the optimizer). */
function modelRtDuration(m: BuyModel, distanceKm: number): number {
  const raw = ((2 * distanceKm) / m.speed) * 3600 + DEFAULT_TURNAROUND;
  return Math.ceil(raw / TIME_GRANULARITY) * TIME_GRANULARITY;
}

/**
 * Seat/cargo config for a model tuned to a demand mix. The cabin is an "equivalent"
 * budget (paxMax all-eco units): a bus seat costs 2, first costs 3, a cargo ton 2.
 * We reserve the cargo tons first, then split the remaining cabin across eco/bus/first
 * proportional to the demand mix — eco-heavy demand → eco-heavy cabin.
 */
export function configFor(
  m: BuyModel,
  demand: Record<CabinClass, number>,
  cargoTons: number
): CabinConfig {
  const pe = demand.eco,
    pb = demand.bus,
    pf = demand.first;
  const paxSum = pe + pb + pf || 1;
  const cargo = Math.min(m.payloadMax, Math.max(0, Math.round(cargoTons)));
  const paxEquiv = Math.max(0, m.paxMax - cargo * CABIN_EQUIV.cargoTon);
  const bus = Math.max(
    0,
    Math.round((paxEquiv * pb) / paxSum / CABIN_EQUIV.bus)
  );
  const first = Math.max(
    0,
    Math.round((paxEquiv * pf) / paxSum / CABIN_EQUIV.first)
  );
  let eco = Math.max(0, Math.round((paxEquiv * pe) / paxSum / CABIN_EQUIV.eco));
  // Rounding can push the total a hair over the cabin budget — trim eco so the config
  // ALWAYS fits (eco + 2·bus + 3·first + 2·cargo ≤ paxMax), i.e. it's buildable in-game.
  const over =
    eco * CABIN_EQUIV.eco +
    bus * CABIN_EQUIV.bus +
    first * CABIN_EQUIV.first -
    paxEquiv;
  if (over > 0) {
    eco = Math.max(0, eco - Math.ceil(over));
  }
  return { bus, cargo, eco, first };
}

const sumClass = (
  rows: Record<CabinClass, number>[]
): Record<CabinClass, number> => {
  const t = zero();
  for (const r of rows) {
    for (const c of CLASSES) {
      t[c] += r[c];
    }
  }
  return t;
};

// ── Buy SIMULATOR ────────────────────────────────────────────────────────────
// Instead of estimating with a formula, we BUILD the candidate aircraft (with a
// demand-tuned eco/bus/first/cargo config), drop them into the SAME optimizer that
// schedules the real fleet, and let it place them on the LEFTOVER demand. Whatever
// it actually uses (≥1 flight) is what you need to buy; the rest stay idle. Profit,
// routes and utilization come straight from the optimizer — and because passenger
// bellies and freighters draw from the SAME shared demand pools, cargo is never
// double-counted. This is exactly the fleet you'd get after buying + re-optimizing.

// Deterministic negative id per (hub, index) so synthetics never collide with real
// aircraft AND the result doesn't depend on how many synthetics other hubs created
// first (the id feeds phaseOffset, which staggers take-offs — a global counter made
// the same hub schedule differently between runs).
function makeSynthetic(
  m: BuyModel,
  config: CabinConfig,
  hubId: number,
  idx: number
): Aircraft {
  return {
    aircraftListName: m.model,
    assigned: [],
    category: m.cat,
    consumption: 0,
    cursor: 0,
    hubId,
    id: -(hubId * 1_000_000 + idx),
    isCargo: !!m.cargo,
    isRental: false,
    lineList: {},
    name: `NEW ${m.model}`,
    payloadUsed: config.cargo,
    picture: "",
    planningList: [],
    range: m.range,
    seatsBus: config.bus,
    seatsEco: config.eco,
    seatsFirst: config.first,
    speed: m.speed,
    turnaround: DEFAULT_TURNAROUND,
    utilizationPercentage: 0,
  };
}

/** Belly cargo for a pax model on a hub's pax mix (cargo-heavy hub → more belly). */
function bellyFor(m: BuyModel, routes: UnderservedRoute[]): number {
  const paxVal = routes.reduce(
    (s, r) =>
      s + PAX.reduce((x, c) => x + r.line.weeklyDemand[c] * r.line.price[c], 0),
    0
  );
  const cgoVal = routes.reduce(
    (s, r) => s + r.line.weeklyDemand.cargo * r.line.price.cargo,
    0
  );
  return Math.round(
    m.payloadMax * Math.min(1, (cgoVal / (paxVal + cgoVal || 1)) * 1.5)
  );
}

/**
 * Simulate buying aircraft: build a generous pool of each catalog model (config
 * tuned to the hub demand), run the optimizer on the hub's LEFTOVER demand, and
 * report what it actually used. Mutates `hubLines` scheduling state (fine: it runs
 * after the report's served metrics are already captured).
 */
function simulateBuys(
  hubId: number,
  hubLines: Line[],
  underserved: UnderservedRoute[]
): {
  buyOrders: BuyOrder[];
  bellyCreditTons: number;
  residual: Record<CabinClass, number>;
  residualByLine: Map<number, Record<CabinClass, number>>;
} {
  const nameOf = new Map(hubLines.map((l) => [l.id, l.name]));
  // Each applicable model: its demand-tuned config + a per-route aircraft-equivalents
  // estimate (the basis for the pool cap).
  const models: { m: BuyModel; config: CabinConfig; equiv: number }[] = [];
  for (const m of BUY_CATALOG) {
    const serves = underserved.filter(
      (u) =>
        modelFits(m, u.line) &&
        !(u.fill.reuseIdle && u.fill.reuseIdle.available > 0) &&
        (m.cargo
          ? u.uncovered.cargo > 0
          : u.uncovered.eco + u.uncovered.bus + u.uncovered.first > 0)
    );
    if (serves.length === 0) {
      continue;
    }
    const config = m.cargo
      ? { bus: 0, cargo: Math.round(m.payloadMax), eco: 0, first: 0 }
      : configFor(
          m,
          sumClass(serves.map((r) => r.line.weeklyDemand)),
          bellyFor(m, serves)
        );
    let equiv = 0;
    for (const r of serves) {
      const tw = Math.max(
        1,
        Math.floor(WEEK_SECONDS / modelRtDuration(m, r.line.distance))
      );
      const per = Math.max(
        1,
        tw * (m.cargo ? config.cargo : config.eco) * LEGS_PER_ROUNDTRIP
      );
      equiv += (m.cargo ? r.uncovered.cargo : r.uncovered.eco) / per;
    }
    models.push({ config, equiv, m });
  }
  if (models.length === 0) {
    const residual = zero();
    const residualByLine = new Map<number, Record<CabinClass, number>>();
    for (const l of hubLines) {
      const r = zero();
      for (const day of l.remaining) {
        for (const c of CLASSES) {
          r[c] += day[c];
        }
      }
      residualByLine.set(l.id, r);
      for (const c of CLASSES) {
        residual[c] += r[c];
      }
    }
    return { bellyCreditTons: 0, buyOrders: [], residual, residualByLine };
  }

  // Snapshot the LEFTOVER per-day demand so we can re-run with bigger pools if a cap binds.
  const snap = hubLines.map((l) => l.remaining.map((d) => ({ ...d })));

  let groups = new Map<
    string,
    {
      m: BuyModel;
      config: CabinConfig;
      count: number;
      profit: number;
      load: Record<CabinClass, number>;
      usedSecs: number;
      routes: Set<string>;
    }
  >();
  let bellyCreditTons = 0;
  for (let attempt = 0, capMul = 1.6; attempt < 4; attempt++, capMul *= 2.5) {
    for (const [i, line] of hubLines.entries()) {
      line.remaining = snap[i].map((d) => ({ ...d }));
    }
    const pool: Aircraft[] = [];
    const capOf = new Map<string, number>();
    let idx = 0;
    for (const { m, config, equiv } of models) {
      const cap = Math.min(6000, Math.max(3, Math.ceil(equiv * capMul) + 3));
      capOf.set(m.model, cap);
      for (let i = 0; i < cap; i++) {
        pool.push(makeSynthetic(m, config, hubId, idx++));
      }
    }
    greedyAllocate(pool, hubLines); // places synthetics on the LEFTOVER demand (marginal)

    groups = new Map();
    bellyCreditTons = 0;
    for (const a of pool) {
      if (a.assigned.length === 0) {
        continue;
      }
      const cfg = models.find((x) => x.m.model === a.aircraftListName)!;
      const g = groups.get(a.aircraftListName) ?? {
        config: cfg.config,
        count: 0,
        load: zero(),
        m: cfg.m,
        profit: 0,
        routes: new Set<string>(),
        usedSecs: 0,
      };
      g.count++;
      for (const t of a.assigned) {
        g.profit += t.value;
        for (const c of CLASSES) {
          g.load[c] += t.within[c];
        }
        g.usedSecs += t.duration;
        g.routes.add(nameOf.get(t.lineId) ?? String(t.lineId));
      }
      groups.set(a.aircraftListName, g);
      if (!cfg.m.cargo) {
        bellyCreditTons += a.assigned.reduce((s, t) => s + t.within.cargo, 0);
      }
    }
    // If a model used its WHOLE pool, the cap bound the answer — grow it and re-run.
    let binding = false;
    for (const [model, g] of groups) {
      if (g.count >= (capOf.get(model) ?? 0)) {
        binding = true;
      }
    }
    if (!binding) {
      break;
    }
  }

  // Residual demand STILL unserved after the new fleet (what the simulator left behind).
  const residual = zero();
  const residualByLine = new Map<number, Record<CabinClass, number>>();
  for (const l of hubLines) {
    const r = zero();
    for (const day of l.remaining) {
      for (const c of CLASSES) {
        r[c] += day[c];
      }
    }
    residualByLine.set(l.id, r);
    for (const c of CLASSES) {
      residual[c] += r[c];
    }
  }

  const buyOrders: BuyOrder[] = [...groups.values()].map((g) => ({
    cargoLed: !!g.m.cargo,
    config: g.config,
    count: g.count,
    loadPerAircraft: {
      bus: g.load.bus / g.count,
      cargo: g.load.cargo / g.count,
      eco: g.load.eco / g.count,
      first: g.load.first / g.count,
    },
    model: g.m,
    profit: g.profit,
    routes: [...g.routes],
    totalPrice: g.count * g.m.price,
    uncoveredEco: g.load.eco,
    util: g.count ? Math.min(1, g.usedSecs / (g.count * WEEK_SECONDS)) : 0,
  }));
  buyOrders.sort((a, b) => b.profit - a.profit);
  return { bellyCreditTons, buyOrders, residual, residualByLine };
}

/** Build the actionable advice for one hub. */
export function buildHubAdvice(args: {
  code: string;
  hubId: number;
  hubAircraft: Aircraft[];
  hubLines: Line[];
  plansById: Map<number, ProposedFlight[]>;
  servedByLine: Map<number, Record<CabinClass, number>>;
  linesByHub: Map<number, Line[]>;
  codeByHub: Map<number, string>;
  buyable?: BuyableRoute[];
}): HubAdvice {
  const {
    code,
    hubId,
    hubAircraft,
    hubLines,
    plansById,
    servedByLine,
    linesByHub,
    codeByHub,
    buyable,
  } = args;
  const idleAircraft = hubAircraft.filter(
    (a) => (plansById.get(a.id)?.length ?? 0) === 0
  );

  // ── Underserved routes ──────────────────────────────────────────────────────
  const underserved: UnderservedRoute[] = [];
  const smallRouteGap: HubAdvice["smallRouteGap"] = [];
  const bellyCargo: HubAdvice["bellyCargo"] = [];
  let uncoveredCargoTons = 0;
  let uncoveredEcoSeats = 0;
  const minCatalogCat = Math.min(...BUY_CATALOG.map((m) => m.cat));
  for (const line of hubLines) {
    const served = servedByLine.get(line.id) ?? zero();
    const uncovered = zero();
    for (const c of CLASSES) {
      uncovered[c] = Math.max(0, line.weeklyDemand[c] - served[c]);
    }
    const paxGap = uncovered.eco + uncovered.bus + uncovered.first;
    if (paxGap <= 0 && uncovered.cargo <= 0) {
      continue;
    }
    uncoveredCargoTons += uncovered.cargo;
    uncoveredEcoSeats += uncovered.eco;
    const uncoveredValue = CLASSES.reduce(
      (s, c) => s + uncovered[c] * line.price[c],
      0
    );
    const coverageEco =
      line.weeklyDemand.eco > 0 ? served.eco / line.weeklyDemand.eco : 1;
    const cargoLed =
      uncovered.cargo * line.price.cargo > paxGap * line.price.eco;

    const paxModel = pickModel(line, false); // pax jet that fits category AND range
    const freighter = pickModel(line, true); // freighter that fits category AND range
    const fill: FillPlan = { cargoLed };
    if (cargoLed) {
      if (freighter) {
        fill.buyModel = freighter;
      } else if (paxModel) {
        fill.note = "belly-cargo"; // no freighter has the range → carry in the pax belly
        bellyCargo.push({ line, tons: uncovered.cargo });
      } else {
        fill.note = line.category < minCatalogCat ? "low-cat" : "no-reach";
      }
    } else {
      // Prefer reusing an idle pax aircraft you already own that can fly it.
      const idleFit =
        paxGap > 0 ? idleAircraft.filter((a) => canFly(a, line)) : [];
      if (idleFit.length > 0) {
        const byModel = new Map<string, number[]>();
        for (const a of idleFit) {
          (
            byModel.get(a.aircraftListName) ??
            byModel.set(a.aircraftListName, []).get(a.aircraftListName)!
          ).push(a.id);
        }
        const [model, ids] = [...byModel].sort(
          (a, b) => b[1].length - a[1].length
        )[0];
        fill.reuseIdle = { available: ids.length, ids, model };
      }
      if (paxModel) {
        fill.buyModel = paxModel;
      } else if (!fill.reuseIdle) {
        fill.note = line.category < minCatalogCat ? "low-cat" : "no-reach";
        if (fill.note === "low-cat") {
          smallRouteGap.push({ line, uncovered: { ...uncovered } });
        }
      }
    }
    underserved.push({
      coverageEco,
      fill,
      line,
      served,
      uncovered,
      uncoveredValue,
    });
  }
  underserved.sort((a, b) => b.uncoveredValue - a.uncoveredValue);

  // ── Shopping list — by SIMULATION (build the aircraft, let the optimizer fly them) ──
  const { buyOrders, bellyCreditTons, residual, residualByLine } = simulateBuys(
    hubId,
    hubLines,
    underserved
  );
  for (const u of underserved) {
    u.residual = residualByLine.get(u.line.id);
  }

  // Hub-total demand vs served-now (all routes) — for the coverage before → after.
  const demand = zero();
  const servedNow = zero();
  for (const line of hubLines) {
    const s = servedByLine.get(line.id) ?? zero();
    for (const c of CLASSES) {
      demand[c] += line.weeklyDemand[c];
      servedNow[c] += s[c];
    }
  }

  // ── Surplus (idle) aircraft → what to do ────────────────────────────────────
  const surplus: SurplusGroup[] = [];
  const byModel = new Map<string, Aircraft[]>();
  for (const a of idleAircraft) {
    (
      byModel.get(a.aircraftListName) ??
      byModel.set(a.aircraftListName, []).get(a.aircraftListName)!
    ).push(a);
  }
  for (const [model, list] of byModel) {
    const a = list[0];
    const seats: CabinConfig = {
      bus: a.seatsBus,
      cargo: a.payloadUsed,
      eco: a.seatsEco,
      first: a.seatsFirst,
    };
    let hubCargoGap = 0;
    for (const l of hubLines) {
      if (l.category >= a.category && a.range >= l.distance) {
        hubCargoGap += Math.max(
          0,
          l.weeklyDemand.cargo - (servedByLine.get(l.id)?.cargo ?? 0)
        );
      }
    }
    const buyableFit = (buyable ?? [])
      .filter((r) => r.cat >= a.category && a.range >= r.dist)
      .sort((x, y) => y.cat - x.cat || x.price - y.price);
    const bestBuy = buyableFit[0];
    let moveTo: { code: string; eco: number } | undefined;
    for (const [otherHub, otherLines] of linesByHub) {
      if (otherHub === hubId) {
        continue;
      }
      let eco = 0;
      for (const l of otherLines) {
        if (l.category >= a.category && a.range >= l.distance) {
          eco += Math.max(
            0,
            l.weeklyDemand.eco - (servedByLine.get(l.id)?.eco ?? 0)
          );
        }
      }
      if (!moveTo || eco > moveTo.eco) {
        moveTo = { code: codeByHub.get(otherHub) ?? String(otherHub), eco };
      }
    }
    let action: SurplusAction;
    let alt: string | undefined;
    if (bestBuy) {
      action = {
        kind: "buy-route",
        maxCat: a.category,
        minRange: a.range,
        route: bestBuy,
        text: `Buy route ${code}/${bestBuy.iata} (cat ${bestBuy.cat}, ${fmt(bestBuy.dist)}km, $${fmt(bestBuy.price)}${bestBuy.audited ? "" : ` +audit $${fmt(bestBuy.auditPrice)}`}) — the ${list.length} idle ${model} can then fly it.`,
      };
      if (hubCargoGap > 50) {
        alt = `or reconfigure to cargo (~${fmt(hubCargoGap)} t/week uncovered here)`;
      } else if (moveTo && moveTo.eco > 2000) {
        alt = `or move to ${moveTo.code} (${fmt(moveTo.eco)} eco/week uncovered there)`;
      }
    } else if (hubCargoGap > 50) {
      action = {
        config: { bus: 0, cargo: Math.max(a.payloadUsed, 0), eco: 0, first: 0 },
        kind: "reconfigure-cargo",
        text: `Reconfigure to cargo: ~${fmt(hubCargoGap)} t/week of cargo demand here is unserved. Maximize payload (minimize seats).`,
        tons: hubCargoGap,
      };
      if (moveTo && moveTo.eco > 2000) {
        alt = `or move to ${moveTo.code} (${fmt(moveTo.eco)} eco/week uncovered there)`;
      }
    } else if (moveTo && moveTo.eco > 2000) {
      action = {
        kind: "move-hub",
        text: `Move to ${moveTo.code}: ${fmt(moveTo.eco)} eco/week of demand there fits this aircraft (cat ${a.category}, range ${fmt(a.range)}km).`,
        toCode: moveTo.code,
        uncoveredEco: moveTo.eco,
      };
    } else {
      action = {
        kind: "surplus",
        text: `Genuinely surplus — no route here or nearby uses it. Buy a high-category route (cat ≥ ${a.category}) with demand, or sell.`,
      };
    }
    // WHY is it idle? (the user wants the reason, not just the fix)
    const flyable = hubLines.filter(
      (l) => l.category >= a.category && a.range >= l.distance
    );
    const ecoLeft = flyable.filter(
      (l) => l.weeklyDemand.eco - (servedByLine.get(l.id)?.eco ?? 0) > 0
    );
    const cargoLeft = flyable.filter(
      (l) => l.weeklyDemand.cargo - (servedByLine.get(l.id)?.cargo ?? 0) > 0
    );
    let reason: string;
    if (flyable.length === 0) {
      reason = `Too big: category ${a.category} fits NONE of this hub's ${hubLines.length} routes (its airports are too small for it).`;
    } else if (flyable.length / hubLines.length < 0.5) {
      reason = `Too big: category ${a.category} only reaches ${flyable.length} of ${hubLines.length} routes (the biggest airports), and their demand is already covered by the rest of the fleet.`;
    } else if (ecoLeft.length === 0 && cargoLeft.length > 0) {
      reason = `Its routes' passenger demand is already fully served — only CARGO is left, which a passenger cabin can't take. Reconfigure it for cargo.`;
    } else if (ecoLeft.length === 0) {
      reason =
        "Its routes are already fully served — no remaining demand it can fly.";
    } else {
      reason = `Surplus of the pyramid: the flying is concentrated on fewer aircraft; what's left for this one is below break-even (would fly half-empty and lose money + wear).`;
    }
    surplus.push({
      action,
      alt,
      cat: a.category,
      count: list.length,
      ids: list.map((x) => x.id),
      model,
      range: a.range,
      reason,
      seats,
    });
  }

  return {
    bellyCargo,
    bellyCreditTons,
    buyOrders,
    code,
    demand,
    flying: hubAircraft.length - idleAircraft.length,
    hubId,
    idle: idleAircraft.length,
    residual,
    routeCount: hubLines.length,
    servedNow,
    smallRouteGap,
    surplus,
    total: hubAircraft.length,
    uncoveredCargoTons,
    uncoveredEcoSeats,
    underserved,
  };
}
