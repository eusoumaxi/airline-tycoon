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
import { APPLY_HUBS, AUTO_DISCOVER_HUBS, PLANNING_IDS } from "./config.ts";
import { buildModel } from "./model.ts";
import { optimize } from "./optimizer.ts";
import type { AircraftPlan, Line } from "./types.ts";

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => process.argv.includes(flag);

/** How many planning updates to fire CONCURRENTLY per batch (no delay between requests).
 *  Planning pushes carry no per-session token, so they're safe to parallelise. Override
 *  with `--concurrency N`. (High concurrency can make the server return 500s — those are
 *  retried, see below — but lowering this, e.g. --concurrency 25, avoids them.) */
const CONCURRENCY = Math.max(1, argValue("--concurrency") !== undefined ? Number(argValue("--concurrency")) : 100);

/** Optional delay (SECONDS) staggered BETWEEN request launches inside a batch. The j-th
 *  request in a batch waits j·delay before firing, so a batch fires at a steady ~1/delay req/s
 *  instead of all at once — this is what avoids the server timeouts that pure high-concurrency
 *  causes. 0 (default) = fire the whole batch simultaneously. e.g. `--delay 0.5` = 2 req/s. */
const DELAY_MS = Math.max(0, (argValue("--delay") !== undefined ? Number(argValue("--delay")) : 0) * 1000);

/** On a TRANSIENT failure (HTTP 5xx / 429 / network) wait this long, then retry — until the
 *  API responds OK. The 500s come from hammering the server; retrying the failed ones (a
 *  much smaller load) clears them. Default 30 s; override with `--retry-wait <seconds>`. */
const RETRY_WAIT_MS = (argValue("--retry-wait") !== undefined ? Number(argValue("--retry-wait")) : 30) * 1000;
/** Max retries per aircraft on transient errors. Default = unlimited (keep trying until it
 *  responds, per the rule). Override with `--retries N`. Game REJECTIONS are never retried. */
const MAX_RETRIES = argValue("--retries") !== undefined ? Number(argValue("--retries")) : Infinity;

/** A transient (server/network) error worth retrying — NOT a game rejection (which is a
 *  permanent HTTP-200 error like a granularity/category violation). */
const isTransient = (msg: string) => /->\s*(5\d\d|429|408)\b|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|timeout|timed out|terminated|aborted/i.test(msg);

/** Push one aircraft's planning, retrying transient failures every RETRY_WAIT_MS until the
 *  API responds (or MAX_RETRIES). A permanent rejection fails immediately (retrying won't fix it). */
async function sendWithRetry(plan: AircraftPlan, label: string): Promise<{ ok: boolean; line: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      await updatePlanning(plan);
      return { ok: true, line: "✓ SENT " + label + (attempt > 1 ? ` (retry ${attempt - 1})` : "") };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransient(msg)) return { ok: false, line: "✗ FAIL " + label + " — " + msg + " (permanent — not retried)" };
      if (attempt > MAX_RETRIES) return { ok: false, line: "✗ GAVE UP " + label + " — " + msg + ` (after ${attempt - 1} retries)` };
      console.log(`  ⏳ [retry] ${label.slice(0, 48)} — ${msg.slice(0, 50)} → wait ${RETRY_WAIT_MS / 1000}s…`);
      await Bun.sleep(RETRY_WAIT_MS);
    }
  }
}

/** True if the proposed plan is identical to the aircraft's current planning (a no-op
 *  push). Used to SKIP unchanged aircraft — notably freighters, which the optimizer now
 *  leaves exactly as they are (eco is the only objective). */
function sameAsCurrent(current: { lineId: number; takeOffTime: number }[], added: AircraftPlan["added"]): boolean {
  if (current.length !== added.length) return false;
  const key = (f: { lineId: number; takeOffTime: number }) => `${f.lineId}@${f.takeOffTime}`;
  const a = current.map(key).sort();
  const b = added.map(key).sort();
  return a.every((x, i) => x === b[i]);
}

/** Short "ROUTE×N, ..." description of an aircraft plan. */
function summarize(plan: AircraftPlan, lines: Map<number, Line>): string {
  const byLine = new Map<number, number>();
  for (const f of plan.added) byLine.set(f.lineId, (byLine.get(f.lineId) ?? 0) + 1);
  return [...byLine].map(([id, n]) => `${lines.get(id)?.name ?? id}×${n}`).join(", ") || "(empty)";
}

/** One pass: fetch fresh, optimize, push the target-hub aircraft.
 *  `deployIdleOnly` (loop mode): ONLY push aircraft that are IDLE live (empty planning) and
 *  should fly — never re-push a flying aircraft. Re-optimizing gives a slightly different plan
 *  each pass, and re-pushing working/in-flight aircraft disrupts them (coverage DROPS — learned
 *  the hard way). Deploying only idle planes is monotonic: coverage can only go UP. */
async function runPass(live: boolean, targets: string[], deployIdleOnly: boolean): Promise<{ pending: number; ok: number; fail: number }> {
  console.log("· Fetching + optimizing ...");
  const ids = AUTO_DISCOVER_HUBS ? (await discoverHubs()).map((h) => h.loadId) : PLANNING_IDS;
  const payloads = await fetchAllPlannings(ids);
  const { lines, aircraft } = buildModel(payloads);
  const { plans } = optimize(aircraft, lines);

  const codeOf = new Map<number, string>();
  for (const l of lines.values()) if (!codeOf.has(l.hubId)) codeOf.set(l.hubId, l.name.split(" / ")[0]);
  const hubOf = new Map<number, number>(aircraft.map((a) => [a.id, a.hubId]));
  const acById = new Map(aircraft.map((a) => [a.id, a]));

  // Target-hub aircraft to push: those whose live planning differs from the optimized plan
  // (new plan, or should-now-be-idle). Aircraft already matching are skipped — so on a re-run
  // only the ones that DIDN'T stick last time (they were in flight) come back.
  const selected = plans.filter((p) => {
    const hub = hubOf.get(p.aircraftId);
    if (hub === undefined || !targets.includes(codeOf.get(hub) ?? "")) return false;
    const cur = acById.get(p.aircraftId)?.planningList ?? [];
    if (deployIdleOnly) {
      // DEPLOY-ONLY: only touch aircraft that are idle live AND should fly. Leave every
      // flying aircraft alone (no re-push, no clear) so we never disrupt working ones.
      return cur.length === 0 && p.added.length > 0;
    }
    const current = cur.map((s) => ({ lineId: s.lineId, takeOffTime: s.takeOffTime }));
    if (p.added.length === 0 && current.length === 0) return false; // already idle, stays idle
    return !sameAsCurrent(current, p.added); // skip no-op pushes (already-correct / freighters kept as-is)
  });

  const describe = (plan: AircraftPlan, i: number) => {
    const hub = codeOf.get(hubOf.get(plan.aircraftId)!) ?? "?";
    const what = plan.added.length > 0 ? `${plan.added.length} flights · ${summarize(plan, lines)}` : "CLEAR → set idle";
    return `[${i + 1}/${selected.length}] ${hub} · aircraft ${plan.aircraftId} · ${what}`;
  };

  console.log(`Target: ${targets.join(", ")} · Mode: ${live ? "APPLY" : "DRY RUN"} · to update: ${selected.length} · conc ${CONCURRENCY}\n`);
  if (!live) {
    selected.slice(0, 25).forEach((plan, i) => console.log("DRY  " + describe(plan, i)));
    if (selected.length > 25) console.log(`… (${selected.length} total) — DRY RUN, nothing sent.`);
    return { pending: selected.length, ok: 0, fail: 0 };
  }

  let ok = 0;
  let fail = 0;
  for (let start = 0; start < selected.length; start += CONCURRENCY) {
    const batch = selected.slice(start, start + CONCURRENCY);
    const results = await Promise.all(batch.map((plan, j) => Bun.sleep(j * DELAY_MS).then(() => sendWithRetry(plan, describe(plan, start + j)))));
    for (const r of results) {
      console.log(r.line);
      if (r.ok) ok++;
      else fail++;
    }
    console.log(`  …${Math.min(start + CONCURRENCY, selected.length)}/${selected.length} done · ${ok} ✓ · ${fail} ✗`);
  }
  console.log(`\nPass done. Live updates sent: ${ok} ✓ · ${fail} ✗ (of ${selected.length}).`);
  return { pending: selected.length, ok, fail };
}

async function main() {
  const live = hasFlag("--apply"); // default = dry run
  const hubArg = argValue("--hub");
  const targets = (hubArg ? [hubArg] : APPLY_HUBS).map((s) => s.toUpperCase());
  // --until-done: re-run passes until everything is deployed. A planning pushed to an aircraft
  // that is IN FLIGHT silently doesn't stick (the long routes keep many planes airborne), so a
  // single pass only catches the grounded ones; re-running catches the rest as they land.
  const untilDone = hasFlag("--until-done") || hasFlag("--loop");
  const maxPasses = argValue("--max-passes") !== undefined ? Number(argValue("--max-passes")) : 20;
  const intervalS = argValue("--interval") !== undefined ? Number(argValue("--interval")) : 90;

  // A single full apply pushes everything that differs; the --until-done loop only DEPLOYS idle
  // aircraft (monotonic, never disrupts flying ones). `--deploy-idle-only` forces the safe mode
  // for a single pass too.
  const idleOnly = hasFlag("--deploy-idle-only");
  if (!untilDone) {
    await runPass(live, targets, idleOnly);
    return;
  }

  // --deploy-idle-only: SAFE loop — only deploys idle aircraft, never touches flying ones
  // (monotonic, but plateaus below the model's full coverage since flying planes aren't refilled).
  if (idleOnly) {
    console.log(`· UNTIL-DONE (deploy-idle-only): ${targets.join(",")}, max ${maxPasses} passes, ${intervalS}s.`);
    for (let pass = 1; pass <= maxPasses; pass++) {
      console.log(`\n══════ PASS ${pass}/${maxPasses} ══════`);
      const r = await runPass(live, targets, true);
      if (r.pending === 0) { console.log(`\n🎉 Fully deployed after ${pass} pass(es).`); return; }
      if (pass < maxPasses) { console.log(`· ${r.pending} pending. Waiting ${intervalS}s …`); await Bun.sleep(intervalS * 1000); }
    }
    console.log(`\n· Reached max passes.`);
    return;
  }

  // FIXED-TARGET convergence (default --until-done): optimize ONCE → a stable target, then each
  // pass re-fetch the live planning and re-push only the aircraft that still DON'T match the
  // target — FILLING flying planes too, not just deploying idle. Re-optimizing each pass moves the
  // target and churns working aircraft (coverage drops); a FIXED target instead lets the live game
  // converge UP to the model's full plan as in-flight planes land. We never push CLEARs here (only
  // added>0), so coverage only climbs — surplus that should idle just keeps flying harmlessly.
  console.log("· Computing the TARGET plan (optimize once) …");
  const ids = AUTO_DISCOVER_HUBS ? (await discoverHubs()).map((h) => h.loadId) : PLANNING_IDS;
  const { lines, aircraft } = buildModel(await fetchAllPlannings(ids));
  const { plans } = optimize(aircraft, lines);
  const codeOf = new Map<number, string>();
  for (const l of lines.values()) if (!codeOf.has(l.hubId)) codeOf.set(l.hubId, l.name.split(" / ")[0]);
  const hubOf = new Map<number, number>(aircraft.map((a) => [a.id, a.hubId]));
  const target = plans.filter((p) => p.added.length > 0 && targets.includes(codeOf.get(hubOf.get(p.aircraftId) ?? -1) ?? ""));
  console.log(`· Target: ${target.length} flying aircraft in ${targets.join(",")}. Converging (max ${maxPasses} passes, ${intervalS}s).`);

  for (let pass = 1; pass <= maxPasses; pass++) {
    console.log(`\n══════ PASS ${pass}/${maxPasses} ══════ (fixed target)`);
    const liveModel = buildModel(await fetchAllPlannings(ids));
    const liveById = new Map(liveModel.aircraft.map((a) => [a.id, a.planningList.map((s) => ({ lineId: s.lineId, takeOffTime: s.takeOffTime }))]));
    const selected = target.filter((p) => !sameAsCurrent(liveById.get(p.aircraftId) ?? [], p.added));
    console.log(`· ${selected.length} aircraft still differ from the target.`);
    if (selected.length === 0) { console.log(`\n🎉 Live matches the target — converged after ${pass} pass(es).`); return; }
    if (!live) { console.log("· DRY RUN — not pushing (add --apply)."); return; }
    let ok = 0;
    let fail = 0;
    for (let start = 0; start < selected.length; start += CONCURRENCY) {
      const batch = selected.slice(start, start + CONCURRENCY);
      const results = await Promise.all(batch.map((p, j) => Bun.sleep(j * DELAY_MS).then(() => sendWithRetry(p, `[${start + j + 1}/${selected.length}] ac ${p.aircraftId} · ${p.added.length} flights`))));
      for (const r of results) { console.log(r.line); if (r.ok) ok++; else fail++; }
    }
    console.log(`· Pass ${pass}: ${ok} ✓ · ${fail} ✗ (of ${selected.length} differing)`);
    if (pass < maxPasses) { console.log(`· Waiting ${intervalS}s before re-checking …`); await Bun.sleep(intervalS * 1000); }
  }
  console.log(`\n· Reached max passes. Re-run --until-done to finish converging.`);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
