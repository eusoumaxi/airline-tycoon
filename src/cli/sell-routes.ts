/**
 * @fileoverview List routes the optimizer leaves below `SELL_THRESHOLD`.
 *
 * `SELL` = no owned or catalog aircraft can fly it (category/range).
 * `NEEDS-AIRCRAFT` = under-resourced; a move or buy could cover it.
 * `--apply` closes `SELL` routes only (irreversible).
 *
 * @example
 * bun run sell-routes
 * bun run sell-routes -- --apply --limit 1
 */
import { sellLine } from "../lib/api.ts";
import {
  BUY_CATALOG,
  DATA_DIR,
  DAYS_PER_WEEK,
  ensureDataDir,
  SELL_THRESHOLD,
} from "../lib/config.ts";
import { argNumber, hasFlag } from "../lib/flags.ts";
import { fmt, pct } from "../lib/format.ts";
import { loadPlanning } from "../lib/io.ts";
import { buildModel, hubCodes } from "../lib/model.ts";
import { optimize } from "../lib/optimizer.ts";
import type { Line } from "../lib/types.ts";

/** Can ANY aircraft type (owned or buyable) physically fly this route? (cat + range) */
function coverable(
  line: Line,
  ownedTypes: { category: number; range: number }[]
): boolean {
  if (
    ownedTypes.some(
      (t) => t.range >= line.distance && t.category <= line.category
    )
  ) {
    return true;
  }
  return BUY_CATALOG.some(
    (m) => m.range >= line.distance && m.cat <= line.category
  );
}

async function main() {
  const { payloads } = await loadPlanning();
  const { lines, aircraft } = buildModel(payloads);
  console.log(
    `· Model: ${aircraft.length} aircraft, ${lines.size} routes. Optimizing (eco + util floor + sell-drop) …`
  );
  optimize(aircraft, lines); // mutates line.remaining to the post-plan leftover

  // Distinct owned aircraft "types" (category/range) — to judge if a route is coverable at all.
  const ownedTypes = [
    ...new Map(
      aircraft.map((a) => [
        `${a.category}/${a.range}`,
        { category: a.category, range: a.range },
      ])
    ).values(),
  ];

  const codeByHub = hubCodes(lines.values());

  interface Row {
    cov: number;
    hub: string;
    line: Line;
    verdict: "SELL" | "NEEDS-AIRCRAFT";
  }
  const rows: Row[] = [];
  for (const l of lines.values()) {
    if (l.weeklyDemand.eco <= 0) {
      continue;
    }
    let leftover = 0;
    for (let d = 0; d < DAYS_PER_WEEK; d++) {
      leftover += l.remaining[d].eco;
    }
    const served = l.weeklyDemand.eco - leftover;
    const cov = served / l.weeklyDemand.eco;
    if (cov >= SELL_THRESHOLD) {
      continue;
    }
    rows.push({
      cov,
      hub: codeByHub.get(l.hubId) ?? "?",
      line: l,
      verdict: coverable(l, ownedTypes) ? "NEEDS-AIRCRAFT" : "SELL",
    });
  }
  rows.sort((a, b) => a.hub.localeCompare(b.hub) || a.cov - b.cov);

  const sellReal = rows.filter((r) => r.verdict === "SELL");
  const needs = rows.filter((r) => r.verdict === "NEEDS-AIRCRAFT");
  console.log(
    `\n══ ROUTES BELOW ${pct(SELL_THRESHOLD)} ECO (sell candidates) ══`
  );
  console.log(
    `Total ${rows.length} · SELL (unservable, drop it) ${sellReal.length} · NEEDS-AIRCRAFT (move/buy) ${needs.length}\n`
  );

  // Per-hub breakdown
  const byHub = new Map<string, Row[]>();
  for (const r of rows) {
    (byHub.get(r.hub) ?? byHub.set(r.hub, []).get(r.hub)!).push(r);
  }
  console.log(
    `${"hub".padEnd(5)} ${"toSell".padStart(7)} ${"SELL".padStart(5)} ${"needAc".padStart(7)}`
  );
  for (const [hub, rs] of [...byHub].sort(
    (a, b) => b[1].length - a[1].length
  )) {
    console.log(
      `${hub.padEnd(5)} ${String(rs.length).padStart(7)} ${String(rs.filter((r) => r.verdict === "SELL").length).padStart(5)} ${String(rs.filter((r) => r.verdict === "NEEDS-AIRCRAFT").length).padStart(7)}`
    );
  }

  console.log("\n── SELL (no aircraft can fly these — actually drop them) ──");
  if (sellReal.length === 0) {
    console.log(
      "  (none — every uncovered route is at least flyable by some aircraft)"
    );
  }
  for (const r of sellReal) {
    console.log(
      `  ${r.hub} · ${r.line.name.padEnd(11)} cat ${r.line.category} · ${fmt(r.line.distance)}km · eco ${pct(r.cov)} · demand ${fmt(r.line.weeklyDemand.eco)}/wk · id ${r.line.id}`
    );
  }

  // Machine-readable output for any follow-up.
  await ensureDataDir();
  await Bun.write(
    `${DATA_DIR}/sell_routes.json`,
    JSON.stringify(
      rows.map((r) => ({
        category: r.line.category,
        distance: r.line.distance,
        ecoCoverage: r.cov,
        ecoDemand: r.line.weeklyDemand.eco,
        hub: r.hub,
        lineId: r.line.id,
        route: r.line.name,
        verdict: r.verdict,
      })),
      null,
      2
    )
  );
  console.log(`\n· Full list (${rows.length}) → ${DATA_DIR}/sell_routes.json`);

  // ── SELL the unservable routes (only verdict==SELL) — IRREVERSIBLE, sequential ──────
  const live = hasFlag("--apply");
  const limit = argNumber("--limit", Number.POSITIVE_INFINITY);
  if (!live) {
    console.log(
      `· REPORT ONLY. To SELL the ${sellReal.length} unservable route(s): --apply (test first with --limit 1 --apply). NEEDS-AIRCRAFT routes are never sold.\n`
    );
    return;
  }
  if (hasFlag("--offline")) {
    throw new Error(
      "--apply needs live data + live token (run without --offline)."
    );
  }
  const targets = sellReal.slice(
    0,
    Number.isFinite(limit) ? limit : sellReal.length
  );
  console.log(`\n⚠ SELLING ${targets.length} route(s) LIVE (irreversible)…`);
  let ok = 0,
    fail = 0;
  for (const r of targets) {
    try {
      const res = await sellLine(r.line.id);
      ok++;
      console.log(
        `  ✓ SOLD ${r.hub} · ${r.line.name} (id ${r.line.id}) — ${res.slice(0, 80)}`
      );
    } catch (e) {
      fail++;
      console.log(
        `  ✗ FAIL ${r.hub} · ${r.line.name} (id ${r.line.id}) — ${e instanceof Error ? e.message : e}`
      );
    }
    await Bun.sleep(500);
  }
  console.log(
    `\nDone selling: ${ok} ✓ · ${fail} ✗ (of ${targets.length}). ${Number.isFinite(limit) && sellReal.length > limit ? `Re-run without --limit to sell the remaining ${sellReal.length - targets.length}.` : ""}\n`
  );
}

main().catch((err: unknown) => {
  console.error("\n✗ Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
