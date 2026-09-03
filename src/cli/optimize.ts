/**
 * @fileoverview Discover hubs, download planning, run the optimizer, write HTML reports.
 *
 * Never writes to the game. Review `data/report_<HUB>.html`, then `bun run apply`.
 *
 * @example
 * bun run optimize
 * bun run optimize -- --hub LHR
 * bun run offline
 * bun run fetch
 */
import { DATA_DIR, ensureDataDir } from "../lib/config.ts";
import { argValue, hasFlag } from "../lib/flags.ts";
import { moneyUsd } from "../lib/format.ts";
import { buildHubHtml, buildSummaryHtml } from "../lib/html.ts";
import { loadPlanning } from "../lib/io.ts";
import { buildModel, hubCodes, linesByHub } from "../lib/model.ts";
import { optimize } from "../lib/optimizer.ts";
import { buildHubAdvice, computeServedByLine } from "../lib/recommend.ts";
import {
  computeMetrics,
  type FleetIndex,
  printComparison,
  printDailyOvershoot,
  printFleetAnalysis,
  printHubSummary,
  printOversupply,
  printPlanSample,
  printRouteAnalysis,
} from "../lib/report.ts";
import type { BuyableRoute, HubAdvice } from "../lib/types.ts";

/** Optional cached buyable routes for a hub (written by `bun run buyroute --hub <CODE>`). */
async function loadBuyable(code: string): Promise<BuyableRoute[] | undefined> {
  const f = Bun.file(`${DATA_DIR}/buyable_${code}.json`);
  return (await f.exists()) ? ((await f.json()) as BuyableRoute[]) : undefined;
}

const money = moneyUsd;

/** Print the per-hub shopping list + surplus actions to the console. */
function printAdvice(a: HubAdvice): void {
  if (
    a.buyOrders.length === 0 &&
    a.surplus.length === 0 &&
    a.smallRouteGap.length === 0
  ) {
    return;
  }
  console.log(
    `\n  ── ${a.code}: decisions ──  ${a.idle} idle · ${Math.round(a.uncoveredEcoSeats).toLocaleString()} eco + ${Math.round(a.uncoveredCargoTons).toLocaleString()} t cargo unserved/week`
  );
  for (const o of a.buyOrders) {
    const cfg = o.cargoLed
      ? `${o.config.cargo}t freighter`
      : `${o.config.eco}/${o.config.bus}/${o.config.first} +${o.config.cargo}t`;
    console.log(
      `    BUY ${String(o.count).padStart(4)}× ${o.model.model.padEnd(13)} cfg ${cfg.padEnd(18)} util ${(`${Math.round(o.util * 100)}%`).padStart(4)} ${money(o.totalPrice).padStart(15)}  → ${o.routes.slice(0, 3).join(", ")}${o.routes.length > 3 ? " …" : ""}`
    );
  }
  if (a.smallRouteGap.length) {
    console.log(
      `    ⚠ ${a.smallRouteGap.length} route(s) need a SMALL aircraft (cat < 5): ${a.smallRouteGap
        .slice(0, 6)
        .map((g) => g.line.name)
        .join(", ")}${a.smallRouteGap.length > 6 ? " …" : ""}`
    );
  }
  if (a.bellyCreditTons > 0) {
    console.log(
      `    ↳ (freighters already credit ${Math.round(a.bellyCreditTons).toLocaleString()} t/wk carried in the new pax fleet's belly)`
    );
  }
  if (a.bellyCargo.length) {
    console.log(
      `    📦 ${Math.round(a.bellyCargo.reduce((s, b) => s + b.tons, 0)).toLocaleString()} t cargo on ${a.bellyCargo.length} long route(s) → carry in A350 belly (no freighter reaches)`
    );
  }
  for (const s of a.surplus) {
    console.log(
      `    IDLE ${s.count}× ${s.model.padEnd(13)} → ${s.action.text}`
    );
  }
}

/** Grand-total buy plan across all hubs (the answer to "how many of each to buy"). */
function printFleetTotals(advices: HubAdvice[]): void {
  const by = new Map<string, { count: number; price: number }>();
  for (const a of advices) {
    for (const o of a.buyOrders) {
      const g = by.get(o.model.model) ?? { count: 0, price: 0 };
      g.count += o.count;
      g.price += o.totalPrice;
      by.set(o.model.model, g);
    }
  }
  let total = 0;
  console.log(
    "\n  ════ FLEET PLAN — buy this to fully fill every owned route ════"
  );
  for (const [model, g] of [...by].sort((x, y) => y[1].price - x[1].price)) {
    total += g.price;
    console.log(
      `    ${String(g.count).padStart(5)}× ${model.padEnd(14)} ${money(g.price).padStart(18)}`
    );
  }
  console.log(
    `    ${"".padStart(5)}  ${"TOTAL".padEnd(14)} ${money(total).padStart(18)}   (full-coverage ceiling — buy incrementally)`
  );
}

async function main() {
  const { hubs, payloads } = await loadPlanning();
  if (hubs) {
    console.log(
      `· Discovered hubs (${hubs.length}): ${hubs.map((h) => `${h.code}=${h.loadId}`).join("  ")}`
    );
  } else {
    console.log("· Offline mode: reading saved JSON from", DATA_DIR);
  }

  if (hasFlag("--fetch-only")) {
    console.log("· Download complete. Exiting (--fetch-only).");
    return;
  }

  // ── Model ───────────────────────────────────────────────────────────────────
  const { lines, aircraft } = buildModel(payloads);
  const fleet: FleetIndex = new Map(aircraft.map((a) => [a.id, a]));
  console.log(
    `· Model: ${aircraft.length} aircraft, ${lines.size} routes, hub(s) ${payloads.map((p) => p.hubAirportId).join(",")}`
  );

  // ── Analysis ──────────────────────────────────────────────────────────────────
  printRouteAnalysis(lines);
  printFleetAnalysis(aircraft);

  // ── CURRENT state (from the real planningList) ──────────────────────────────────
  const beforeFlights = aircraft.map((a) => ({
    aircraftId: a.id,
    flights: a.planningList.map((p) => ({
      lineId: p.lineId,
      takeOffTime: p.takeOffTime,
    })),
  }));
  const before = computeMetrics(beforeFlights, fleet, lines);

  // ── Optimization (NO update is sent) ────────────────────────────────────────────
  console.log("\n· Optimizing slots ...");
  const { plans, totalFlights } = optimize(aircraft, lines);

  // ── PROPOSED state ──────────────────────────────────────────────────────────────
  const afterFlights = plans.map((p) => ({
    aircraftId: p.aircraftId,
    flights: p.added.map((f) => ({
      lineId: f.lineId,
      takeOffTime: f.takeOffTime,
    })),
  }));
  const after = computeMetrics(afterFlights, fleet, lines);

  printComparison(before, after);
  printHubSummary(aircraft, lines);
  printOversupply(after, lines);
  printDailyOvershoot(afterFlights, fleet, lines);
  printPlanSample(plans, fleet, lines);

  // ── Save plan (update-ready format, but NOT sent) ────────────────────────────────
  const outPlan = plans.filter((p) => p.added.length > 0);
  await ensureDataDir();
  await Bun.write(
    `${DATA_DIR}/proposed_plan.json`,
    JSON.stringify(outPlan, null, 2)
  );
  console.log(
    `\n· Proposed plan saved to ${DATA_DIR}/proposed_plan.json (${outPlan.length} aircraft, ${totalFlights} flights).`
  );

  // ── Recommendations (what to buy / reconfigure / move) + HTML report per hub ──
  const plansById = new Map(plans.map((p) => [p.aircraftId, p.added]));
  const servedByLine = computeServedByLine(aircraft, lines, plansById);
  const lbh = linesByHub(lines);
  const hubCodeOf = hubCodes(lines.values());
  const wanted = argValue("--hub")?.toUpperCase();
  let generated = 0;
  const allAdvice: HubAdvice[] = [];
  for (const [hubId, code] of hubCodeOf) {
    if (wanted && code !== wanted) {
      continue;
    }
    const hubAircraft = aircraft.filter((a) => a.hubId === hubId);
    if (hubAircraft.length === 0) {
      continue;
    }
    const hubLines = lbh.get(hubId) ?? [];
    const buyable = await loadBuyable(code); // optional cached buyable routes (bun run buyroute)
    const advice = buildHubAdvice({
      buyable,
      code,
      codeByHub: hubCodeOf,
      hubAircraft,
      hubId,
      hubLines,
      linesByHub: lbh,
      plansById,
      servedByLine,
    });
    allAdvice.push(advice);
    printAdvice(advice);
    const html = buildHubHtml(code, hubAircraft, lines, plansById, advice);
    await Bun.write(`${DATA_DIR}/report_${code}.html`, html);
    console.log(`· HTML report: ${DATA_DIR}/report_${code}.html`);
    generated++;
  }
  if (wanted && generated === 0) {
    console.log(
      `· Hub "${wanted}" not found. Hubs: ${[...hubCodeOf.values()].join(", ")}`
    );
  }

  // ── Consolidated FLEET PLAN (what to buy across all hubs) ──────────────────────
  if (allAdvice.length > 1) {
    await Bun.write(
      `${DATA_DIR}/report_SUMMARY.html`,
      buildSummaryHtml(allAdvice)
    );
    printFleetTotals(allAdvice);
    console.log(
      `· HTML summary: ${DATA_DIR}/report_SUMMARY.html (consolidated buy plan)`
    );
  }

  console.log(
    "· No update was sent. Review the plan; apply it with `bun run apply` when ready.\n"
  );
}

main().catch((err) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
