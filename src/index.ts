import { discoverHubs, fetchAllPlannings } from "./api.ts";
import { AUTO_DISCOVER_HUBS, PLANNING_IDS } from "./config.ts";
import { buildHubHtml } from "./html.ts";
import { buildModel } from "./model.ts";
import { optimize } from "./optimizer.ts";
import {
  computeMetrics,
  printComparison,
  printFleetAnalysis,
  printHubSummary,
  printOversupply,
  printPlanSample,
  printRouteAnalysis,
  type FleetIndex,
} from "./report.ts";
import type { PlanningPayload } from "./types.ts";

const DATA_DIR = ".test/data";

function hasFlag(f: string): boolean {
  return process.argv.includes(f);
}

/** Read a flag value, e.g. `--hub BOG` -> "BOG". */
function flagValue(f: string): string | undefined {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Resolve the planning IDs: auto-discover all hubs or use the configured list. */
async function resolvePlanningIds(): Promise<number[]> {
  if (AUTO_DISCOVER_HUBS) {
    const hubs = await discoverHubs();
    console.log(`· Discovered hubs (${hubs.length}): ${hubs.map((h) => `${h.code}=${h.loadId}`).join("  ")}`);
    return hubs.map((h) => h.loadId);
  }
  return PLANNING_IDS;
}

/** Load payloads from disk (--offline mode) or from the API. */
async function loadPayloads(): Promise<PlanningPayload[]> {
  if (hasFlag("--offline")) {
    console.log("· Offline mode: reading saved JSON from", DATA_DIR);
    const glob = new Bun.Glob("load_*.json");
    const payloads: PlanningPayload[] = [];
    for await (const name of glob.scan(DATA_DIR)) {
      payloads.push(await Bun.file(`${DATA_DIR}/${name}`).json());
    }
    if (payloads.length === 0) throw new Error(`No load_*.json in ${DATA_DIR} (run without --offline first)`);
    return payloads;
  }

  const ids = await resolvePlanningIds();
  console.log("· Downloading planning for", ids.length, "hub(s) ...");
  const payloads = await fetchAllPlannings(ids);
  // Save a raw copy for debugging / offline mode.
  for (let i = 0; i < ids.length; i++) {
    await Bun.write(`${DATA_DIR}/load_${ids[i]}.json`, JSON.stringify(payloads[i], null, 2));
  }
  return payloads;
}

async function main() {
  const payloads = await loadPayloads();

  if (hasFlag("--fetch-only")) {
    console.log("· Download complete. Exiting (--fetch-only).");
    return;
  }

  // ── Model ───────────────────────────────────────────────────────────────────
  const { lines, aircraft } = buildModel(payloads);
  const fleet: FleetIndex = new Map(aircraft.map((a) => [a.id, a]));
  console.log(`· Model: ${aircraft.length} aircraft, ${lines.size} routes, hub(s) ${payloads.map((p) => p.hubAirportId).join(",")}`);

  // ── Analysis ──────────────────────────────────────────────────────────────────
  printRouteAnalysis(lines);
  printFleetAnalysis(aircraft);

  // ── CURRENT state (from the real planningList) ──────────────────────────────────
  const beforeFlights = aircraft.map((a) => ({
    aircraftId: a.id,
    flights: a.planningList.map((p) => ({ lineId: p.lineId, takeOffTime: p.takeOffTime })),
  }));
  const before = computeMetrics(beforeFlights, fleet, lines);

  // ── Optimization (NO update is sent) ────────────────────────────────────────────
  console.log(`\n· Optimizing slots ...`);
  const { plans, totalFlights } = optimize(aircraft, lines);

  // ── PROPOSED state ──────────────────────────────────────────────────────────────
  const afterFlights = plans.map((p) => ({
    aircraftId: p.aircraftId,
    flights: p.added.map((f) => ({ lineId: f.lineId, takeOffTime: f.takeOffTime })),
  }));
  const after = computeMetrics(afterFlights, fleet, lines);

  printComparison(before, after);
  printHubSummary(aircraft, lines);
  printOversupply(after, lines);
  printPlanSample(plans, fleet, lines);

  // ── Save plan (update-ready format, but NOT sent) ────────────────────────────────
  const outPlan = plans.filter((p) => p.added.length > 0);
  await Bun.write(`${DATA_DIR}/proposed_plan.json`, JSON.stringify(outPlan, null, 2));
  console.log(`\n· Proposed plan saved to ${DATA_DIR}/proposed_plan.json (${outPlan.length} aircraft, ${totalFlights} flights).`);

  // ── HTML report per hub (visual artifact: "how it would look after the readjustment") ──
  const plansById = new Map(plans.map((p) => [p.aircraftId, p.added]));
  const hubCodeOf = new Map<number, string>(); // hubId -> code (prefix of its route names)
  for (const l of lines.values()) if (!hubCodeOf.has(l.hubId)) hubCodeOf.set(l.hubId, l.name.split(" / ")[0]);
  const wanted = flagValue("--hub")?.toUpperCase();
  let generated = 0;
  for (const [hubId, code] of hubCodeOf) {
    if (wanted && code !== wanted) continue;
    const hubAircraft = aircraft.filter((a) => a.hubId === hubId);
    if (hubAircraft.length === 0) continue;
    const html = buildHubHtml(code, hubAircraft, lines, plansById);
    await Bun.write(`${DATA_DIR}/report_${code}.html`, html);
    console.log(`· HTML report: ${DATA_DIR}/report_${code}.html`);
    generated++;
  }
  if (wanted && generated === 0) console.log(`· Hub "${wanted}" not found. Hubs: ${[...hubCodeOf.values()].join(", ")}`);

  console.log("· No update was sent. Review the plan; apply it with `bun run apply` when ready.\n");
}

main().catch((err) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
