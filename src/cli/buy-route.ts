/**
 * @fileoverview Rank (or purchase) a new route so idle aircraft have somewhere to fly.
 *
 * The game hides demand until you audit. Ranking uses category, range, and price only.
 * `--buy <iata>` spends in-game money.
 *
 * @example
 * bun run buyroute -- --hub LHR --country gb
 * bun run buyroute -- --hub LHR --buy cdg
 */
import {
  buyRoute,
  discoverHubs,
  fetchAllPlannings,
  fetchBuyableRoutes,
} from "../lib/api.ts";
import { DATA_DIR, ensureDataDir } from "../lib/config.ts";
import { argValue } from "../lib/flags.ts";
import { fmt } from "../lib/format.ts";
import { buildModel } from "../lib/model.ts";
import { optimize } from "../lib/optimizer.ts";
import type { BuyableRoute } from "../lib/types.ts";

async function main() {
  const hubArg = argValue("--hub")?.toUpperCase();
  const buyCode = argValue("--buy")?.toLowerCase();
  const countries = (argValue("--country") ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!hubArg) {
    throw new Error("Pass --hub <IATA> (e.g. --hub LHR)");
  }
  if (!buyCode && countries.length === 0) {
    throw new Error("Pass --country <cc> (ISO 2-letter, comma-separated)");
  }

  const hubs = await discoverHubs();
  const hub = hubs.find((h) => h.code === hubArg);
  if (!hub) {
    throw new Error(
      `Hub ${hubArg} not found. Hubs: ${hubs.map((h) => h.code).join(", ")}`
    );
  }

  // --buy short-circuits: just purchase the named route (after the user asked for it).
  if (buyCode) {
    console.log(
      `· PURCHASING route ${hubArg}/${buyCode.toUpperCase()} (hub ${hub.loadId}) — this spends in-game money …`
    );
    await buyRoute(hub.loadId, buyCode);
    console.log(
      `✓ Bought ${hubArg}/${buyCode.toUpperCase()}. Re-run \`bun run apply --hub ${hubArg}\` to schedule the idle aircraft onto it.`
    );
    return;
  }

  // Identify this hub's SURPLUS (idle) aircraft to know what category/range we need.
  console.log(
    `· Fetching + optimizing all hubs to find ${hubArg}'s surplus aircraft …`
  );
  const payloads = await fetchAllPlannings(hubs.map((h) => h.loadId));
  const { lines, aircraft } = buildModel(payloads);
  const { plans } = optimize(aircraft, lines);
  const planLen = new Map(plans.map((p) => [p.aircraftId, p.added.length]));
  const idle = aircraft.filter(
    (a) => a.hubId === hub.airportId && (planLen.get(a.id) ?? 0) === 0
  );
  const minCat = idle.length ? Math.min(...idle.map((a) => a.category)) : 1;
  const maxRange = idle.length
    ? Math.max(...idle.map((a) => a.range))
    : Number.POSITIVE_INFINITY;
  console.log(
    `· ${hubArg}: ${idle.length} idle aircraft` +
      (idle.length
        ? ` — need a route with category ≥ ${minCat} (so they qualify) and distance ≤ ${fmt(maxRange)}km.`
        : ".")
  );

  // Fetch + cache the buyable routes for each requested country.
  const all: BuyableRoute[] = [];
  for (const c of countries) {
    try {
      const routes = await fetchBuyableRoutes(hub.loadId, c);
      all.push(...routes);
      console.log(`· ${c.toUpperCase()}: ${routes.length} buyable routes`);
    } catch (e) {
      console.log(
        `· ${c.toUpperCase()}: failed — ${e instanceof Error ? e.message : e}`
      );
    }
  }
  await ensureDataDir();
  await Bun.write(
    `${DATA_DIR}/buyable_${hubArg}.json`,
    JSON.stringify(all, null, 2)
  );

  // Rank the routes the idle aircraft CAN fly (cat ≥ minCat, dist ≤ maxRange) by
  // category (bigger airport = more demand headroom) then price. Demand is hidden.
  const flyable = all
    .filter((r) => r.cat >= minCat && r.dist <= maxRange)
    .sort((x, y) => y.cat - x.cat || x.price - y.price);

  console.log(
    `\n  BUYABLE ROUTES YOUR IDLE ${hubArg} AIRCRAFT COULD FLY (demand hidden until audited):`
  );
  console.log(
    `  ${"route".padEnd(10)} ${"cat".padStart(3)} ${"dist".padStart(6)} ${"price $".padStart(14)} ${"audit $".padStart(12)}   airport`
  );
  console.log(`  ${"─".repeat(74)}`);
  for (const r of flyable.slice(0, 15)) {
    console.log(
      `  ${(`${hubArg}/${r.iata}`).padEnd(10)} ${String(r.cat).padStart(3)} ${(`${fmt(r.dist)}km`).padStart(6)} ` +
        `${fmt(r.price).padStart(14)} ${(r.audited ? "—" : fmt(r.auditPrice)).padStart(12)}   ${r.name}`
    );
  }
  if (flyable.length === 0) {
    console.log(
      "  (none in the scanned countries — try more --country codes, e.g. us,gb,ae)"
    );
  } else {
    const best = flyable[0];
    console.log(
      `\n· Top pick: ${hubArg}/${best.iata} (${best.name}) — cat ${best.cat}, ${fmt(best.dist)}km, $${fmt(best.price)}` +
        (best.audited
          ? ""
          : ` (+$${fmt(best.auditPrice)} to audit demand first)`) +
        `\n  Buy it with:  bun run buyroute --hub ${hubArg} --buy ${best.code}`
    );
  }
  console.log(
    "\n· DRY RUN — nothing was purchased. Demand is hidden until you audit on the dashboard."
  );
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
