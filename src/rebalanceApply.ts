// ───────────────────────────────────────────────────────────────────────────
// APPLY the cross-hub rebalance to the game — RESUMABLE & fault-tolerant.
//   · DRY-RUN by default; sends only with --apply.
//   · --hub ADD restricts to one hub; --limit N caps how many to send (safe test).
//   · Keeps a STATE FILE (.test/data/apply_done.json) of aircraft already applied, so
//     re-running SKIPS them and only does the pending ones — re-run as many times as
//     needed until everything is moved (some aircraft can't change hub while in flight,
//     so it takes a few passes). --reset clears the state.
//   · CONTINUES on any failure (logs the reason), retries the hub-change a few times.
//
// Per aircraft that changes vs the live state:
//   · if it changes hub → POST /aircraft/show/<id>/attribute (hubId=<loadId>) first, then
//   · push its new planning → POST /network/planning/0/ajax (reused updatePlanning).
// 1s delay (config) between aircraft.
//
//   bun run src/rebalanceApply.ts --hub ADD                    # DRY RUN — scope
//   bun run src/rebalanceApply.ts --hub ADD --limit 5 --apply  # LIVE test (5)
//   bun run src/rebalanceApply.ts --hub ADD --apply            # LIVE — does the available ones
//   …re-run the same command to pick up the rest (auto-skips the done ones).
// ───────────────────────────────────────────────────────────────────────────

import { discoverHubs, fetchAllPlannings, updatePlanning } from "./api.ts";
import { BASE_URL, COOKIE, USER_AGENT } from "./config.ts";
import { buildModel } from "./model.ts";
import { rebalanceNetwork } from "./rebalance.ts";
import type { ProposedFlight } from "./types.ts";

const STATE_FILE = ".test/data/apply_done.json";
const hasFlag = (f: string) => process.argv.includes(f);
const argVal = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// Planning concurrency: how many planning pushes in parallel (no token → safe at 100).
const conc = Math.max(1, argVal("--concurrency") !== undefined ? Number(argVal("--concurrency")) : 100);
// Move concurrency: hub changes use a per-SESSION CSRF token, so many concurrent moves
// invalidate each other's token (302). Keep this LOW. Default 4.
const moveConc = Math.max(1, argVal("--move-concurrency") !== undefined ? Number(argVal("--move-concurrency")) : 4);

function plansEqual(cur: { lineId: number; takeOffTime: number }[], next: ProposedFlight[]): boolean {
  if (cur.length !== next.length) return false;
  const key = (f: { lineId: number; takeOffTime: number }) => `${f.lineId}@${f.takeOffTime}`;
  const a = cur.map(key).sort();
  const b = next.map(key).sort();
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function loadDone(): Promise<Set<number>> {
  const f = Bun.file(STATE_FILE);
  if (!(await f.exists())) return new Set();
  try {
    const j = (await f.json()) as { done: number[] };
    return new Set(j.done ?? []);
  } catch {
    return new Set();
  }
}
async function saveDone(done: Set<number>): Promise<void> {
  await Bun.write(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), done: [...done] }, null, 2));
}

function pageHeaders(referer: string): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "es,en-US;q=0.9,en;q=0.8,ru;q=0.7,fr;q=0.6,pt;q=0.5",
    "content-type": "application/x-www-form-urlencoded",
    cookie: COOKIE,
    origin: BASE_URL,
    referer,
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "user-agent": USER_AGENT,
  };
}

/** Fetch the hub-change token. Throws "NOT_AVAILABLE" when the form isn't on the page
 *  (the aircraft can't change hub right now — usually because it's in flight). */
async function fetchAttributeToken(aircraftId: number): Promise<string> {
  const url = `${BASE_URL}/aircraft/show/${aircraftId}/attribute`;
  // GET referer = the aircraft page (matches the browser flow that works).
  const res = await fetch(url, { headers: pageHeaders(`${BASE_URL}/aircraft/show/${aircraftId}`) });
  if (!res.ok) throw new Error(`GET attribute -> ${res.status} (cookie expired?)`);
  const html = await res.text();
  const token = /name="form\[_token\]"\s+value="([^"]+)"/.exec(html)?.[1] ?? /form%5B_token%5D=([^"&']+)/.exec(html)?.[1];
  if (!token) throw new Error("NOT_AVAILABLE"); // no hub-change form on the page right now
  return token;
}

/** Move an aircraft to another hub, with retries. `destLoadId` = the hub LOAD id.
 *  A SUCCESSFUL move returns 200; a REJECTED one 302-redirects back to /aircraft (e.g. stale
 *  session, in flight, no funds) — we treat any redirect as a failure (the bug that hid it). */
async function moveAircraftHub(aircraftId: number, destLoadId: number): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = await fetchAttributeToken(aircraftId);
      const url = `${BASE_URL}/aircraft/show/${aircraftId}/attribute`;
      const res = await fetch(url, { method: "POST", redirect: "manual", headers: { ...pageHeaders(url), "cache-control": "max-age=0" }, body: `hubId=${destLoadId}&form%5B_token%5D=${encodeURIComponent(token)}` });
      if (res.status >= 300 && res.status < 400) throw new Error(`REJECTED (redirect ${res.headers.get("location") ?? "?"}) — session/funds/in-flight`);
      if (!res.ok) throw new Error(`POST attribute -> ${res.status}`);
      const text = await res.text();
      if (/erreur|error|no se|insufficient|insuffisant|solde/i.test(text.slice(0, 600))) throw new Error(`rejected: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
      return; // 200 = applied
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && e.message === "NOT_AVAILABLE") throw e; // state-based, retrying now won't help
      await Bun.sleep(1500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("move failed");
}

/** One pass: fetch fresh, rebalance, apply the still-pending changed aircraft for the hub. */
async function runPass(live: boolean, onlyHub: string | undefined, limit: number, done: Set<number>): Promise<{ ok: number; flying: number; fail: number; pending: number }> {
  console.log("· Fetching fresh data + re-running the rebalance …");
  const hubs = await discoverHubs();
  const loadIdByAirport = new Map(hubs.map((h) => [h.airportId, h.loadId]));
  const payloads = await fetchAllPlannings(hubs.map((h) => h.loadId));
  const { lines, aircraft } = buildModel(payloads);
  const curPlan = new Map(aircraft.map((a) => [a.id, a.planningList.map((p) => ({ lineId: p.lineId, takeOffTime: p.takeOffTime }))]));
  const result = rebalanceNetwork(aircraft, lines);

  let all = [...result.outcomes.values()].filter((o) => o.plan.length > 0);
  if (onlyHub) all = all.filter((o) => o.destCode === onlyHub);
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
  console.log(`\nTarget: ${onlyHub ?? "ALL"} · Mode: ${live ? "APPLY (live)" : "DRY RUN"} · moves@${moveConc} plannings@${conc} (no delay)`);
  console.log(`Changed total: ${all.length} · already done: ${done.size} · pending: ${pending.length} · this run: ${targets.length} (${moves} hub-change)\n`);

  let okN = 0;
  let flying = 0;
  let failN = 0;
  if (!live) {
    targets.slice(0, 20).forEach((o, i) => console.log(`DRY [${i + 1}/${targets.length}] ${o.destCode} · ${o.name} · ${o.moved ? `MOVE ${o.originCode}→${o.destCode} + ` : ""}${o.plan.length} flights`));
    console.log(`… (${targets.length} total) — DRY RUN, nothing sent.`);
    return { ok: 0, flying: 0, fail: 0, pending: pending.length };
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
        if (!destLoad) throw new Error(`no loadId for ${o.destCode}`);
        await moveAircraftHub(o.id, destLoad);
        movedN++; // its planning is set on the next pass, once the move has settled
        return;
      }
      await updatePlanning({ aircraftId: o.id, added: o.plan });
      done.add(o.id);
      okN++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "NOT_AVAILABLE") {
        flying++;
        if ((curPlan.get(o.id) ?? []).length > 0) {
          try {
            await updatePlanning({ aircraftId: o.id, added: [] }); // ground it so it lands → movable next pass
          } catch {
            /* ignore clear failure */
          }
        }
      } else {
        failN++;
        if (failN <= 25) console.log(`✗ ${o.destCode} · ${o.name} (${o.model}) — ${msg}`);
      }
    }
  };

  // PHASE 1 — MOVES at LOW concurrency (CSRF token is per-session; high concurrency collides).
  const moveTargets = targets.filter((o) => o.moved);
  const planTargets = targets.filter((o) => !o.moved);
  for (let i = 0; i < moveTargets.length; i += moveConc) {
    await Promise.all(moveTargets.slice(i, i + moveConc).map(applyOne));
    await saveDone(done);
    if (i % (moveConc * 25) === 0 || i + moveConc >= moveTargets.length) console.log(`  moves ${Math.min(i + moveConc, moveTargets.length)}/${moveTargets.length} · ${movedN} ✓ · ${flying} in-flight · ${failN} ✗`);
  }
  // PHASE 2 — PLANNINGS at HIGH concurrency (no token → safe to parallelise).
  for (let i = 0; i < planTargets.length; i += conc) {
    await Promise.all(planTargets.slice(i, i + conc).map(applyOne));
    await saveDone(done);
    console.log(`  planned ${Math.min(i + conc, planTargets.length)}/${planTargets.length} · ${okN} ✓`);
  }

  const stillPending = pending.length - okN; // moved-but-not-yet-planned stay pending (planned next pass)
  console.log(`\nPass result: ${movedN} moved · ${okN} planned · in-flight ${flying} · failed ${failN} · still pending ${stillPending}`);
  return { ok: okN + movedN, flying, fail: failN, pending: stillPending };
}

async function main() {
  const live = hasFlag("--apply");
  const onlyHub = argVal("--hub")?.toUpperCase();
  const limit = argVal("--limit") !== undefined ? Number(argVal("--limit")) : Infinity;
  const untilDone = hasFlag("--until-done") || hasFlag("--loop");
  const intervalMin = argVal("--interval") !== undefined ? Number(argVal("--interval")) : 20;
  const maxPasses = argVal("--max-passes") !== undefined ? Number(argVal("--max-passes")) : 30;

  if (hasFlag("--reset")) {
    await Bun.write(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), done: [] }, null, 2));
    console.log("· State reset (apply_done.json cleared).");
  }
  const done = await loadDone();

  if (!untilDone) {
    const r = await runPass(live, onlyHub, limit, done);
    if (live) console.log(r.pending > 0 ? `Re-run to continue (skips the ${done.size} already applied), or use --until-done.` : `All ${onlyHub ?? ""} aircraft applied. 🎉`);
    else console.log("DRY RUN — nothing sent. Add --apply (test with --limit 5 --apply first).");
    return;
  }

  // --until-done: keep re-running (fresh fetch each time) until nothing is pending. The
  // in-flight aircraft become available as they land, so a few passes finish them all.
  console.log(`· UNTIL-DONE: re-running every ${intervalMin} min (max ${maxPasses} passes) until pending = 0.\n`);
  for (let pass = 1; pass <= maxPasses; pass++) {
    console.log(`\n══════ PASS ${pass}/${maxPasses} ══════`);
    const r = await runPass(live, onlyHub, Infinity, done);
    if (r.pending <= 0) {
      console.log(`\n🎉 All ${onlyHub ?? ""} aircraft applied after ${pass} pass(es). Done: ${done.size}.`);
      return;
    }
    if (r.ok === 0 && r.fail > 0) {
      console.log(`\n✗ Stopping: a pass made 0 progress with ${r.fail} hard failure(s) — likely the cookie expired. Re-paste COOKIE in src/config.ts and re-run.`);
      return;
    }
    if (pass < maxPasses) {
      console.log(`· ${r.pending} still pending (in flight). Sleeping ${intervalMin} min before the next pass …`);
      await Bun.sleep(intervalMin * 60_000);
    }
  }
  console.log(`\n· Reached max passes. ${done.size} applied. Re-run to finish any remaining.`);
}

main().catch((err: unknown) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
