// ───────────────────────────────────────────────────────────────────────────
// Apply the optimized plan to the game (one POST per aircraft).
//
//   bun run apply               # DRY RUN for the hubs in APPLY_HUBS (GRU) — shows
//                               # what would be sent, sends nothing
//   bun run apply --apply       # actually send the updates (live)
//   bun run apply --hub GRU     # pick the hub on the CLI
//   bun run apply --hub GRU --apply
//
// It re-fetches, re-optimizes and pushes — so re-running it is a full "reload",
// handy after you buy new routes or aircraft. A random 5–10 s delay is inserted
// between each aircraft update (configurable in config.ts).
// ───────────────────────────────────────────────────────────────────────────

import { discoverHubs, fetchAllPlannings, updatePlanning } from "./api.ts";
import { APPLY_HUBS, AUTO_DISCOVER_HUBS, MAX_DELAY_MS, MIN_DELAY_MS, PLANNING_IDS } from "./config.ts";
import { buildModel } from "./model.ts";
import { optimize } from "./optimizer.ts";
import type { AircraftPlan, Line } from "./types.ts";

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => process.argv.includes(flag);

/** Random delay in ms within [MIN_DELAY_MS, MAX_DELAY_MS]. */
function randomDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

/** Short "ROUTE×N, ..." description of an aircraft plan. */
function summarize(plan: AircraftPlan, lines: Map<number, Line>): string {
  const byLine = new Map<number, number>();
  for (const f of plan.added) byLine.set(f.lineId, (byLine.get(f.lineId) ?? 0) + 1);
  return [...byLine].map(([id, n]) => `${lines.get(id)?.name ?? id}×${n}`).join(", ") || "(empty)";
}

async function main() {
  const live = hasFlag("--apply"); // default = dry run
  const hubArg = argValue("--hub");
  const targets = (hubArg ? [hubArg] : APPLY_HUBS).map((s) => s.toUpperCase());

  // Load + optimize ALL hubs (keeps the model consistent), then push only targets.
  console.log("· Fetching + optimizing ...");
  const ids = AUTO_DISCOVER_HUBS ? (await discoverHubs()).map((h) => h.loadId) : PLANNING_IDS;
  const payloads = await fetchAllPlannings(ids);
  const { lines, aircraft } = buildModel(payloads);
  const { plans } = optimize(aircraft, lines);

  // hubId -> code (route name prefix), aircraftId -> hubId
  const codeOf = new Map<number, string>();
  for (const l of lines.values()) if (!codeOf.has(l.hubId)) codeOf.set(l.hubId, l.name.split(" / ")[0]);
  const hubOf = new Map<number, number>(aircraft.map((a) => [a.id, a.hubId]));

  // Aircraft of the target hubs that have at least one flight in the plan.
  const selected = plans.filter((p) => {
    const hub = hubOf.get(p.aircraftId);
    return p.added.length > 0 && hub !== undefined && targets.includes(codeOf.get(hub) ?? "");
  });

  console.log(`\nTarget hub(s): ${targets.join(", ")}`);
  console.log(`Mode: ${live ? "APPLY — sending live updates" : "DRY RUN — nothing is sent (add --apply to send)"}`);
  console.log(`Aircraft to update: ${selected.length}\n`);

  let i = 0;
  for (const plan of selected) {
    i++;
    const hub = codeOf.get(hubOf.get(plan.aircraftId)!) ?? "?";
    const line = `[${i}/${selected.length}] ${hub} · aircraft ${plan.aircraftId} · ${plan.added.length} flights · ${summarize(plan, lines)}`;

    if (!live) {
      console.log("DRY  " + line);
      continue;
    }

    try {
      await updatePlanning(plan);
      console.log("✓ SENT " + line);
    } catch (err) {
      console.log("✗ FAIL " + line + " — " + (err instanceof Error ? err.message : err));
    }

    if (i < selected.length) {
      const d = randomDelay();
      console.log(`        …waiting ${(d / 1000).toFixed(1)}s before next aircraft`);
      await Bun.sleep(d);
    }
  }

  console.log(`\nDone. ${live ? "Live updates sent." : "Dry run only — nothing was sent. Re-run with --apply to push."}`);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
