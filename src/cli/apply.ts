/**
 * @fileoverview Re-fetch, re-optimize, and push weekly schedules (one POST per aircraft).
 *
 * Dry-run by default. Pass `--apply` to send. Pass `--hub` or set `AM_APPLY_HUBS`.
 *
 * @example
 * bun run apply -- --hub LHR
 * bun run apply -- --hub LHR --apply
 * bun run apply -- --hub LHR --concurrency 25 --apply
 */
import { discoverHubs, fetchAllPlannings, updatePlanning } from "../lib/api.ts";
import { APPLY_HUBS } from "../lib/config.ts";
import { argNumber, argValue, hasFlag } from "../lib/flags.ts";
import { buildModel, hubCodes } from "../lib/model.ts";
import { optimize } from "../lib/optimizer.ts";
import { type AircraftPlan, type Line, plansEqual } from "../lib/types.ts";

/**
 * Concurrent planning POSTs per batch. Override with `--concurrency N`.
 * High values can 500; those retries are handled by `sendWithRetry`.
 */
const CONCURRENCY = Math.max(1, argNumber("--concurrency", 100));
const DELAY_MS = Math.max(0, argNumber("--delay", 0) * 1000);
const RETRY_WAIT_MS = argNumber("--retry-wait", 30) * 1000;
const MAX_RETRIES = argNumber("--retries", Number.POSITIVE_INFINITY);

/** Transient HTTP/network errors. Game rejections on HTTP 200 are permanent. */
const isTransient = (msg: string) =>
  /->\s*(5\d\d|429|408)\b|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|timeout|timed out|terminated|aborted/i.test(
    msg
  );

/**
 * POST one aircraft plan. Retries transients; fails immediately on a game rejection.
 */
async function sendWithRetry(
  plan: AircraftPlan,
  label: string
): Promise<{ ok: boolean; line: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      await updatePlanning(plan);
      return {
        line: `✓ SENT ${label}${attempt > 1 ? ` (retry ${attempt - 1})` : ""}`,
        ok: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransient(msg)) {
        return {
          line: `✗ FAIL ${label} — ${msg} (permanent — not retried)`,
          ok: false,
        };
      }
      if (attempt > MAX_RETRIES) {
        return {
          line:
            "✗ GAVE UP " +
            label +
            " — " +
            msg +
            ` (after ${attempt - 1} retries)`,
          ok: false,
        };
      }
      console.log(
        `  ⏳ [retry] ${label.slice(0, 48)} — ${msg.slice(0, 50)} → wait ${RETRY_WAIT_MS / 1000}s…`
      );
      await Bun.sleep(RETRY_WAIT_MS);
    }
  }
}

/** True when the proposed week already matches live planning (skip the POST). */
function sameAsCurrent(
  current: { lineId: number; takeOffTime: number }[],
  added: AircraftPlan["added"]
): boolean {
  return plansEqual(current, added);
}

/** Short "ROUTE×N, ..." description of an aircraft plan. */
function summarize(plan: AircraftPlan, lines: Map<number, Line>): string {
  const byLine = new Map<number, number>();
  for (const f of plan.added) {
    byLine.set(f.lineId, (byLine.get(f.lineId) ?? 0) + 1);
  }
  return (
    [...byLine]
      .map(([id, n]) => `${lines.get(id)?.name ?? id}×${n}`)
      .join(", ") || "(empty)"
  );
}

/**
 * Fetch, optimize, and optionally push aircraft on `targets`.
 *
 * When `deployIdleOnly` is set, only idle aircraft that should fly are posted.
 * Re-pushing in-flight aircraft often fails to stick and can cut coverage.
 */
async function runPass(
  live: boolean,
  targets: string[],
  deployIdleOnly: boolean
): Promise<{ pending: number; ok: number; fail: number }> {
  console.log("· Fetching + optimizing ...");
  const ids = (await discoverHubs()).map((h) => h.loadId);
  const payloads = await fetchAllPlannings(ids);
  const { lines, aircraft } = buildModel(payloads);
  const { plans } = optimize(aircraft, lines);

  const codeOf = hubCodes(lines.values());
  const hubOf = new Map<number, number>(aircraft.map((a) => [a.id, a.hubId]));
  const acById = new Map(aircraft.map((a) => [a.id, a]));

  // Target-hub aircraft to push: those whose live planning differs from the optimized plan
  // (new plan, or should-now-be-idle). Aircraft already matching are skipped — so on a re-run
  // only the ones that DIDN'T stick last time (they were in flight) come back.
  const selected = plans.filter((p) => {
    const hub = hubOf.get(p.aircraftId);
    if (hub === undefined || !targets.includes(codeOf.get(hub) ?? "")) {
      return false;
    }
    const cur = acById.get(p.aircraftId)?.planningList ?? [];
    if (deployIdleOnly) {
      // DEPLOY-ONLY: only touch aircraft that are idle live AND should fly. Leave every
      // flying aircraft alone (no re-push, no clear) so we never disrupt working ones.
      return cur.length === 0 && p.added.length > 0;
    }
    const current = cur.map((s) => ({
      lineId: s.lineId,
      takeOffTime: s.takeOffTime,
    }));
    if (p.added.length === 0 && current.length === 0) {
      return false; // already idle, stays idle
    }
    return !sameAsCurrent(current, p.added); // skip no-op pushes (already-correct / freighters kept as-is)
  });

  const describe = (plan: AircraftPlan, i: number) => {
    const hub = codeOf.get(hubOf.get(plan.aircraftId)!) ?? "?";
    const what =
      plan.added.length > 0
        ? `${plan.added.length} flights · ${summarize(plan, lines)}`
        : "CLEAR → set idle";
    return `[${i + 1}/${selected.length}] ${hub} · aircraft ${plan.aircraftId} · ${what}`;
  };

  console.log(
    `Target: ${targets.join(", ")} · Mode: ${live ? "APPLY" : "DRY RUN"} · to update: ${selected.length} · conc ${CONCURRENCY}\n`
  );
  if (!live) {
    selected
      .slice(0, 25)
      .forEach((plan, i) => console.log(`DRY  ${describe(plan, i)}`));
    if (selected.length > 25) {
      console.log(`… (${selected.length} total) — DRY RUN, nothing sent.`);
    }
    return { fail: 0, ok: 0, pending: selected.length };
  }

  let ok = 0;
  let fail = 0;
  for (let start = 0; start < selected.length; start += CONCURRENCY) {
    const batch = selected.slice(start, start + CONCURRENCY);
    const results = await Promise.all(
      batch.map((plan, j) =>
        Bun.sleep(j * DELAY_MS).then(() =>
          sendWithRetry(plan, describe(plan, start + j))
        )
      )
    );
    for (const r of results) {
      console.log(r.line);
      if (r.ok) {
        ok++;
      } else {
        fail++;
      }
    }
    console.log(
      `  …${Math.min(start + CONCURRENCY, selected.length)}/${selected.length} done · ${ok} ✓ · ${fail} ✗`
    );
  }
  console.log(
    `\nPass done. Live updates sent: ${ok} ✓ · ${fail} ✗ (of ${selected.length}).`
  );
  return { fail, ok, pending: selected.length };
}

async function main() {
  const live = hasFlag("--apply");
  const hubArg = argValue("--hub");
  const targets = (hubArg ? [hubArg] : APPLY_HUBS).map((s) => s.toUpperCase());
  if (targets.length === 0) {
    throw new Error("Pass --hub <CODE> or set AM_APPLY_HUBS in .env");
  }
  // In-flight pushes often do not stick; `--until-done` repeats until live matches.
  const untilDone = hasFlag("--until-done") || hasFlag("--loop");
  const maxPasses = argNumber("--max-passes", 20);
  const intervalS = argNumber("--interval", 90);
  const idleOnly = hasFlag("--deploy-idle-only");
  if (!untilDone) {
    await runPass(live, targets, idleOnly);
    return;
  }

  if (idleOnly) {
    console.log(
      `· UNTIL-DONE (deploy-idle-only): ${targets.join(",")}, max ${maxPasses} passes, ${intervalS}s.`
    );
    for (let pass = 1; pass <= maxPasses; pass++) {
      console.log(`\n══════ PASS ${pass}/${maxPasses} ══════`);
      const r = await runPass(live, targets, true);
      if (r.pending === 0) {
        console.log(`\n🎉 Fully deployed after ${pass} pass(es).`);
        return;
      }
      if (pass < maxPasses) {
        console.log(`· ${r.pending} pending. Waiting ${intervalS}s …`);
        await Bun.sleep(intervalS * 1000);
      }
    }
    console.log("\n· Reached max passes.");
    return;
  }

  // Default `--until-done`: optimize once, then re-push only aircraft that still differ.
  console.log("· Computing the TARGET plan (optimize once) …");
  const ids = (await discoverHubs()).map((h) => h.loadId);
  const { lines, aircraft } = buildModel(await fetchAllPlannings(ids));
  const { plans } = optimize(aircraft, lines);
  const codeOf = hubCodes(lines.values());
  const hubOf = new Map<number, number>(aircraft.map((a) => [a.id, a.hubId]));
  const target = plans.filter(
    (p) =>
      p.added.length > 0 &&
      targets.includes(codeOf.get(hubOf.get(p.aircraftId) ?? -1) ?? "")
  );
  console.log(
    `· Target: ${target.length} flying aircraft in ${targets.join(",")}. Converging (max ${maxPasses} passes, ${intervalS}s).`
  );

  for (let pass = 1; pass <= maxPasses; pass++) {
    console.log(`\n══════ PASS ${pass}/${maxPasses} ══════ (fixed target)`);
    const liveModel = buildModel(await fetchAllPlannings(ids));
    const liveById = new Map(
      liveModel.aircraft.map((a) => [
        a.id,
        a.planningList.map((s) => ({
          lineId: s.lineId,
          takeOffTime: s.takeOffTime,
        })),
      ])
    );
    const selected = target.filter(
      (p) => !sameAsCurrent(liveById.get(p.aircraftId) ?? [], p.added)
    );
    console.log(`· ${selected.length} aircraft still differ from the target.`);
    if (selected.length === 0) {
      console.log(
        `\n🎉 Live matches the target — converged after ${pass} pass(es).`
      );
      return;
    }
    if (!live) {
      console.log("· DRY RUN — not pushing (add --apply).");
      return;
    }
    let ok = 0;
    let fail = 0;
    for (let start = 0; start < selected.length; start += CONCURRENCY) {
      const batch = selected.slice(start, start + CONCURRENCY);
      const results = await Promise.all(
        batch.map((p, j) =>
          Bun.sleep(j * DELAY_MS).then(() =>
            sendWithRetry(
              p,
              `[${start + j + 1}/${selected.length}] ac ${p.aircraftId} · ${p.added.length} flights`
            )
          )
        )
      );
      for (const r of results) {
        console.log(r.line);
        if (r.ok) {
          ok++;
        } else {
          fail++;
        }
      }
    }
    console.log(
      `· Pass ${pass}: ${ok} ✓ · ${fail} ✗ (of ${selected.length} differing)`
    );
    if (pass < maxPasses) {
      console.log(`· Waiting ${intervalS}s before re-checking …`);
      await Bun.sleep(intervalS * 1000);
    }
  }
  console.log(
    "\n· Reached max passes. Re-run --until-done to finish converging."
  );
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
