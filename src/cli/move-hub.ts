/**
 * @fileoverview Relocate every aircraft from one hub to another.
 *
 * In-flight aircraft are skipped (`NOT_AVAILABLE`); re-run after they land.
 * Then schedule them with `bun run apply -- --hub <TO> --apply`.
 *
 * @example
 * bun run move-hub -- --from LHR --to CDG
 * bun run move-hub -- --from LHR --to CDG --apply
 */
import { discoverHubs, fetchAllPlannings } from "../lib/api.ts";
import { argNumber, argValue, hasFlag } from "../lib/flags.ts";
import { buildModel, hubCodes } from "../lib/model.ts";
import { moveAircraftHub } from "../lib/move.ts";

async function main() {
  const from = argValue("--from")?.toUpperCase();
  const to = argValue("--to")?.toUpperCase();
  const live = hasFlag("--apply");
  const conc = Math.max(1, argNumber("--concurrency", 4));
  if (!(from && to)) {
    throw new Error(
      "Usage: --from <CODE> --to <CODE> [--apply] [--concurrency N]"
    );
  }

  console.log("· Discovering hubs + fetching fresh planning …");
  const hubs = await discoverHubs();
  const { lines, aircraft } = buildModel(
    await fetchAllPlannings(hubs.map((h) => h.loadId))
  );
  const codeByHub = hubCodes(lines.values());
  const hubByCode = new Map<string, number>();
  for (const [id, c] of codeByHub) {
    hubByCode.set(c, id);
  }

  const fromHub = hubByCode.get(from);
  const toHub = hubByCode.get(to);
  if (fromHub === undefined) {
    throw new Error(
      `Hub "${from}" not found. Hubs: ${[...hubByCode.keys()].join(", ")}`
    );
  }
  if (toHub === undefined) {
    throw new Error(
      `Hub "${to}" not found. Hubs: ${[...hubByCode.keys()].join(", ")}`
    );
  }
  const destLoad = hubs.find((h) => h.airportId === toHub)?.loadId;
  if (!destLoad) {
    throw new Error(`No loadId for ${to}`);
  }

  const movers = aircraft.filter((a) => a.hubId === fromHub);
  console.log(
    `· Move ALL ${from} → ${to} (loadId ${destLoad}): ${movers.length} aircraft · ${live ? "APPLY" : "DRY RUN"} · concurrency ${conc}`
  );
  if (!live) {
    console.log(
      "· DRY RUN — nothing moved. Re-run with --apply. (In-flight aircraft will need repeated runs as they land.)"
    );
    return;
  }

  let ok = 0,
    flying = 0,
    fail = 0;
  for (let i = 0; i < movers.length; i += conc) {
    const batch = movers.slice(i, i + conc);
    const res = await Promise.all(
      batch.map(async (a) => {
        try {
          await moveAircraftHub(a.id, destLoad);
          return "ok" as const;
        } catch (e) {
          return e instanceof Error && e.message === "NOT_AVAILABLE"
            ? ("fly" as const)
            : ("fail" as const);
        }
      })
    );
    for (const r of res) {
      if (r === "ok") {
        ok += 1;
      } else if (r === "fly") {
        flying += 1;
      } else {
        fail += 1;
      }
    }
    console.log(
      `  …${Math.min(i + conc, movers.length)}/${movers.length} · ${ok} ✓ · ${flying} in-flight (retry) · ${fail} ✗`
    );
  }
  console.log(
    `\nDone. Moved ${ok} · in-flight ${flying} (re-run to catch them as they land) · failed ${fail}.`
  );
  console.log(
    `Next: \`bun run src/apply.ts --hub ${to} --apply --until-done --delay 0.5\` to schedule the arrivals.`
  );
}

main().catch((e: unknown) => {
  console.error("\n✗ Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
