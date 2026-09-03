/**
 * @fileoverview Per-hub HTML reports (`data/report_<CODE>.html`).
 */
import {
  BUY_CATALOG,
  DAY_SECONDS,
  DAYS_PER_WEEK,
  ECO_TARGET,
  LEGS_PER_ROUNDTRIP,
  SELL_THRESHOLD,
  WEEK_SECONDS,
} from "./config.ts";
import { esc, fmt, pct } from "./format.ts";
import { capacityOf, roundTripDuration } from "./model.ts";
import {
  type Aircraft,
  type BuyOrder,
  CABIN_CLASSES,
  type CabinClass,
  type HubAdvice,
  type Line,
  type ProposedFlight,
  WEEKDAYS,
} from "./types.ts";

const CLASSES = CABIN_CLASSES;
const DAYS = WEEKDAYS;

/** Convert week-seconds into "Mon 14:30". */
function dayTime(t: number): string {
  const d = Math.floor(t / 86_400) % 7;
  const h = Math.floor((t % 86_400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${DAYS[d]} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function utilOf(durations: number[]): number {
  return Math.min(1, durations.reduce((s, d) => s + d, 0) / WEEK_SECONDS);
}

/**
 * Self-contained HTML for one hub: current vs proposed week grid, routes, buy advice.
 */
export function buildHubHtml(
  hubCode: string,
  hubAircraft: Aircraft[],
  lines: Map<number, Line>,
  plansById: Map<number, ProposedFlight[]>,
  advice: HubAdvice
): string {
  const hubLines = [...lines.values()].filter(
    (l) => hubAircraft[0] && l.hubId === hubAircraft[0].hubId
  );

  // ── Offer per route (from the proposed plan), bucketed by DEPARTURE DAY ───────
  // The game meters demand per day, so weekly totals can look fine while a single
  // day is oversupplied. We track per-day offer to flag the worst day per route.
  const offered = new Map<number, Record<CabinClass, number>>();
  const offeredByDay = new Map<number, Record<CabinClass, number>[]>();
  const flightsPerLine = new Map<number, number>();
  for (const a of hubAircraft) {
    const plan = plansById.get(a.id) ?? [];
    const cap = capacityOf(a);
    for (const f of plan) {
      const o = offered.get(f.lineId) ?? { bus: 0, cargo: 0, eco: 0, first: 0 };
      // A round trip offers BOTH legs against the daily demand (matches the game).
      for (const c of CLASSES) {
        o[c] += cap[c] * LEGS_PER_ROUNDTRIP;
      }
      offered.set(f.lineId, o);
      let days = offeredByDay.get(f.lineId);
      if (!days) {
        days = Array.from({ length: DAYS_PER_WEEK }, () => ({
          bus: 0,
          cargo: 0,
          eco: 0,
          first: 0,
        }));
        offeredByDay.set(f.lineId, days);
      }
      const day = Math.floor((f.takeOffTime % WEEK_SECONDS) / DAY_SECONDS);
      for (const c of CLASSES) {
        days[day][c] += cap[c] * LEGS_PER_ROUNDTRIP;
      }
      flightsPerLine.set(f.lineId, (flightsPerLine.get(f.lineId) ?? 0) + 1);
    }
  }

  // ── Utilization per aircraft (current planning vs proposed plan) ─────────────
  let flying = 0;
  const rows = hubAircraft
    .map((a) => {
      const before = utilOf(
        a.planningList.map((p) =>
          lines.get(p.lineId) ? roundTripDuration(a, lines.get(p.lineId)!) : 0
        )
      );
      const plan = plansById.get(a.id) ?? [];
      const after = utilOf(
        plan.map((f) =>
          lines.get(f.lineId) ? roundTripDuration(a, lines.get(f.lineId)!) : 0
        )
      );
      if (plan.length) {
        flying++;
      }
      return { a, after, before, plan };
    })
    .sort((x, y) => y.after - x.after);

  const idleRows = rows.filter((r) => r.plan.length === 0);

  // ── Route legend (game color) ────────────────────────────────────────────────
  const lineColor = new Map<number, string>();
  for (const l of hubLines) {
    lineColor.set(l.id, l.color || "#999");
  }

  // ── Grid header (hour ticks every 3h + hour gridlines) ───────────────────────
  const hourTicks = Array.from({ length: 9 }, (_, i) => i * 3)
    .map((h) => `<span class="hr" style="left:${(h / 24) * 100}%">${h}</span>`)
    .join("");
  // Hourly gridlines are drawn with a CSS repeating gradient on .dtrack (NOT 24 DOM
  // nodes per row) — with thousands of aircraft that was ~1.6M elements / tens of MB.

  /**
   * Weekly 7-day x 24h grid for an aircraft (flights = colored game blocks).
   * Reusable for the CURRENT or the PROPOSED plan. Flights that cross the week
   * boundary are split (the tail continues on Monday).
   */
  const weekGrid = (
    a: Aircraft,
    planFlights: { takeOffTime: number; lineId: number }[],
    label: string
  ): string => {
    interface Iv {
      col: string;
      e: number;
      head: boolean;
      name: string;
      s: number;
      title: string;
    }
    const ivs: Iv[] = [];
    for (const f of planFlights) {
      const line = lines.get(f.lineId);
      if (!line) {
        continue;
      }
      const dur = roundTripDuration(a, line);
      const s = f.takeOffTime;
      const e = s + dur;
      const col = lineColor.get(f.lineId) ?? "#999";
      const title = `${esc(line.name)} · dep ${dayTime(s)} → arr ${dayTime((s + dur) % WEEK_SECONDS)} · ${(dur / 3600).toFixed(1)}h`;
      if (e <= WEEK_SECONDS) {
        ivs.push({ col, e, head: true, name: esc(line.name), s, title });
      } else {
        ivs.push({
          col,
          e: WEEK_SECONDS,
          head: true,
          name: esc(line.name),
          s,
          title,
        });
        ivs.push({
          col,
          e: e - WEEK_SECONDS,
          head: false,
          name: "",
          s: 0,
          title,
        }); // tail at week start
      }
    }
    const dayRows = DAYS.map((dname, d) => {
      const dStart = d * 86_400;
      const dEnd = dStart + 86_400;
      const segs = ivs
        .map((iv) => {
          const os = Math.max(iv.s, dStart);
          const oe = Math.min(iv.e, dEnd);
          if (os >= oe) {
            return "";
          }
          const left = ((os - dStart) / 86_400) * 100;
          const w = ((oe - os) / 86_400) * 100;
          const lbl = iv.head && iv.s >= dStart && iv.s < dEnd ? iv.name : ""; // label on the departure day
          return `<div class="seg" style="left:${left}%;width:${w}%;background:${iv.col}" title="${iv.title}"><span>${lbl}</span></div>`;
        })
        .join("");
      return `<div class="drow"><span class="dl">${dname}</span><div class="dtrack">${segs}</div></div>`;
    }).join("");
    return `<div class="gwrap"><div class="glabel">${label}</div><div class="grid"><div class="ghead"><span class="dl"></span><div class="hticks">${hourTicks}</div></div>${dayRows}</div></div>`;
  };

  const timeline = rows
    .filter((r) => r.plan.length > 0) // only aircraft that actually fly; idle ones get their own section
    .map(({ a, before, after, plan }) => {
      const routes = [...new Set(plan.map((f) => f.lineId))]
        .map(
          (id) =>
            `${esc(lines.get(id)?.name ?? String(id))}×${plan.filter((f) => f.lineId === id).length}`
        )
        .join(", ");
      const cls = after >= 0.99 ? "hi" : after >= 0.9 ? "mid" : "lo";
      const cur = a.planningList.map((p) => ({
        lineId: p.lineId,
        takeOffTime: p.takeOffTime,
      }));
      return `<details class="acd">
        <summary>
          <span class="nm"><b>${esc(a.name)}</b> <i>${esc(a.aircraftListName)}</i></span>
          <span class="su ${cls}">${plan.length ? pct(after) : "—"}</span>
          <span class="bef">was ${pct(before)}</span>
          <span class="rs">${esc(routes) || "unused"}</span>
        </summary>
        <div class="grids">
          ${weekGrid(a, cur, "● Current")}
          ${weekGrid(a, plan, "● Proposed")}
        </div>
      </details>`;
    })
    .join("");

  const flights = [...flightsPerLine.values()].reduce((s, n) => s + n, 0);

  // ── Coverage now → after buying the recommended fleet ─────────────────────────
  const covCls = (c: number) => (c < 0.5 ? "bad" : c < 0.9 ? "mid" : "ok");
  const covNow = advice.demand.eco
    ? advice.servedNow.eco / advice.demand.eco
    : 1;
  const ecoAfter = Math.max(0, advice.demand.eco - advice.residual.eco);
  const covAfter = advice.demand.eco ? ecoAfter / advice.demand.eco : 1;
  const cargoNow = advice.demand.cargo
    ? advice.servedNow.cargo / advice.demand.cargo
    : 1;
  const cargoAfter = advice.demand.cargo
    ? Math.max(0, advice.demand.cargo - advice.residual.cargo) /
      advice.demand.cargo
    : 1;
  const investment = advice.buyOrders.reduce((s, o) => s + o.totalPrice, 0);
  const toBuy = advice.buyOrders.reduce((s, o) => s + o.count, 0);
  const paxNow =
    advice.demand.eco +
    advice.demand.bus +
    advice.demand.first -
    (advice.servedNow.eco + advice.servedNow.bus + advice.servedNow.first);
  const paxAfter =
    advice.residual.eco + advice.residual.bus + advice.residual.first;

  // ── ECO FILL — THE OBJECTIVE: how much of each route's eco demand the plan serves ─
  // (Business/First/Cargo just ride along; the optimizer only chases eco, target ECO_TARGET.)
  const ecoServedByLine = new Map<number, number>();
  for (const l of hubLines) {
    const days = offeredByDay.get(l.id);
    let s = 0;
    for (let d = 0; d < DAYS_PER_WEEK; d++) {
      s += Math.min(days?.[d].eco ?? 0, l.dailyDemand.eco);
    }
    ecoServedByLine.set(l.id, s);
  }
  const ecoRoutes = hubLines.filter((l) => l.weeklyDemand.eco > 0);
  const hubEcoDemand = ecoRoutes.reduce((s, l) => s + l.weeklyDemand.eco, 0);
  const hubEcoServed = ecoRoutes.reduce(
    (s, l) => s + (ecoServedByLine.get(l.id) ?? 0),
    0
  );
  const hubEcoFill = hubEcoDemand ? hubEcoServed / hubEcoDemand : 1;
  const routesAtTarget = ecoRoutes.filter(
    (l) => (ecoServedByLine.get(l.id) ?? 0) / l.weeklyDemand.eco >= ECO_TARGET
  ).length;
  const ecoTargetPct = `${Math.round(ECO_TARGET * 100)}%`;
  const ecoCls = (c: number) =>
    c >= ECO_TARGET ? "ok" : c >= 0.8 ? "mid" : "bad";
  const underservedByLine = new Map(
    advice.underserved.map((u) => [u.line.id, u])
  );
  // Eco fill per route, WORST-covered first (the objective). Routes stuck below SELL_THRESHOLD
  // are the SELL candidates — the optimizer stopped using them (freed their aircraft).
  const ecoRouteRows = ecoRoutes
    .map((l) => ({
      cov: (ecoServedByLine.get(l.id) ?? 0) / l.weeklyDemand.eco,
      l,
      served: ecoServedByLine.get(l.id) ?? 0,
    }))
    .sort((a, b) => a.cov - b.cov);
  const sellPct = `${Math.round(SELL_THRESHOLD * 100)}%`;
  const sellRoutes = ecoRouteRows.filter((r) => r.cov < SELL_THRESHOLD);

  // ── BUY PLAN — what to buy + what each aircraft actually carries ───────────────
  const seatChips = (c: {
    eco: number;
    bus: number;
    first: number;
    cargo: number;
  }) =>
    `<div class="seats"><span class="seat eco">${fmt(c.eco)} eco</span><span class="seat bus">${fmt(c.bus)} bus</span>` +
    `<span class="seat fst">${fmt(c.first)} first</span><span class="seat cgo">${fmt(c.cargo)}t cargo</span></div>`;
  const loadLine = (o: HubAdvice["buyOrders"][number]) =>
    o.cargoLed
      ? `Each one hauls ≈ <b>${fmt(o.loadPerAircraft.cargo)} t</b> cargo/week`
      : `Each one carries ≈ <b>${fmt(o.loadPerAircraft.eco)}</b> eco · ${fmt(o.loadPerAircraft.bus)} bus · ${fmt(o.loadPerAircraft.first)} first · ${fmt(o.loadPerAircraft.cargo)} t belly /week`;

  const buyHtml = advice.buyOrders.length
    ? `<div class="buy">${advice.buyOrders
        .map(
          (o) => `<div class="buyc ${o.cargoLed ? "cgo" : "pax"}">
        <div class="bt"><b>Buy ${o.count}× ${esc(o.model.model)}</b><span class="tag">${o.cargoLed ? "freighter · " : ""}cat ${o.model.cat} · ${fmt(o.model.range)}km</span><span class="price">$${fmt(o.totalPrice)}</span></div>
        <div class="cfglbl">Set this config (sliders) →</div>${seatChips(o.config)}
        <div class="load">${loadLine(o)} · <span class="util">util ${pct(o.util)}</span></div>
        <div class="why">Flies: ${esc(o.routes.slice(0, 6).join(", "))}${o.routes.length > 6 ? ` +${o.routes.length - 6} more` : ""}</div>
      </div>`
        )
        .join("")}</div>
      <div class="note" style="margin-top:8px">Counts &amp; routes come from running the <b>real optimizer</b> on these new aircraft (profit-validated — only planes that fly profitably are bought). “Set config” is what you slide on the buy screen; “each carries” is what it actually fills.</div>`
    : `<div class="why" style="color:var(--mut)">No new aircraft needed at ${esc(hubCode)} — the current fleet already covers the profitable demand.</div>`;

  const smallGapHtml = advice.smallRouteGap.length
    ? `<div class="warnbox">⚠ <b>${advice.smallRouteGap.length} route(s) need a SMALL aircraft</b> (category too low for the A350/A321 — route cat &lt; 5): ${esc(
        advice.smallRouteGap
          .slice(0, 10)
          .map(
            (g) =>
              `${g.line.name} (cat ${g.line.category}, ${fmt(g.uncovered.eco)} eco/wk)`
          )
          .join(", ")
      )}${advice.smallRouteGap.length > 10 ? ` +${advice.smallRouteGap.length - 10} more` : ""}. These stay unfilled until you add a narrowbody like the B727.</div>`
    : "";

  const bellyHtml = advice.bellyCargo.length
    ? `<div class="warnbox" style="background:#0e2433;border-color:#1f5a7a;color:#9fd4e8">📦 ${fmt(advice.bellyCargo.reduce((s, b) => s + b.tons, 0))} t/week of cargo on ${advice.bellyCargo.length} long route(s) has <b>no freighter with the range</b> (A330P2F reaches 6,850km). It's carried in the <b>belly of the A350-900ULR</b> instead (44 t).</div>`
    : "";

  // ── Routes — demand, what's missing now, and what's left AFTER buying ─────────
  const fillLabel = (u: HubAdvice["underserved"][number]) => {
    if (u.fill.reuseIdle) {
      return `↻ assign idle ${esc(u.fill.reuseIdle.model)} you own`;
    }
    if (u.fill.buyModel) {
      return `🛒 ${esc(u.fill.buyModel.model)}${u.fill.cargoLed ? " (freighter)" : ""}`;
    }
    if (u.fill.note === "belly-cargo") {
      return "📦 A350 belly (no freighter reaches)";
    }
    if (u.fill.note === "low-cat") {
      return `⚠ small aircraft (cat ≤ ${u.line.category})`;
    }
    if (u.fill.note === "no-reach") {
      return "⚠ too far for any model";
    }
    return "—";
  };
  // Eco fill per route table — built from ecoRouteRows (computed above, worst-first).
  const routesHtml = ecoRouteRows.length
    ? `<table class="rt"><thead><tr><th>Route</th><th class="n">cat</th><th class="n">km</th><th class="n">eco demand</th><th class="n">eco served</th><th class="n">eco fill</th><th>if &lt; ${ecoTargetPct}: fill with</th><th class="n">eco left after buy</th></tr></thead><tbody>
    ${ecoRouteRows
      .map(({ l, served, cov }) => {
        const u = underservedByLine.get(l.id);
        const below = cov < ECO_TARGET;
        const res = u?.residual;
        const afterCell = below
          ? res
            ? res.eco < 1
              ? `<span class="okc">✓</span>`
              : `<span class="gap">${fmt(res.eco)}</span>`
            : "—"
          : `<span class="okc">✓</span>`;
        return `<tr>
        <td><span class="dot" style="background:${l.color || "#999"}"></span>${esc(l.name)}</td>
        <td class="n">${l.category}</td><td class="n">${fmt(l.distance)}</td>
        <td class="n">${fmt(l.weeklyDemand.eco)}</td>
        <td class="n">${fmt(served)}</td>
        <td class="n"><span class="cov ${ecoCls(cov)}">${pct(cov)}</span></td>
        <td class="fillc">${below ? (u ? fillLabel(u) : "—") : ""}</td>
        <td class="n">${afterCell}</td>
      </tr>`;
      })
      .join("")}
    </tbody></table>`
    : `<div class="why" style="color:var(--mut)">No eco demand at ${esc(hubCode)}.</div>`;

  // ── Routes to SELL — eco stuck below the sell threshold (optimizer stopped using them) ──
  const sellHtml = sellRoutes.length
    ? `<table class="rt"><thead><tr><th>Route</th><th class="n">cat</th><th class="n">km</th><th class="n">eco demand</th><th class="n">eco fill</th><th>verdict / alternative</th></tr></thead><tbody>
    ${sellRoutes
      .map(({ l, cov }) => {
        const u = underservedByLine.get(l.id);
        let verdict: string;
        if (u?.fill.note === "no-reach") {
          verdict = `<b class="sell">SELL</b> — too far for any aircraft you can buy`;
        } else if (u?.fill.note === "low-cat") {
          verdict = `<b class="sell">SELL</b> — needs a smaller aircraft (route cat ${l.category}); none in catalog`;
        } else if (u) {
          verdict = `<span class="keep">KEEP &amp; buy</span> ${fillLabel(u)} — or sell`;
        } else {
          verdict = `<span class="keep">KEEP &amp; buy</span> not enough aircraft here — or sell`;
        }
        return `<tr>
        <td><span class="dot" style="background:${l.color || "#999"}"></span>${esc(l.name)}</td>
        <td class="n">${l.category}</td><td class="n">${fmt(l.distance)}</td>
        <td class="n">${fmt(l.weeklyDemand.eco)}</td>
        <td class="n"><span class="cov bad">${pct(cov)}</span></td>
        <td class="fillc">${verdict}</td>
      </tr>`;
      })
      .join("")}
    </tbody></table>`
    : `<div class="why" style="color:var(--mut)">No route falls below ${sellPct} eco — nothing to sell. 🎉</div>`;

  // ── Current fleet: split FLYING (grid) vs IDLE (with the reason why) ──────────
  const idleHtml = advice.surplus.length
    ? `<div class="idle">${advice.surplus
        .map(
          (s) => `<div class="idlec">
        <div class="bt"><b>${s.count}× ${esc(s.model)}</b><span class="tag idle-tag">IDLE · cat ${s.cat} · ${fmt(s.range)}km</span><span class="cfg2">${s.seats.eco}/${s.seats.bus}/${s.seats.first} +${s.seats.cargo}t</span></div>
        <div class="why2"><b>Why idle:</b> ${esc(s.reason)}</div>
        <div class="actbox act-${s.action.kind}"><b>Do:</b> ${esc(s.action.text)}${s.alt ? `<span class="alt">${esc(s.alt)}</span>` : ""}</div>
      </div>`
        )
        .join("")}</div>`
    : `<div class="why" style="color:var(--mut)">No idle aircraft — every plane you own at ${esc(hubCode)} is flying.</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Planning ${esc(hubCode)} — readjustment</title>
<style>
  :root{--bg:#0f1420;--card:#1a2030;--ln:#2a3550;--tx:#e6ebf5;--mut:#8e9bb5;--hi:#37d67a;--mid:#f5a623;--lo:#ec5b5b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
  h1{margin:0 0 4px;font-size:26px}.sub{color:var(--mut);margin-bottom:22px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:26px}
  .c{background:var(--card);border:1px solid var(--ln);border-radius:12px;padding:14px 16px}
  .c .k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .c .v{font-size:24px;font-weight:700;margin-top:4px}
  .c .v small{font-size:13px;color:var(--mut);font-weight:500}
  .c .v.warn{color:var(--mid)}
  .arw{color:var(--hi)}
  h2{font-size:16px;margin:30px 0 12px;border-bottom:1px solid var(--ln);padding-bottom:8px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--ln);font-size:13px;vertical-align:middle}
  th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:var(--bg)}
  td.n{text-align:right;font-variant-numeric:tabular-nums}
  /* collapsible aircraft list with weekly grid */
  .acd{background:var(--card);border:1px solid var(--ln);border-radius:9px;margin-bottom:6px;overflow:hidden}
  .acd summary{display:flex;align-items:center;gap:14px;padding:8px 14px;cursor:pointer;list-style:none}
  .acd summary::-webkit-details-marker{display:none}
  .acd summary::before{content:"▸";color:var(--mut);font-size:10px;flex:none}
  .acd[open] summary::before{content:"▾"}
  .acd[open]{border-color:#37507e}
  .acd summary:hover{background:#212a3e}
  .nm{min-width:175px;flex:none}.nm b{font-size:14px}.nm i{color:var(--mut);font-style:normal;font-size:11px;margin-left:5px}
  summary .su{font-weight:700;font-variant-numeric:tabular-nums;min-width:52px;flex:none}
  summary .su.hi{color:var(--hi)}summary .su.mid{color:var(--mid)}summary .su.lo{color:var(--lo)}
  summary .bef{color:var(--mut);font-size:11px;flex:none}
  .rs{color:var(--mut);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .grids{display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid var(--ln)}
  @media(max-width:900px){.grids{grid-template-columns:1fr}}
  .gwrap{padding:8px 12px 12px}
  .gwrap+.gwrap{border-left:1px solid var(--ln)}
  .glabel{font-size:11px;color:var(--mut);font-weight:600;margin-bottom:6px}
  .ghead,.drow{display:flex;align-items:center;gap:8px;height:21px}
  .dl{width:30px;color:var(--mut);font-size:11px;flex:none;text-align:right}
  .hticks{position:relative;flex:1;height:13px}
  .hticks .hr{position:absolute;font-size:9px;color:#46527a;transform:translateX(-50%)}
  .dtrack{position:relative;flex:1;height:18px;background-color:#0a0e17;background-image:linear-gradient(90deg,#161d30 0 1px,transparent 1px);background-size:calc(100%/24) 100%;border-radius:3px;border:1px solid var(--ln)}
  .seg{position:absolute;top:1px;height:16px;border-radius:2px;overflow:hidden;display:flex;align-items:center;box-shadow:0 0 0 1px #0006 inset}
  .seg span{font-size:9px;color:#10151f;font-weight:700;padding:0 4px;white-space:nowrap}
  td.over{color:var(--lo)}td.under{color:var(--mut)}
  td.over .d,td.under .d{display:block;font-size:10px}
  /* decisions panel */
  .panel{background:linear-gradient(180deg,#16203a,#131a2c);border:1px solid #2d3c63;border-radius:14px;padding:18px 20px;margin:6px 0 26px}
  .panel h2{margin-top:0;border:0}
  .buy{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px}
  .buyc{background:#0e1626;border:1px solid #32507e;border-radius:11px;padding:13px 15px}
  .buyc .bt{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:9px}
  .buyc .bt b{font-size:16px}
  .buyc .price{margin-left:auto;color:var(--hi);font-weight:700;font-variant-numeric:tabular-nums}
  .tag{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;background:#24304d;color:#9fb4dd;text-transform:uppercase;letter-spacing:.03em}
  .seats{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px}
  .seat{font-size:12px;font-weight:700;padding:3px 9px;border-radius:7px;font-variant-numeric:tabular-nums}
  .seat.eco{background:#143a27;color:#5be39a}.seat.bus{background:#3a3413;color:#f0cf5b}
  .seat.fst{background:#3a1330;color:#f08bd6}.seat.cgo{background:#13303a;color:#5bd6f0}
  .buyc .why{color:var(--mut);font-size:12px}
  .buyc .stats{display:flex;gap:12px;flex-wrap:wrap;margin:2px 0 8px;font-size:12px;color:var(--mut)}
  .buyc .stats .st b{color:var(--tx)}.buyc .stats i{color:#6fb0ff;font-style:normal}
  .actbox{border-radius:9px;padding:6px 10px;font-size:12.5px;line-height:1.5}
  .act-buy-route{background:#0e2a1a;border:1px solid #1f6e44}
  .act-reconfigure-cargo{background:#0e2433;border:1px solid #1f5a7a}
  .act-move-hub{background:#2a2410;border:1px solid #7a651f}
  .act-surplus{background:#2a1414;border:1px solid #7a2f2f}
  .alt{color:var(--mut);font-size:11px;display:block;margin-top:3px}
  .warnbox{background:#2a1f10;border:1px solid #7a5d1f;border-radius:9px;padding:11px 14px;font-size:13px;margin-top:12px;color:#f0d28b}
  td.gap{color:var(--lo);font-weight:700;font-variant-numeric:tabular-nums}
  td.fillc{font-size:12px}
  .cov{display:inline-block;min-width:42px;font-variant-numeric:tabular-nums;font-weight:700}
  .cov.bad{color:var(--lo)}.cov.mid{color:var(--mid)}.cov.ok{color:var(--hi)}
  .sell{color:var(--lo);font-weight:700}.keep{color:#6fb0ff;font-weight:700}
  td.okc{color:var(--hi);font-weight:700}
  .sub2{color:var(--mut);font-size:10px;font-weight:400}
  /* coverage cards with before→after */
  .c .v .ar{color:var(--mut);font-weight:400;margin:0 4px}
  .c .v .to{color:var(--hi)}
  .buyc.pax{border-color:#2f6e4a}.buyc.cgo{border-color:#1f5a7a}
  .cfglbl{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
  .buyc .load{font-size:12px;color:var(--mut);margin-bottom:7px}.buyc .load b{color:var(--tx)}.buyc .util{color:#6fb0ff;font-weight:600}
  /* idle cards */
  .idle{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px}
  .idlec{background:#1a1622;border:1px solid #5a3a5a;border-radius:11px;padding:13px 15px}
  .idlec .bt{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:7px}
  .idle-tag{background:#3a2440;color:#e0a8e0}
  .cfg2{margin-left:auto;color:var(--mut);font-size:11px;font-variant-numeric:tabular-nums}
  .why2{font-size:12.5px;margin-bottom:7px;line-height:1.5}.why2 b{color:#e0a8e0}
  .rt th,.rt td{padding:6px 8px}
  .badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;margin-left:8px;vertical-align:middle}
  .badge.own{background:#143a27;color:#5be39a}.badge.idle{background:#3a2440;color:#e0a8e0}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .note{color:var(--mut);font-size:12px;margin-top:8px}
  .ctrls{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
  .ctrls button{background:var(--card);color:var(--tx);border:1px solid var(--ln);border-radius:7px;padding:7px 12px;font-size:12px;cursor:pointer}
  .ctrls button:hover{background:#212a3e;border-color:#37507e}
  .ctrls #flt{flex:1;min-width:180px;background:#0a0e17;color:var(--tx);border:1px solid var(--ln);border-radius:7px;padding:7px 12px;font-size:12px}
</style></head><body><div class="wrap">
  <h1>${esc(hubCode)} — fleet plan: what to fill, what to buy</h1>
  <div class="sub">${hubAircraft.length} aircraft you own · ${hubLines.length} routes · ${fmt(flights)} flights/week · read-only (nothing sent to the game)</div>

  <div class="cards">
    <div class="c"><div class="k">Eco filled (plan)</div><div class="v"><span class="cov ${ecoCls(hubEcoFill)}">${pct(hubEcoFill)}</span><span class="ar">→</span><span class="to">${pct(covAfter)}</span> <small>after buy</small></div></div>
    <div class="c"><div class="k">Routes ≥${ecoTargetPct} eco</div><div class="v">${routesAtTarget}<small> / ${ecoRoutes.length}</small></div></div>
    <div class="c"><div class="k">Routes to sell (&lt;${sellPct})</div><div class="v">${sellRoutes.length ? `<span class="sell">${sellRoutes.length}</span>` : "0"}<small> / ${ecoRoutes.length}</small></div></div>
    <div class="c"><div class="k">Unserved eco / week</div><div class="v">${fmt(advice.demand.eco - advice.servedNow.eco)}<span class="ar">→</span><span class="to">${fmt(advice.residual.eco)}</span></div></div>
    <div class="c"><div class="k">Cargo covered</div><div class="v"><span class="cov ${covCls(cargoNow)}">${pct(cargoNow)}</span><span class="ar">→</span><span class="to">${pct(cargoAfter)}</span></div></div>
    <div class="c"><div class="k">Your fleet</div><div class="v">${flying}<small> flying · ${idleRows.length} idle</small></div></div>
    <div class="c"><div class="k">To buy</div><div class="v">${fmt(toBuy)}<small> aircraft · $${fmt(investment)}</small></div></div>
  </div>

  <div class="panel">
    <h2>🛒 Buy plan — what to buy for ${esc(hubCode)}, and what each plane carries</h2>
    ${buyHtml}
    ${smallGapHtml}
    ${bellyHtml}
    <div class="note">After buying all of the above: eco coverage <b>${pct(covNow)} → ${pct(covAfter)}</b>, unserved pax <b>${fmt(paxNow)} → ${fmt(paxAfter)}</b>/week. Set the hub to <b>${esc(hubCode)}</b> on the buy screen and slide the config shown; buy incrementally and re-run to schedule them.</div>
  </div>

  <h2>🏷️ Routes to sell — ${sellRoutes.length} stuck below ${sellPct} eco</h2>
  <div class="note" style="margin-bottom:10px">The optimizer couldn't lift these to ${sellPct} eco with your fleet, so it <b>stopped using them</b> (freeing aircraft for routes it can fill). <b class="sell">SELL</b> = no catalog aircraft can serve it at all (category/range) — drop it. <span class="keep">KEEP &amp; buy</span> = it's only under-resourced; buy the aircraft shown to keep it, or sell it.</div>
  ${sellHtml}

  <h2>📊 Eco fill per route — % of each route's eco demand the plan serves (target ≥${ecoTargetPct})</h2>
  <div class="note" style="margin-bottom:10px">Every route you own with eco demand, <b>worst-covered first</b>. The optimizer's ONLY objective is ECO: it fills each route to ${ecoTargetPct} then moves the aircraft on (business/first ride along; freighters are planned for cargo). Rows below ${ecoTargetPct} show what would fill them; <b>eco left after buy</b> = still short once you buy the plan above. Hub eco fill <b>${pct(hubEcoFill)}</b> · <b>${routesAtTarget}/${ecoRoutes.length}</b> routes already ≥${ecoTargetPct}.</div>
  ${routesHtml}

  <h2>✈️ Your current fleet — ${flying} flying <span class="badge own">OWNED</span></h2>
  <div class="note" style="margin-bottom:10px">Existing aircraft only (the new ones above don't exist yet). Expand a row to see its week, Current vs Proposed schedule side by side.</div>
  <div class="ctrls">
    <button onclick="document.querySelectorAll('.acd').forEach(d=>d.open=true)">▾ Expand all</button>
    <button onclick="document.querySelectorAll('.acd').forEach(d=>d.open=false)">▸ Collapse all</button>
    <input id="flt" placeholder="filter by aircraft or route…" oninput="var q=this.value.toLowerCase();document.querySelectorAll('.acd').forEach(d=>d.style.display=d.textContent.toLowerCase().includes(q)?'':'none')">
  </div>
  <div class="aclist">${timeline}</div>

  <h2>💤 Idle aircraft — ${idleRows.length} not used <span class="badge idle">WHY?</span></h2>
  <div class="note" style="margin-bottom:10px">Aircraft you own that the optimizer leaves on the ground — each with the REASON and what to do about it.</div>
  ${idleHtml}
</div></body></html>`;
}

/**
 * Combined buy list across hubs (`data/report_SUMMARY.html`).
 * Counts are a full-cover ceiling, not a realistic shopping list.
 */
export function buildSummaryHtml(advices: HubAdvice[]): string {
  const models = BUY_CATALOG.map((m) => m.model);
  const isCargo = new Map(BUY_CATALOG.map((m) => [m.model, !!m.cargo]));
  const agg = (orders: BuyOrder[]) => {
    const by = new Map<string, { count: number; price: number }>();
    for (const o of orders) {
      const g = by.get(o.model.model) ?? { count: 0, price: 0 };
      g.count += o.count;
      g.price += o.totalPrice;
      by.set(o.model.model, g);
    }
    return by;
  };
  const perHub = advices
    .map((a) => ({
      a,
      by: agg(a.buyOrders),
      total: a.buyOrders.reduce((s, o) => s + o.totalPrice, 0),
    }))
    .sort((x, y) => x.total - y.total);
  const grand = new Map<string, { count: number; price: number }>();
  for (const ph of perHub) {
    for (const [m, g] of ph.by) {
      const x = grand.get(m) ?? { count: 0, price: 0 };
      x.count += g.count;
      x.price += g.price;
      grand.set(m, x);
    }
  }
  const grandTotal = perHub.reduce((s, ph) => s + ph.total, 0);
  const smallTotal = advices.reduce((s, a) => s + a.smallRouteGap.length, 0);
  const bellyTotal = advices.reduce(
    (s, a) => s + a.bellyCargo.reduce((t, b) => t + b.tons, 0),
    0
  );

  const modelCards = models
    .map((m) => {
      const g = grand.get(m) ?? { count: 0, price: 0 };
      return `<div class="c"><div class="k">${esc(m)}${isCargo.get(m) ? " · cargo" : ""}</div><div class="v">${fmt(g.count)}<small> ✈ · $${fmt(g.price)}</small></div></div>`;
    })
    .join("");

  const head = `<tr><th>Hub</th>${models.map((m) => `<th class="n">${esc(m.replace("-900ULR", "").replace("-300P2F", "P2F"))}</th>`).join("")}<th class="n">Total $</th><th class="n">Unserved eco/wk</th><th class="n">Cargo t/wk</th><th class="n">Small-ac routes</th></tr>`;
  const rows = perHub
    .map(
      ({ a, by, total }) => `<tr>
      <td><a href="report_${esc(a.code)}.html"><b>${esc(a.code)}</b></a></td>
      ${models.map((m) => `<td class="n">${(by.get(m)?.count ?? 0) > 0 ? fmt(by.get(m)?.count ?? 0) : "·"}</td>`).join("")}
      <td class="n">$${fmt(total)}</td>
      <td class="n">${fmt(a.uncoveredEcoSeats)}</td>
      <td class="n">${fmt(a.uncoveredCargoTons)}</td>
      <td class="n">${a.smallRouteGap.length || "·"}</td>
    </tr>`
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fleet plan — what to buy</title>
<style>
  :root{--bg:#0f1420;--card:#1a2030;--ln:#2a3550;--tx:#e6ebf5;--mut:#8e9bb5;--hi:#37d67a;--mid:#f5a623}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
  h1{margin:0 0 4px;font-size:25px}.sub{color:var(--mut);margin-bottom:22px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
  .c{background:var(--card);border:1px solid var(--ln);border-radius:12px;padding:14px 16px}
  .c .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  .c .v{font-size:23px;font-weight:700;margin-top:4px}.c .v small{font-size:12px;color:var(--mut);font-weight:500}
  .big{background:linear-gradient(180deg,#16203a,#131a2c);border-color:#32507e}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--ln);font-size:13px}
  th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
  a{color:#6fb0ff;text-decoration:none}a:hover{text-decoration:underline}
  .note{color:var(--mut);font-size:12.5px;margin-top:14px;line-height:1.6}
  .warn{background:#2a1f10;border:1px solid #7a5d1f;border-radius:9px;padding:11px 14px;font-size:13px;margin-top:14px;color:#f0d28b}
</style></head><body><div class="wrap">
  <h1>Fleet plan — what to buy to fill the routes you already own</h1>
  <div class="sub">${advices.length} hubs · only the aircraft you picked (A350-900ULR, A321XLR + freighters A330-300P2F, A321P2F) · config per hub is in each hub report</div>
  <div class="cards">
    <div class="c big"><div class="k">Total spend (full coverage)</div><div class="v">$${fmt(grandTotal)}</div></div>
    ${modelCards}
  </div>
  <table><thead>${head}</thead><tbody>${rows}</tbody></table>
  <div class="warn">⚠ These counts FULLY cover every route's demand — in big hubs the demand dwarfs any realistic fleet, so the numbers are huge. Buy <b>incrementally</b>, starting with the cheap hubs at the top of the table, and re-run after each batch. ${smallTotal ? `${smallTotal} route(s) across hubs need a <b>small aircraft</b> (cat &lt; 5) the A350/A321 can't fly.` : ""} ${bellyTotal ? `${fmt(bellyTotal)} t/week of long-haul cargo has no freighter range → carry in A350 belly.` : ""}</div>
  <div class="note">Click a hub to open its detailed report (shopping cards with the exact seat config, underserved routes, and surplus actions). Sorted by total spend (cheapest first).</div>
</div></body></html>`;
}
