/**
 * @fileoverview Apply a cross-hub rebalance: move aircraft, then push schedules.
 *
 * Dry-run by default. Progress is stored in `data/apply_done.json`.
 * Aircraft in flight cannot change hub — re-run (or `--until-done`) after they land.
 *
 * @example
 * bun run rebalance:apply -- --hub LHR
 * bun run rebalance:apply -- --hub LHR --limit 5 --apply
 * bun run rebalance:apply -- --hub LHR --until-done --apply
 */
import { discoverHubs, fetchAllPlannings, updatePlanning } from "../lib/api.ts";
import { DATA_DIR, ensureDataDir } from "../lib/config.ts";
import { argNumber, argValue, hasFlag } from "../lib/flags.ts";
import { buildModel } from "../lib/model.ts";
import { moveAircraftHub } from "../lib/move.ts";
import { rebalanceNetwork } from "../lib/rebalance.ts";

const STATE_FILE = `${DATA_DIR}/apply_done.json`;
const conc = Math.max(1, argNumber("--concurrency", 100));
const moveConc = Math.max(1, argNumber("--move-concurrency", 4));

async function loadDone(): Promise<Set<number>> {
  const f = Bun.file(STATE_FILE);
  if (!(await f.exists())) {
    return new Set();
  }
  try {
    const j = (await f.json()) as { done: number[] };
    return new Set(j.done);
  } catch {
    return new Set();
  }
}
async function saveDone(done: Set<number>): Promise<void> {
  await ensureDataDir();
  await Bun.write(
    STATE_FILE,
    JSON.stringify(
      { done: [...done], updatedAt: new Date().toISOString() },
      null,
      2
    )
  );
}

/** One pass: fetch fresh, rebalance, apply the still-pending changed aircraft for the hub. */
async function runPass(
  live: boolean,
  onlyHub: string | undefined,
  limit: number,
  done: Set<number>
): Promise<{ ok: number; flying: number; fail: number; pending: number }> {
  console.log("· Fetching fresh data + re-running the rebalance …");
  const hubs = await discoverHubs();
  const loadIdByAirport = new Map(hubs.map((h) => [h.airportId, h.loadId]));
  const payloads = await fetchAllPlannings(hubs.map((h) => h.loadId));
  const { lines, aircraft } = buildModel(payloads);
  const curPlan = new Map(
    aircraft.map((a) => [
      a.id,
      a.planningList.map((p) => ({
        lineId: p.lineId,
        takeOffTime: p.takeOffTime,
      })),
    ])
  );
  const result = rebalanceNetwork(aircraft, lines);

  let all = [...result.outcomes.values()].filter((o) => o.plan.length > 0);
  if (onlyHub) {
    all = all.filter((o) => o.destCode === onlyHub);
  }
  // Only touch aircraft that NEED a move (not at their dest hub) or are currently IDLE (need a
  // planning). NEVER re-push to an aircraft that is already flying: the per-pass rebalance gives
  // slightly different target plannings each time, and re-pushing was BREAKING working aircraft
  // (flying count dropped). Leave flying aircraft alone — only deploy idle ones + do the moves.
  all = all.filter((o) => o.moved || (curPlan.get(o.id) ?? []).length === 0);
  // Pending = whatever STILL differs from the live state (the diff itself is the resume
  // mechanism). We do NOT skip by the `done` set: a planning pushed to an in-flight aircraft
  // silently doesn't stick, so trusting `done` would strand it idle — instead we just retry
  // it each pass until its live planning actually matches the target (then the diff drops it).
  const pending = all;
  pending.sort((a, b) => Number(b.moved) - Number(a.moved) || a.id - b.id);
  const targets = Number.isFinite(limit) ? pending.slice(0, limit) : pending;

  const moves = targets.filter((o) => o.moved).length;
  console.log(
    `\nTarget: ${onlyHub ?? "ALL"} · Mode: ${live ? "APPLY (live)" : "DRY RUN"} · moves@${moveConc} plannings@${conc} (no delay)`
  );
  console.log(
    `Changed total: ${all.length} · already done: ${done.size} · pending: ${pending.length} · this run: ${targets.length} (${moves} hub-change)\n`
  );

  let okN = 0;
  let flying = 0;
  let failN = 0;
  if (!live) {
    targets
      .slice(0, 20)
      .forEach((o, i) =>
        console.log(
          `DRY [${i + 1}/${targets.length}] ${o.destCode} · ${o.name} · ${o.moved ? `MOVE ${o.originCode}→${o.destCode} + ` : ""}${o.plan.length} flights`
        )
      );
    console.log(`… (${targets.length} total) — DRY RUN, nothing sent.`);
    return { fail: 0, flying: 0, ok: 0, pending: pending.length };
  }

  // Apply ONE aircraft. CRUCIAL: a hub change takes a moment to settle server-side, and a
  // planning pushed in the SAME request silently doesn't stick (aircraft lands idle at the new
  // hub). So if the aircraft must MOVE, we ONLY move it this pass (no planning, NOT marked done);
  // the NEXT pass sees it settled at its new hub and sets the planning then. If it's already at
  // its hub, we just push the planning and mark it done. In-flight → clear its planning.
  let movedN = 0;
  const applyOne = async (o: (typeof targets)[number]): Promise<void> => {
    try {
      if (o.moved) {
        const destLoad = loadIdByAirport.get(o.destHubId);
        if (!destLoad) {
          throw new Error(`no loadId for ${o.destCode}`);
        }
        await moveAircraftHub(o.id, destLoad);
        movedN++; // its planning is set on the next pass, once the move has settled
        return;
      }
      await updatePlanning({ added: o.plan, aircraftId: o.id });
      done.add(o.id);
      okN++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "NOT_AVAILABLE") {
        flying++;
        if ((curPlan.get(o.id) ?? []).length > 0) {
          try {
            await updatePlanning({ added: [], aircraftId: o.id }); // ground it so it lands → movable next pass
          } catch {
            /* ignore clear failure */
          }
        }
      } else {
        failN++;
        if (failN <= 25) {
          console.log(`✗ ${o.destCode} · ${o.name} (${o.model}) — ${msg}`);
        }
      }
    }
  };

  // PHASE 1 — MOVES at LOW concurrency (CSRF token is per-session; high concurrency collides).
  const moveTargets = targets.filter((o) => o.moved);
  const planTargets = targets.filter((o) => !o.moved);
  for (let i = 0; i < moveTargets.length; i += moveConc) {
    await Promise.all(moveTargets.slice(i, i + moveConc).map(applyOne));
    await saveDone(done);
    if (i % (moveConc * 25) === 0 || i + moveConc >= moveTargets.length) {
      console.log(
        `  moves ${Math.min(i + moveConc, moveTargets.length)}/${moveTargets.length} · ${movedN} ✓ · ${flying} in-flight · ${failN} ✗`
      );
    }
  }
  // PHASE 2 — PLANNINGS at HIGH concurrency (no token → safe to parallelise).
  for (let i = 0; i < planTargets.length; i += conc) {
    await Promise.all(planTargets.slice(i, i + conc).map(applyOne));
    await saveDone(done);
    console.log(
      `  planned ${Math.min(i + conc, planTargets.length)}/${planTargets.length} · ${okN} ✓`
    );
  }

  const stillPending = pending.length - okN; // moved-but-not-yet-planned stay pending (planned next pass)
  console.log(
    `\nPass result: ${movedN} moved · ${okN} planned · in-flight ${flying} · failed ${failN} · still pending ${stillPending}`
  );
  return { fail: failN, flying, ok: okN + movedN, pending: stillPending };
}

async function main() {
  const live = hasFlag("--apply");
  const onlyHub = argValue("--hub")?.toUpperCase();
  const limit = argNumber("--limit", Number.POSITIVE_INFINITY);
  const untilDone = hasFlag("--until-done") || hasFlag("--loop");
  const intervalMin = argNumber("--interval", 20);
  const maxPasses = argNumber("--max-passes", 30);

  if (hasFlag("--reset")) {
    await ensureDataDir();
    await Bun.write(
      STATE_FILE,
      JSON.stringify({ done: [], updatedAt: new Date().toISOString() }, null, 2)
    );
    console.log("· State reset (apply_done.json cleared).");
  }
  const done = await loadDone();

  if (!untilDone) {
    const r = await runPass(live, onlyHub, limit, done);
    if (live) {
      console.log(
        r.pending > 0
          ? `Re-run to continue (skips the ${done.size} already applied), or use --until-done.`
          : `All ${onlyHub ?? ""} aircraft applied. 🎉`
      );
    } else {
      console.log(
        "DRY RUN — nothing sent. Add --apply (test with --limit 5 --apply first)."
      );
    }
    return;
  }

  // --until-done: keep re-running (fresh fetch each time) until nothing is pending. The
  // in-flight aircraft become available as they land, so a few passes finish them all.
  console.log(
    `· UNTIL-DONE: re-running every ${intervalMin} min (max ${maxPasses} passes) until pending = 0.\n`
  );
  for (let pass = 1; pass <= maxPasses; pass++) {
    console.log(`\n══════ PASS ${pass}/${maxPasses} ══════`);
    const r = await runPass(live, onlyHub, Number.POSITIVE_INFINITY, done);
    if (r.pending <= 0) {
      console.log(
        `\n🎉 All ${onlyHub ?? ""} aircraft applied after ${pass} pass(es). Done: ${done.size}.`
      );
      return;
    }
    if (r.ok === 0 && r.fail > 0) {
      console.log(
        `\n✗ Stopping: a pass made 0 progress with ${r.fail} hard failure(s) — the cookie may have expired. Update AM_COOKIE in .env and re-run.`
      );
      return;
    }
    if (pass < maxPasses) {
      console.log(
        `· ${r.pending} still pending (in flight). Sleeping ${intervalMin} min before the next pass …`
      );
      await Bun.sleep(intervalMin * 60_000);
    }
  }
  console.log(
    `\n· Reached max passes. ${done.size} applied. Re-run to finish any remaining.`
  );
}

main().catch((err: unknown) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
