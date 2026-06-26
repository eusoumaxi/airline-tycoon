// ───────────────────────────────────────────────────────────────────────────
// MOVE-ALL-HUB — relocate EVERY aircraft of one hub to another (not just surplus).
// Unlike moveSurplus (which only moves idle aircraft that would fly >=floor at the
// destination), this moves the WHOLE fleet of --from to --to. Aircraft IN FLIGHT can't
// change hub (the game rejects it) → they're reported as "in flight, retry later"; re-run
// until all have moved. After moving, run `apply --hub <TO> --apply` to schedule them.
//
//   bun run src/moveAllHub.ts --from BOG --to DXB            # DRY RUN
//   bun run src/moveAllHub.ts --from BOG --to DXB --apply    # MOVE live (low concurrency)
// ───────────────────────────────────────────────────────────────────────────

import { discoverHubs, fetchAllPlannings } from "./api.ts";
import { buildModel } from "./model.ts";
import { moveAircraftHub } from "./moveApi.ts";

const hasFlag = (f: string) => process.argv.includes(f);
const argVal = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const from = argVal("--from")?.toUpperCase();
  const to = argVal("--to")?.toUpperCase();
  const live = hasFlag("--apply");
  const conc = Math.max(1, argVal("--concurrency") !== undefined ? Number(argVal("--concurrency")) : 4);
  if (!from || !to) throw new Error("Usage: --from <CODE> --to <CODE> [--apply] [--concurrency N]");

  console.log("· Discovering hubs + fetching fresh planning …");
  const hubs = await discoverHubs();
  const { lines, aircraft } = buildModel(await fetchAllPlannings(hubs.map((h) => h.loadId)));
  const codeByHub = new Map<number, string>();
  for (const l of lines.values()) if (!codeByHub.has(l.hubId)) codeByHub.set(l.hubId, l.name.split(" / ")[0]);
  const hubByCode = new Map<string, number>();
  for (const [id, c] of codeByHub) hubByCode.set(c, id);

  const fromHub = hubByCode.get(from);
  const toHub = hubByCode.get(to);
  if (fromHub === undefined) throw new Error(`Hub "${from}" not found. Hubs: ${[...hubByCode.keys()].join(", ")}`);
  if (toHub === undefined) throw new Error(`Hub "${to}" not found. Hubs: ${[...hubByCode.keys()].join(", ")}`);
  const destLoad = hubs.find((h) => h.airportId === toHub)?.loadId;
  if (!destLoad) throw new Error(`No loadId for ${to}`);

  const movers = aircraft.filter((a) => a.hubId === fromHub);
  console.log(`· Move ALL ${from} → ${to} (loadId ${destLoad}): ${movers.length} aircraft · ${live ? "APPLY" : "DRY RUN"} · concurrency ${conc}`);
  if (!live) {
    console.log(`· DRY RUN — nothing moved. Re-run with --apply. (In-flight aircraft will need repeated runs as they land.)`);
    return;
  }

  let ok = 0, flying = 0, fail = 0;
  for (let i = 0; i < movers.length; i += conc) {
    const batch = movers.slice(i, i + conc);
    const res = await Promise.all(batch.map(async (a) => {
      try {
        await moveAircraftHub(a.id, destLoad);
        return "ok" as const;
      } catch (e) {
        return e instanceof Error && e.message === "NOT_AVAILABLE" ? ("fly" as const) : ("fail" as const);
      }
    }));
    for (const r of res) (r === "ok" ? ok++ : r === "fly" ? flying++ : fail++);
    console.log(`  …${Math.min(i + conc, movers.length)}/${movers.length} · ${ok} ✓ · ${flying} in-flight (retry) · ${fail} ✗`);
  }
  console.log(`\nDone. Moved ${ok} · in-flight ${flying} (re-run to catch them as they land) · failed ${fail}.`);
  console.log(`Next: \`bun run src/apply.ts --hub ${to} --apply --until-done --delay 0.5\` to schedule the arrivals.`);
}

main().catch((e: unknown) => {
  console.error("\n✗ Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
