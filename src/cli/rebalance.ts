/**
 * @fileoverview Cross-hub rebalance report. Never writes to the game.
 *
 * Writes `data/report_REBALANCE.html` and `data/rebalance_plan.json`.
 * Apply with `bun run rebalance:apply`.
 *
 * @example
 * bun run rebalance
 * bun run rebalance -- --offline
 * bun run rebalance -- --target 95
 */
import { DATA_DIR, ensureDataDir } from "../lib/config.ts";
import { argNumber, argValue } from "../lib/flags.ts";
import { pct } from "../lib/format.ts";
import { loadPlanning } from "../lib/io.ts";
import { buildModel } from "../lib/model.ts";
import { rebalanceNetwork } from "../lib/rebalance.ts";
import { buildRebalanceHtml } from "../lib/rebalance-html.ts";

async function main() {
  const { hubs, payloads } = await loadPlanning();
  const source = hubs ? "live API, all hubs" : "cached load_*.json (dev mode)";
  if (hubs) {
    console.log(
      `· Hubs (${hubs.length}): ${hubs.map((h) => `${h.code}=${h.loadId}`).join("  ")}`
    );
  }
  const { lines, aircraft } = buildModel(payloads);
  console.log(
    `· Model: ${aircraft.length} aircraft, ${lines.size} routes, ${new Set([...lines.values()].map((l) => l.hubId)).size} hubs.`
  );

  // Priority eco cascade: fill the #1 hub (most routes) toward 100% eco, then cascade the
  // leftover fleet to the next hub; cannibalise the fewest-route hubs first. --target <pct>.
  const targetUtil =
    argValue("--target") === undefined
      ? undefined
      : argNumber("--target", 0) / 100;
  console.log(
    "· Rebalancing (priority eco cascade: max the top hub, cascade the rest, drain small hubs first) …"
  );
  const result = rebalanceNetwork(aircraft, lines, { targetUtil });

  // ── Console summary ──────────────────────────────────────────────────────────
  console.log(
    `\n  ${"hub".padEnd(5)} ${"routes".padStart(6)} ${"strategy".padEnd(9)} ${"aircraft".padStart(10)} ${"util".padStart(14)} ${"moves".padStart(8)}`
  );
  console.log(`  ${"─".repeat(62)}`);
  for (const h of result.hubs) {
    console.log(
      `  ${h.code.padEnd(5)} ${String(h.routeCount).padStart(6)} ${h.strategy.padEnd(9)} ` +
        `${`${h.flyingBefore}→${h.assignedAfter.length}`.padStart(10)} ${`${pct(h.utilBefore)}→${pct(h.utilAfter)}`.padStart(14)} ` +
        `${`+${h.incoming.length}/-${h.outgoing.length}`.padStart(8)}`
    );
  }
  console.log(`  ${"─".repeat(62)}`);
  console.log(
    `  Network util ${pct(result.before.fleetUtil)} → ${pct(result.after.fleetUtil)} · flying ${result.before.flying} → ${result.after.flying} · idle ${result.before.idle} → ${result.idle.length}`
  );
  console.log(`  Cross-hub moves proposed: ${result.moves.length}`);

  // ── Write the report ─────────────────────────────────────────────────────────
  const fetchedAt = `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;
  const html = buildRebalanceHtml(result, { fetchedAt, source });
  await ensureDataDir();
  const htmlPath = `${DATA_DIR}/report_REBALANCE.html`;
  await Bun.write(htmlPath, html);

  // ── Save the machine-readable plan (for the separate apply step) ─────────────
  const planOut = {
    fetchedAt,
    finalPlans: [...result.outcomes.values()].map((o) => ({
      added: o.plan,
      aircraftId: o.id,
      destCode: o.destCode,
      destHubId: o.destHubId,
      moved: o.moved,
    })),
    moves: result.moves.map((o) => ({
      aircraftId: o.id,
      fromCode: o.originCode,
      fromHubId: o.originHubId,
      model: o.model,
      name: o.name,
      toCode: o.destCode,
      toHubId: o.destHubId,
    })),
    targetUtil: result.targetUtil,
  };
  await Bun.write(
    `${DATA_DIR}/rebalance_plan.json`,
    JSON.stringify(planOut, null, 2)
  );

  console.log(`\n· Report:  ${htmlPath}`);
  console.log(`· Plan:    ${DATA_DIR}/rebalance_plan.json`);
  console.log(`· Open it: open ${htmlPath}`);
  console.log(
    "· REPORT ONLY — nothing was sent to the game. Review, then we apply only if you approve.\n"
  );
}

main().catch((err) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
