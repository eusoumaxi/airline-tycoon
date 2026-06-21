// ───────────────────────────────────────────────────────────────────────────
// CLI for the cross-hub rebalancer — REPORT ONLY (nothing is sent to the game).
//
//   bun run src/rebalanceRun.ts            # fetch FRESH data live, build the report
//   bun run src/rebalanceRun.ts --offline  # dev: reuse the cached load_*.json
//
// Output:
//   .test/data/report_REBALANCE.html   — the rich, reviewable report (open this)
//   .test/data/rebalance_plan.json     — machine-readable plan for the apply step
//
// This NEVER mutates the game. Applying the plan (moving aircraft + pushing the new
// planning) is a separate, explicit script you run only after approving the report.
// ───────────────────────────────────────────────────────────────────────────

import { discoverHubs, fetchAllPlannings } from "./api.ts";
import { buildModel } from "./model.ts";
import { rebalanceNetwork } from "./rebalance.ts";
import { buildRebalanceHtml } from "./rebalanceHtml.ts";
import type { PlanningPayload } from "./types.ts";

const DATA_DIR = ".test/data";
const hasFlag = (f: string) => process.argv.includes(f);
const flagVal = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Load planning payloads: cached (--offline, dev only) or FRESH from the live API. */
async function loadPayloads(): Promise<{ payloads: PlanningPayload[]; source: string }> {
  if (hasFlag("--offline")) {
    const glob = new Bun.Glob("load_*.json");
    const payloads: PlanningPayload[] = [];
    for await (const name of glob.scan(DATA_DIR)) payloads.push(await Bun.file(`${DATA_DIR}/${name}`).json());
    if (payloads.length === 0) throw new Error(`No load_*.json in ${DATA_DIR}. Run once without --offline to fetch.`);
    console.log(`· OFFLINE (dev): ${payloads.length} cached hub payloads — NOT fresh data.`);
    return { payloads, source: "cached load_*.json (dev mode)" };
  }
  console.log("· Discovering hubs (live) …");
  const hubs = await discoverHubs();
  console.log(`· Hubs (${hubs.length}): ${hubs.map((h) => `${h.code}=${h.loadId}`).join("  ")}`);
  console.log("· Downloading FRESH planning for every hub …");
  const payloads = await fetchAllPlannings(hubs.map((h) => h.loadId));
  // Refresh the on-disk snapshot too (so a later --offline dev run matches).
  for (let i = 0; i < hubs.length; i++) await Bun.write(`${DATA_DIR}/load_${hubs[i].loadId}.json`, JSON.stringify(payloads[i], null, 2));
  return { payloads, source: "live API, all hubs" };
}

async function main() {
  const { payloads, source } = await loadPayloads();
  const { lines, aircraft } = buildModel(payloads);
  console.log(`· Model: ${aircraft.length} aircraft, ${lines.size} routes, ${new Set([...lines.values()].map((l) => l.hubId)).size} hubs.`);

  // Priority eco cascade: fill the #1 hub (most routes) toward 100% eco, then cascade the
  // leftover fleet to the next hub; cannibalise the fewest-route hubs first. --target <pct>.
  const targetUtil = flagVal("--target") !== undefined ? Number(flagVal("--target")) / 100 : undefined;
  console.log("· Rebalancing (priority eco cascade: max the top hub, cascade the rest, drain small hubs first) …");
  const result = rebalanceNetwork(aircraft, lines, { targetUtil });

  // ── Console summary ──────────────────────────────────────────────────────────
  console.log(`\n  ${"hub".padEnd(5)} ${"routes".padStart(6)} ${"strategy".padEnd(9)} ${"aircraft".padStart(10)} ${"util".padStart(14)} ${"moves".padStart(8)}`);
  console.log(`  ${"─".repeat(62)}`);
  for (const h of result.hubs) {
    console.log(
      `  ${h.code.padEnd(5)} ${String(h.routeCount).padStart(6)} ${h.strategy.padEnd(9)} ` +
        `${`${h.flyingBefore}→${h.assignedAfter.length}`.padStart(10)} ${`${pct(h.utilBefore)}→${pct(h.utilAfter)}`.padStart(14)} ` +
        `${`+${h.incoming.length}/-${h.outgoing.length}`.padStart(8)}`,
    );
  }
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  Network util ${pct(result.before.fleetUtil)} → ${pct(result.after.fleetUtil)} · flying ${result.before.flying} → ${result.after.flying} · idle ${result.before.idle} → ${result.idle.length}`);
  console.log(`  Cross-hub moves proposed: ${result.moves.length}`);

  // ── Write the report ─────────────────────────────────────────────────────────
  const fetchedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const html = buildRebalanceHtml(result, { fetchedAt, source });
  const htmlPath = `${DATA_DIR}/report_REBALANCE.html`;
  await Bun.write(htmlPath, html);

  // ── Save the machine-readable plan (for the separate apply step) ─────────────
  const planOut = {
    fetchedAt,
    targetUtil: result.targetUtil,
    moves: result.moves.map((o) => ({ aircraftId: o.id, name: o.name, model: o.model, fromCode: o.originCode, fromHubId: o.originHubId, toCode: o.destCode, toHubId: o.destHubId })),
    finalPlans: [...result.outcomes.values()].map((o) => ({ aircraftId: o.id, destHubId: o.destHubId, destCode: o.destCode, moved: o.moved, added: o.plan })),
  };
  await Bun.write(`${DATA_DIR}/rebalance_plan.json`, JSON.stringify(planOut, null, 2));

  console.log(`\n· Report:  ${htmlPath}`);
  console.log(`· Plan:    ${DATA_DIR}/rebalance_plan.json`);
  console.log(`· Open it: open ${htmlPath}`);
  console.log("· REPORT ONLY — nothing was sent to the game. Review, then we apply only if you approve.\n");
}

main().catch((err) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
