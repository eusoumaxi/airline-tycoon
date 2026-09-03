/**
 * @fileoverview Move idle surplus aircraft to hubs that still have unmet eco demand.
 *
 * Only moves a plane that would fly ≥ `UTIL_FLOOR` at the destination.
 * Does not write schedules — run `bun run apply -- --hub <DEST> --apply` afterwards.
 *
 * @example
 * bun run move-surplus
 * bun run move-surplus -- --from LHR --to CDG --apply
 */
import { UTIL_FLOOR, WEEK_SECONDS } from "../lib/config.ts";
import { argNumber, argValue, hasFlag } from "../lib/flags.ts";
import { fmt, pct } from "../lib/format.ts";
import { loadPlanning } from "../lib/io.ts";
import { buildModel, hubCodes } from "../lib/model.ts";
import { moveAircraftHub } from "../lib/move.ts";
import { greedyAllocate, optimize } from "../lib/optimizer.ts";
import type { Aircraft, Line } from "../lib/types.ts";

const utilOf = (a: Aircraft) =>
  Math.min(1, a.assigned.reduce((s, t) => s + t.duration, 0) / WEEK_SECONDS);

interface Move {
  a: Aircraft;
  ecoServed: number;
  fromCode: string;
  toAirport: number;
  toCode: string;
  util: number;
}

async function main() {
  const live = hasFlag("--apply");
  const toCode = argValue("--to")?.toUpperCase();
  const fromCode = argValue("--from")?.toUpperCase();
  const moveConc = Math.max(1, argNumber("--concurrency", 6));
  const { payloads, hubs } = await loadPlanning();
  if (live && !hubs) {
    throw new Error("--apply needs live data (run without --offline).");
  }

  const { lines, aircraft } = buildModel(payloads);
  const codeByHub = hubCodes(lines.values());
  const loadIdByAirport = new Map(
    (hubs ?? []).map((h) => [h.airportId, h.loadId])
  );
  const linesOfHub = new Map<number, Line[]>();
  for (const l of lines.values()) {
    (linesOfHub.get(l.hubId) ?? linesOfHub.set(l.hubId, []).get(l.hubId)!).push(
      l
    );
  }

  // 1) Per-hub eco optimize — leaves line.remaining = leftover eco, and the idle surplus.
  console.log(
    `· Optimizing (eco + util floor) to find the surplus + each hub's leftover demand …`
  );
  optimize(aircraft, lines);
  const homeHub = new Map<number, number>(aircraft.map((a) => [a.id, a.hubId])); // capture BEFORE moving
  let pool = aircraft.filter((a) => !a.isCargo && a.assigned.length === 0); // idle PAX = the surplus
  if (fromCode) {
    pool = pool.filter((a) => codeByHub.get(a.hubId) === fromCode); // restrict surplus source to one hub
    if (pool.length === 0) {
      throw new Error(`Hub "${fromCode}" has no idle surplus pax to move.`);
    }
  }

  // 2) Needy hubs = most leftover eco first.
  const leftoverEco = (hubId: number) =>
    (linesOfHub.get(hubId) ?? []).reduce(
      (s, l) => s + l.remaining.reduce((x, d) => x + d.eco, 0),
      0
    );
  let needy = [...codeByHub.keys()]
    .map((hubId) => ({ eco: leftoverEco(hubId), hubId }))
    .filter((h) => h.eco > 0)
    .sort((a, b) => b.eco - a.eco);
  if (toCode) {
    needy = needy.filter((h) => codeByHub.get(h.hubId) === toCode);
    if (needy.length === 0) {
      throw new Error(
        `Hub "${toCode}" has no unmet eco (nothing to fill there) or doesn't exist.`
      );
    }
  }

  console.log(
    `· Surplus idle pax${fromCode ? ` from ${fromCode}` : ""}: ${pool.length} · destination${toCode ? ` (forced ${toCode})` : "s neediest-first"}: ${needy.map((h) => `${codeByHub.get(h.hubId)} ${fmt(h.eco)}`).join(", ")}`
  );

  // 3) Greedily fill each needy hub with compatible surplus; keep only the ones that reach
  //    the util floor there (worth moving). Their trial fill consumes that hub's leftover.
  const moves: Move[] = [];
  for (const { hubId } of needy) {
    const hubLines = linesOfHub.get(hubId) ?? [];
    const cands = pool.filter(
      (a) =>
        homeHub.get(a.id) !== hubId &&
        hubLines.some((l) => a.range >= l.distance && l.category <= a.category)
    );
    if (cands.length === 0) {
      continue;
    }
    for (const a of cands) {
      a.hubId = hubId; // rehome so canFly matches the destination
    }
    greedyAllocate(cands, hubLines, 0); // single pass onto the hub's LEFTOVER demand (no reset)
    const movers = cands.filter((a) => utilOf(a) >= UTIL_FLOOR);
    for (const a of movers) {
      moves.push({
        a,
        ecoServed: a.assigned.reduce((s, t) => s + t.within.eco, 0),
        fromCode: codeByHub.get(homeHub.get(a.id)!) ?? "?",
        toAirport: hubId,
        toCode: codeByHub.get(hubId) ?? "?",
        util: utilOf(a),
      });
    }
    const movedIds = new Set(movers.map((a) => a.id));
    for (const a of cands) {
      if (!movedIds.has(a.id)) {
        a.hubId = homeHub.get(a.id)!;
        a.assigned = [];
      } // revert non-movers
    }
    pool = pool.filter((a) => !movedIds.has(a.id));
  }

  // 4) Report
  console.log(`\n══ SURPLUS MOVES ${live ? "(APPLY)" : "(DRY RUN)"} ══`);
  if (moves.length === 0) {
    console.log(
      "  No worthwhile moves — no surplus aircraft would reach the util floor at another hub."
    );
    return;
  }
  const byRoute = new Map<string, number>();
  for (const m of moves) {
    byRoute.set(
      `${m.fromCode} → ${m.toCode}`,
      (byRoute.get(`${m.fromCode} → ${m.toCode}`) ?? 0) + 1
    );
  }
  console.log(
    `  ${moves.length} aircraft to move (each would fly ≥${pct(UTIL_FLOOR)} at its destination):`
  );
  for (const [route, n] of [...byRoute].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}× ${route}`);
  }
  console.log("\n  sample:");
  for (const m of moves.slice(0, 15)) {
    console.log(
      `    ${m.a.name.slice(0, 14).padEnd(14)} ${m.a.aircraftListName.padEnd(12)} ${m.fromCode} → ${m.toCode}  util ${pct(m.util)} · eco ${fmt(m.ecoServed)}/wk`
    );
  }
  if (moves.length > 15) {
    console.log(`    … (${moves.length} total)`);
  }

  if (!live) {
    console.log(
      "\n· DRY RUN — nothing moved. Re-run with --apply to move them, then `bun run apply --hub <DEST> --apply` to schedule the arrivals."
    );
    return;
  }

  // 5) Apply the moves (LOW concurrency — hub change uses a per-session CSRF token).
  console.log(`\n· Moving live @ concurrency ${moveConc} (no delay) …`);
  let ok = 0,
    flying = 0,
    fail = 0;
  for (let i = 0; i < moves.length; i += moveConc) {
    const batch = moves.slice(i, i + moveConc);
    const res = await Promise.all(
      batch.map(async (m) => {
        const destLoad = loadIdByAirport.get(m.toAirport);
        if (!destLoad) {
          return { m, status: "no-loadid" as const };
        }
        try {
          await moveAircraftHub(m.a.id, destLoad);
          return { m, status: "ok" as const };
        } catch (e) {
          return {
            err: e,
            m,
            status:
              e instanceof Error && e.message === "NOT_AVAILABLE"
                ? ("flying" as const)
                : ("fail" as const),
          };
        }
      })
    );
    for (const r of res) {
      if (r.status === "ok") {
        ok++;
      } else if (r.status === "flying") {
        flying++;
      } else {
        fail++;
        if (fail <= 20) {
          console.log(
            `  ✗ ${r.m.a.name} ${r.m.fromCode}→${r.m.toCode}: ${r.status === "no-loadid" ? "no loadId" : (r as { err?: unknown }).err instanceof Error ? (r as { err: Error }).err.message : "fail"}`
          );
        }
      }
    }
    console.log(
      `  …${Math.min(i + moveConc, moves.length)}/${moves.length} · ${ok} ✓ · ${flying} in-flight (retry later) · ${fail} ✗`
    );
  }
  console.log(
    `\nDone. Moved ${ok} · in-flight ${flying} (re-run to catch them once landed) · failed ${fail}.`
  );
  console.log(
    "Next: `bun run apply --hub <DEST> --apply` to schedule the moved aircraft at their new hubs."
  );
}

main().catch((err: unknown) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
