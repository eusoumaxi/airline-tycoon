// ───────────────────────────────────────────────────────────────────────────
// SELL-ROUTES report (script #3) — REPORT ONLY.
// After running the per-hub eco optimizer, list every route the plan leaves BELOW the
// sell threshold (SELL_THRESHOLD eco). These aren't worth flying with the current fleet.
// Each is tagged:
//   · SELL          — no aircraft (owned OR buyable) can even fly it (category/range) → drop it.
//   · NEEDS-AIRCRAFT — only under-resourced; a move (script #2) or a buy could cover it.
// Run AFTER moving surplus (script #2) to see what's still genuinely sellable.
//
//   bun run src/sellRoutes.ts            # live fresh fetch
//   bun run src/sellRoutes.ts --offline  # dev: reuse cached load_*.json
// ───────────────────────────────────────────────────────────────────────────

import { discoverHubs, fetchAllPlannings, sellLine } from "./api.ts";
import { BUY_CATALOG, DAYS_PER_WEEK, SELL_THRESHOLD } from "./config.ts";
import { buildModel } from "./model.ts";
import { optimize } from "./optimizer.ts";
import type { Aircraft, Line, PlanningPayload } from "./types.ts";

const DATA_DIR = ".test/data";
const hasFlag = (f: string) => process.argv.includes(f);
const argVal = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

async function loadPayloads(): Promise<PlanningPayload[]> {
  if (hasFlag("--offline")) {
    const glob = new Bun.Glob("load_*.json");
    const payloads: PlanningPayload[] = [];
    for await (const name of glob.scan(DATA_DIR)) payloads.push(await Bun.file(`${DATA_DIR}/${name}`).json());
    if (payloads.length === 0) throw new Error(`No load_*.json in ${DATA_DIR}. Run once without --offline.`);
    console.log(`· OFFLINE: ${payloads.length} cached hubs (not fresh).`);
    return payloads;
  }
  console.log("· Discovering hubs + downloading FRESH planning …");
  const hubs = await discoverHubs();
  const payloads = await fetchAllPlannings(hubs.map((h) => h.loadId));
  for (let i = 0; i < hubs.length; i++) await Bun.write(`${DATA_DIR}/load_${hubs[i].loadId}.json`, JSON.stringify(payloads[i], null, 2));
  return payloads;
}

/** Can ANY aircraft type (owned or buyable) physically fly this route? (cat + range) */
function coverable(line: Line, ownedTypes: { category: number; range: number }[]): boolean {
  if (ownedTypes.some((t) => t.range >= line.distance && t.category <= line.category)) return true;
  return BUY_CATALOG.some((m) => m.range >= line.distance && m.cat <= line.category);
}

async function main() {
  const payloads = await loadPayloads();
  const { lines, aircraft } = buildModel(payloads);
  console.log(`· Model: ${aircraft.length} aircraft, ${lines.size} routes. Optimizing (eco + util floor + sell-drop) …`);
  optimize(aircraft, lines); // mutates line.remaining to the post-plan leftover

  // Distinct owned aircraft "types" (category/range) — to judge if a route is coverable at all.
  const ownedTypes = [...new Map(aircraft.map((a) => [`${a.category}/${a.range}`, { category: a.category, range: a.range }])).values()];

  const codeByHub = new Map<number, string>();
  for (const l of lines.values()) if (!codeByHub.has(l.hubId)) codeByHub.set(l.hubId, l.name.split(" / ")[0]);

  type Row = { hub: string; line: Line; cov: number; verdict: "SELL" | "NEEDS-AIRCRAFT" };
  const rows: Row[] = [];
  for (const l of lines.values()) {
    if (l.weeklyDemand.eco <= 0) continue;
    let leftover = 0;
    for (let d = 0; d < DAYS_PER_WEEK; d++) leftover += l.remaining[d].eco;
    const served = l.weeklyDemand.eco - leftover;
    const cov = served / l.weeklyDemand.eco;
    if (cov >= SELL_THRESHOLD) continue;
    rows.push({ hub: codeByHub.get(l.hubId) ?? "?", line: l, cov, verdict: coverable(l, ownedTypes) ? "NEEDS-AIRCRAFT" : "SELL" });
  }
  rows.sort((a, b) => a.hub.localeCompare(b.hub) || a.cov - b.cov);

  const sellReal = rows.filter((r) => r.verdict === "SELL");
  const needs = rows.filter((r) => r.verdict === "NEEDS-AIRCRAFT");
  console.log(`\n══ ROUTES BELOW ${pct(SELL_THRESHOLD)} ECO (sell candidates) ══`);
  console.log(`Total ${rows.length} · SELL (unservable, drop it) ${sellReal.length} · NEEDS-AIRCRAFT (move/buy) ${needs.length}\n`);

  // Per-hub breakdown
  const byHub = new Map<string, Row[]>();
  for (const r of rows) (byHub.get(r.hub) ?? byHub.set(r.hub, []).get(r.hub)!).push(r);
  console.log(`${"hub".padEnd(5)} ${"toSell".padStart(7)} ${"SELL".padStart(5)} ${"needAc".padStart(7)}`);
  for (const [hub, rs] of [...byHub].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${hub.padEnd(5)} ${String(rs.length).padStart(7)} ${String(rs.filter((r) => r.verdict === "SELL").length).padStart(5)} ${String(rs.filter((r) => r.verdict === "NEEDS-AIRCRAFT").length).padStart(7)}`);
  }

  console.log(`\n── SELL (no aircraft can fly these — actually drop them) ──`);
  if (sellReal.length === 0) console.log("  (none — every uncovered route is at least flyable by some aircraft)");
  for (const r of sellReal) console.log(`  ${r.hub} · ${r.line.name.padEnd(11)} cat ${r.line.category} · ${fmt(r.line.distance)}km · eco ${pct(r.cov)} · demand ${fmt(r.line.weeklyDemand.eco)}/wk · id ${r.line.id}`);

  // Machine-readable output for any follow-up.
  await Bun.write(`${DATA_DIR}/sell_routes.json`, JSON.stringify(
    rows.map((r) => ({ hub: r.hub, route: r.line.name, lineId: r.line.id, category: r.line.category, distance: r.line.distance, ecoCoverage: r.cov, ecoDemand: r.line.weeklyDemand.eco, verdict: r.verdict })),
    null, 2,
  ));
  console.log(`\n· Full list (${rows.length}) → ${DATA_DIR}/sell_routes.json`);

  // ── SELL the unservable routes (only verdict==SELL) — IRREVERSIBLE, sequential ──────
  const live = hasFlag("--apply");
  const limit = argVal("--limit") !== undefined ? Number(argVal("--limit")) : Infinity;
  if (!live) {
    console.log(`· REPORT ONLY. To SELL the ${sellReal.length} unservable route(s): --apply (test first with --limit 1 --apply). NEEDS-AIRCRAFT routes are never sold.\n`);
    return;
  }
  if (hasFlag("--offline")) throw new Error("--apply needs live data + live token (run without --offline).");
  const targets = sellReal.slice(0, Number.isFinite(limit) ? limit : sellReal.length);
  console.log(`\n⚠ SELLING ${targets.length} route(s) LIVE (irreversible)…`);
  let ok = 0, fail = 0;
  for (const r of targets) {
    try {
      const res = await sellLine(r.line.id);
      ok++;
      console.log(`  ✓ SOLD ${r.hub} · ${r.line.name} (id ${r.line.id}) — ${res.slice(0, 80)}`);
    } catch (e) {
      fail++;
      console.log(`  ✗ FAIL ${r.hub} · ${r.line.name} (id ${r.line.id}) — ${e instanceof Error ? e.message : e}`);
    }
    await Bun.sleep(500);
  }
  console.log(`\nDone selling: ${ok} ✓ · ${fail} ✗ (of ${targets.length}). ${Number.isFinite(limit) && sellReal.length > limit ? `Re-run without --limit to sell the remaining ${sellReal.length - targets.length}.` : ""}\n`);
}

main().catch((err: unknown) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
