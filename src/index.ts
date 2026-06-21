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

/** Lee el valor de un flag, p.ej. `--hub BOG` -> "BOG". */
function flagValue(f: string): string | undefined {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Resuelve los IDs de planning: auto-descubre todos los hubs o usa la lista. */
async function resolvePlanningIds(): Promise<number[]> {
  if (AUTO_DISCOVER_HUBS) {
    const hubs = await discoverHubs();
    console.log(`· Hubs descubiertos (${hubs.length}): ${hubs.map((h) => `${h.code}=${h.loadId}`).join("  ")}`);
    return hubs.map((h) => h.loadId);
  }
  return PLANNING_IDS;
}

/** Carga los payloads desde disco (modo --offline) o desde la API. */
async function loadPayloads(): Promise<PlanningPayload[]> {
  if (hasFlag("--offline")) {
    console.log("· Modo offline: leyendo JSON guardado en", DATA_DIR);
    const glob = new Bun.Glob("load_*.json");
    const payloads: PlanningPayload[] = [];
    for await (const name of glob.scan(DATA_DIR)) {
      payloads.push(await Bun.file(`${DATA_DIR}/${name}`).json());
    }
    if (payloads.length === 0) throw new Error(`No hay load_*.json en ${DATA_DIR} (corre sin --offline primero)`);
    return payloads;
  }

  const ids = await resolvePlanningIds();
  console.log("· Descargando planning de", ids.length, "hub(s) ...");
  const payloads = await fetchAllPlannings(ids);
  // Guardar copia cruda para depurar / modo offline.
  for (let i = 0; i < ids.length; i++) {
    await Bun.write(`${DATA_DIR}/load_${ids[i]}.json`, JSON.stringify(payloads[i], null, 2));
  }
  return payloads;
}

async function main() {
  const payloads = await loadPayloads();

  if (hasFlag("--fetch-only")) {
    console.log("· Descarga completa. Saliendo (--fetch-only).");
    return;
  }

  // ── Modelo ────────────────────────────────────────────────────────────────
  const { lines, aircraft } = buildModel(payloads);
  const fleet: FleetIndex = new Map(aircraft.map((a) => [a.id, a]));
  console.log(`· Modelo: ${aircraft.length} aviones, ${lines.size} lineas, hub(s) ${payloads.map((p) => p.hubAirportId).join(",")}`);

  // ── Analisis ──────────────────────────────────────────────────────────────
  printRouteAnalysis(lines);
  printFleetAnalysis(aircraft);

  // ── Estado ACTUAL (desde el planningList real) ──────────────────────────────
  const beforeFlights = aircraft.map((a) => ({
    aircraftId: a.id,
    lineIds: a.planningList.map((p) => p.lineId),
  }));
  const before = computeMetrics(beforeFlights, fleet, lines);

  // ── Optimizacion (NO se envia ningun update) ────────────────────────────────
  console.log(`\n· Optimizando slots ...`);
  const { plans, totalFlights } = optimize(aircraft, lines);

  // ── Estado PROPUESTO ────────────────────────────────────────────────────────
  const afterFlights = plans.map((p) => ({ aircraftId: p.aircraftId, lineIds: p.added.map((f) => f.lineId) }));
  const after = computeMetrics(afterFlights, fleet, lines);

  printComparison(before, after);
  printHubSummary(aircraft, lines);
  printOversupply(after, lines);
  printPlanSample(plans, fleet, lines);

  // ── Guardar plan (formato listo para el update, pero SIN enviarlo) ──────────
  const outPlan = plans.filter((p) => p.added.length > 0);
  await Bun.write(`${DATA_DIR}/proposed_plan.json`, JSON.stringify(outPlan, null, 2));
  console.log(`\n· Plan propuesto guardado en ${DATA_DIR}/proposed_plan.json (${outPlan.length} aviones, ${totalFlights} vuelos).`);

  // ── Reporte HTML por hub (artefacto visual: "como quedaria con el reajuste") ──
  const plansById = new Map(plans.map((p) => [p.aircraftId, p.added]));
  const hubCodeOf = new Map<number, string>(); // hubId -> codigo (prefijo de sus rutas)
  for (const l of lines.values()) if (!hubCodeOf.has(l.hubId)) hubCodeOf.set(l.hubId, l.name.split(" / ")[0]);
  const wanted = flagValue("--hub")?.toUpperCase();
  let generated = 0;
  for (const [hubId, code] of hubCodeOf) {
    if (wanted && code !== wanted) continue;
    const hubAircraft = aircraft.filter((a) => a.hubId === hubId);
    if (hubAircraft.length === 0) continue;
    const html = buildHubHtml(code, hubAircraft, lines, plansById);
    await Bun.write(`${DATA_DIR}/report_${code}.html`, html);
    console.log(`· Reporte HTML: ${DATA_DIR}/report_${code}.html`);
    generated++;
  }
  if (wanted && generated === 0) console.log(`· Hub "${wanted}" no encontrado. Hubs: ${[...hubCodeOf.values()].join(", ")}`);

  console.log("· NO se envio ningun update. Revisa el plan; el update se hara despues.\n");
}

main().catch((err) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
