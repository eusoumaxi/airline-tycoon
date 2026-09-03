/**
 * @fileoverview Self-contained HTML for `bun run rebalance` (`data/report_REBALANCE.html`).
 */
import { esc, fmt, pct } from "./format.ts";
import type {
  AircraftOutcome,
  ClassBreakdown,
  HubPlan,
  RebalanceResult,
} from "./rebalance.ts";
import { CABIN_CLASSES, type CabinClass } from "./types.ts";

const CLASSES = CABIN_CLASSES;
const pct0 = (n: number) => `${Math.round(n * 100)}%`;

const utilCls = (u: number) => (u >= 0.95 ? "hi" : u >= 0.8 ? "mid" : "lo");
const covCls = (c: number) => (c < 0.5 ? "lo" : c < 0.9 ? "mid" : "hi");
const cfg = (s: Record<CabinClass, number>) =>
  `${fmt(s.eco)}/${fmt(s.bus)}/${fmt(s.first)} +${fmt(s.cargo)}t`;

/** A small before→after bar (muted "before" underlay, colored "after" overlay). */
function deltaBar(before: number, after: number, cls: string): string {
  const b = Math.max(0, Math.min(1, before)) * 100;
  const a = Math.max(0, Math.min(1, after)) * 100;
  return `<div class="bar"><i class="bb" style="width:${b}%"></i><i class="ba ${cls}" style="width:${a}%"></i></div>`;
}

const strategyTag = (s: HubPlan["strategy"]) =>
  s === "reinforced"
    ? `<span class="tag opt">⊕ reinforced</span>`
    : s === "donor"
      ? `<span class="tag donor">⊖ donor</span>`
      : s === "starved"
        ? `<span class="tag starv">∅ no aircraft</span>`
        : `<span class="tag lock">✓ stable</span>`;

const statusTag = (s: AircraftOutcome["status"]) =>
  ({
    activated: `<span class="st act">activated</span>`,
    idle: `<span class="st idle">idle</span>`,
    kept: `<span class="st kept">kept</span>`,
    "moved-in": `<span class="st mv">moved in</span>`,
  })[s];

/** Capacity table: per-class demand / offered / served / oversupply, before & after. */
function breakdownTable(b: Record<CabinClass, ClassBreakdown>): string {
  const rows = CLASSES.map((c) => {
    const r = b[c];
    if (r.demand === 0 && r.offeredAfter === 0 && r.offeredBefore === 0) {
      return "";
    }
    const covB = r.demand ? r.servedBefore / r.demand : 1;
    const covA = r.demand ? r.servedAfter / r.demand : 1;
    const unit = c === "cargo" ? " t" : "";
    return `<tr>
      <td><span class="cdot ${c}"></span>${c.toUpperCase()}</td>
      <td class="n">${fmt(r.demand)}${unit}</td>
      <td class="n mut">${fmt(r.offeredBefore)}</td>
      <td class="n mut">${fmt(r.servedBefore)}</td>
      <td class="n">${fmt(r.offeredAfter)}</td>
      <td class="n"><b>${fmt(r.servedAfter)}</b></td>
      <td class="n ${r.overAfter > 0 ? "over" : "mut"}">${r.overAfter > 0 ? `+${fmt(r.overAfter)}` : "—"}</td>
      <td class="barcell">${deltaBar(covB, covA, covCls(covA))}<span class="covn ${covCls(covA)}">${pct0(covA)}</span></td>
    </tr>`;
  }).join("");
  return `<table class="bd"><thead><tr><th>Class</th><th class="n">Demand/wk</th><th class="n">Off. before</th><th class="n">Served before</th><th class="n">Off. after</th><th class="n">Served after</th><th class="n">Oversupply</th><th>Coverage before→after</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Compact table of aircraft assigned to a hub (capped — full set is in the plan JSON). */
function assignedTable(list: AircraftOutcome[], cap = 60): string {
  if (list.length === 0) {
    return `<div class="muted">No aircraft assigned.</div>`;
  }
  const sorted = list.slice().sort((x, y) => y.utilAfter - x.utilAfter);
  const extra =
    sorted.length > cap
      ? `<div class="muted">… and ${sorted.length - cap} more aircraft based here (full list in rebalance_plan.json).</div>`
      : "";
  const rows = sorted
    .slice(0, cap)
    .map(
      (o) => `<tr>
      <td>${statusTag(o.status)}</td>
      <td><b>${esc(o.name)}</b> <i class="mut">${esc(o.model)}</i>${o.moved ? ` <span class="frm">← ${esc(o.originCode)}</span>` : ""}</td>
      <td class="n mut">cat ${o.category}</td>
      <td class="n">${o.flightsAfter}</td>
      <td class="n"><span class="u ${utilCls(o.utilBefore)}">${pct0(o.utilBefore)}</span> → <span class="u ${utilCls(o.utilAfter)}">${pct0(o.utilAfter)}</span></td>
      <td class="rs">${esc(o.routes.slice(0, 5).join(", "))}${o.routes.length > 5 ? ` +${o.routes.length - 5}` : ""}</td>
    </tr>`
    )
    .join("");
  return `<table class="ac"><thead><tr><th></th><th>Aircraft</th><th class="n">cat</th><th class="n">flts</th><th class="n">util before→after</th><th>Routes</th></tr></thead><tbody>${rows}</tbody></table>${extra}`;
}

/** One collapsible hub section. */
function hubSection(h: HubPlan): string {
  const targetBadge =
    h.strategy === "starved"
      ? ""
      : h.hitTarget
        ? `<span class="tgt ok">✓ ≥95% util</span>`
        : `<span class="tgt no">below 95% util</span>`;
  const ICAP = 60;
  const incSorted = h.incoming
    .slice()
    .sort((a, b) => b.utilAfter - a.utilAfter);
  const incExtra =
    incSorted.length > ICAP
      ? `<div class="muted">… and ${incSorted.length - ICAP} more moved in (full list in rebalance_plan.json).</div>`
      : "";
  const incomingHtml = h.incoming.length
    ? `<table class="ac"><thead><tr><th>Aircraft</th><th>From</th><th class="n">cat/range</th><th>Config (e/b/f+cgo)</th><th class="n">util here</th><th>Now flies</th></tr></thead><tbody>${incSorted
        .slice(0, ICAP)
        .map(
          (o) =>
            `<tr><td><b>${esc(o.name)}</b> <i class="mut">${esc(o.model)}</i></td><td><span class="frm">${esc(o.originCode)} →</span></td><td class="n mut">${o.category}/${fmt(o.range)}</td><td class="mono">${cfg(o.seats)}</td><td class="n"><span class="u ${utilCls(o.utilAfter)}">${pct0(o.utilAfter)}</span></td><td class="rs">${esc(o.routes.slice(0, 4).join(", "))}${o.routes.length > 4 ? ` +${o.routes.length - 4}` : ""}</td></tr>`
        )
        .join("")}</tbody></table>${incExtra}`
    : `<div class="muted">No aircraft moved in.</div>`;
  const OCAP = 40;
  const outHtml = h.outgoing.length
    ? `<div class="outc">${h.outgoing
        .slice(0, OCAP)
        .map(
          (o) =>
            `<span class="chip mv">${esc(o.name)} <i>${esc(o.model)}</i> → ${esc(o.destCode)}</span>`
        )
        .join(
          ""
        )}</div>${h.outgoing.length > OCAP ? `<div class="muted">… and ${h.outgoing.length - OCAP} more relocated away.</div>` : ""}`
    : `<div class="muted">Nothing relocated away from this hub.</div>`;

  return `<details class="hub">
    <summary>
      <span class="ord">#${h.order}</span>
      <span class="hcode">${esc(h.code)}</span>
      ${strategyTag(h.strategy)}
      <span class="hmeta">${h.routeCount} routes · ${h.flyingBefore}→${h.assignedAfter.length} aircraft</span>
      <span class="hutil">util <span class="u ${utilCls(h.utilBefore)}">${pct0(h.utilBefore)}</span> → <span class="u ${utilCls(h.utilAfter)}">${pct0(h.utilAfter)}</span></span>
      ${targetBadge}
      ${h.incoming.length ? `<span class="in">+${h.incoming.length} in</span>` : ""}
      ${h.outgoing.length ? `<span class="out">−${h.outgoing.length} out</span>` : ""}
    </summary>
    <div class="hubbody">
      <p class="reason">${esc(h.reasoning)}</p>
      <div class="mini">
        <div class="m"><div class="mk">Aircraft</div><div class="mv">${h.flyingBefore}<span class="ar">→</span>${h.assignedAfter.length}</div></div>
        <div class="m"><div class="mk">Avg utilisation</div><div class="mv"><span class="u ${utilCls(h.utilBefore)}">${pct(h.utilBefore)}</span><span class="ar">→</span><span class="u ${utilCls(h.utilAfter)}">${pct(h.utilAfter)}</span></div></div>
        <div class="m"><div class="mk">Eco coverage</div><div class="mv"><span class="u ${covCls(h.coverageBeforeEco)}">${pct(h.coverageBeforeEco)}</span><span class="ar">→</span><span class="u ${covCls(h.coverageAfterEco)}">${pct(h.coverageAfterEco)}</span></div></div>
        <div class="m"><div class="mk">Moved in / out</div><div class="mv">${h.incoming.length}<span class="sub"> in</span> · ${h.outgoing.length}<span class="sub"> out</span></div></div>
      </div>

      <h4>Capacity & coverage — before vs after (per-day capped, both legs)</h4>
      ${breakdownTable(h.breakdown)}

      <div class="cols">
        <div><h4>⬇ Moved IN (${h.incoming.length})</h4>${incomingHtml}</div>
        <div><h4>⬆ Left this hub (${h.outgoing.length})</h4>${outHtml}</div>
      </div>

      <h4>Fleet based here after the plan (${h.assignedAfter.length})</h4>
      ${assignedTable(h.assignedAfter)}
    </div>
  </details>`;
}

/** HTML report for `bun run rebalance` (`data/report_REBALANCE.html`). */
export function buildRebalanceHtml(
  r: RebalanceResult,
  meta: { fetchedAt: string; source: string }
): string {
  const changed = r.hubs.filter(
    (h) => h.strategy === "reinforced" || h.strategy === "donor"
  );
  const stable = r.hubs.filter((h) => h.strategy === "stable");
  const starved = r.hubs.filter((h) => h.strategy === "starved");
  const totalAircraft = r.outcomes.size;
  const idleBefore = r.before.idle;
  const idleAfter = r.idle.length;
  const activated = [...r.outcomes.values()].filter(
    (o) => o.status === "activated"
  ).length;
  const hubsBelowTarget = r.hubs.filter(
    (h) => h.strategy !== "starved" && !h.hitTarget
  );

  // ── Order table ──────────────────────────────────────────────────────────────
  const orderRows = r.hubs
    .map(
      (h) => `<tr class="srow" data-hub="${esc(h.code)}">
      <td class="n">${h.order}</td>
      <td><b>${esc(h.code)}</b></td>
      <td class="n">${h.routeCount}</td>
      <td>${strategyTag(h.strategy)}</td>
      <td class="n">${h.flyingBefore}<span class="ar">→</span>${h.assignedAfter.length}</td>
      <td class="n"><span class="u ${utilCls(h.utilBefore)}">${pct0(h.utilBefore)}</span><span class="ar">→</span><span class="u ${utilCls(h.utilAfter)}">${pct0(h.utilAfter)}</span></td>
      <td class="n"><span class="u ${covCls(h.coverageBeforeEco)}">${pct0(h.coverageBeforeEco)}</span><span class="ar">→</span><span class="u ${covCls(h.coverageAfterEco)}">${pct0(h.coverageAfterEco)}</span></td>
      <td class="n">${h.incoming.length ? `<span class="in">+${h.incoming.length}</span>` : "·"} ${h.outgoing.length ? `<span class="out">−${h.outgoing.length}</span>` : ""}</td>
      <td>${h.strategy === "starved" ? "—" : h.hitTarget ? `<span class="tgt ok">✓</span>` : `<span class="tgt no">↓</span>`}</td>
    </tr>`
    )
    .join("");

  // ── Network coverage bars (per class, before→after) ──────────────────────────
  const covBars = CLASSES.map((c) => {
    const b = r.before.coverage[c];
    const a = r.after.coverage[c];
    const cb = b.demand ? b.served / b.demand : 0;
    const ca = a.demand ? a.served / a.demand : 0;
    return `<div class="cbrow"><span class="cbl"><span class="cdot ${c}"></span>${c.toUpperCase()}</span>${deltaBar(cb, ca, covCls(ca))}<span class="cbn"><span class="mut">${pct0(cb)}</span> → <b class="${covCls(ca)}">${pct0(ca)}</b></span></div>`;
  }).join("");

  // ── Master moves table (capped; the full set is always in rebalance_plan.json) ──
  const MCAP = 1000;
  const movesSorted = r.moves
    .slice()
    .sort(
      (x, y) =>
        x.destCode.localeCompare(y.destCode) || y.utilAfter - x.utilAfter
    );
  const movesExtra =
    movesSorted.length > MCAP
      ? `<div class="muted">… and ${movesSorted.length - MCAP} more moves — the complete list is in <code>rebalance_plan.json</code>.</div>`
      : "";
  const movesRows = movesSorted
    .slice(0, MCAP)
    .map(
      (o) => `<tr>
      <td><b>${esc(o.name)}</b></td>
      <td><i class="mut">${esc(o.model)}</i>${o.isCargo ? ` <span class="frt">cargo</span>` : ""}</td>
      <td class="route"><span class="frm">${esc(o.originCode)}</span> <span class="arr">→</span> <b>${esc(o.destCode)}</b></td>
      <td class="n mut">${o.category}/${fmt(o.range)}km</td>
      <td class="mono">${cfg(o.seats)}</td>
      <td class="n"><span class="u ${utilCls(o.utilBefore)}">${pct0(o.utilBefore)}</span> → <span class="u ${utilCls(o.utilAfter)}">${pct0(o.utilAfter)}</span></td>
      <td class="rs">${esc(o.routes.slice(0, 4).join(", "))}${o.routes.length > 4 ? ` +${o.routes.length - 4}` : ""}</td>
    </tr>`
    )
    .join("");

  // ── Idle aircraft, grouped by model + reason ─────────────────────────────────
  const idleByModel = new Map<string, AircraftOutcome[]>();
  for (const o of r.idle) {
    (
      idleByModel.get(o.model) ?? idleByModel.set(o.model, []).get(o.model)!
    ).push(o);
  }
  const idleCards = [...idleByModel.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([model, list]) => {
      const reason =
        (list[0] as AircraftOutcome & { reasoning?: string }).reasoning ?? "";
      const homes = [...new Set(list.map((o) => o.originCode))].join(", ");
      return `<div class="idlec">
        <div class="bt"><b>${list.length}× ${esc(model)}</b><span class="tag idle-tag">cat ${list[0].category} · ${fmt(list[0].range)}km</span><span class="cfg2">at ${esc(homes)}</span></div>
        <div class="why2"><b>Why idle:</b> ${esc(reason)}</div>
      </div>`;
    })
    .join("");

  // ── Headline deltas ──────────────────────────────────────────────────────────
  const valDelta = r.after.servedValue - r.before.servedValue;
  const valPct = r.before.servedValue ? valDelta / r.before.servedValue : 0;
  const ecoB = r.before.coverage.eco.demand
    ? r.before.coverage.eco.served / r.before.coverage.eco.demand
    : 0;
  const ecoA = r.after.coverage.eco.demand
    ? r.after.coverage.eco.served / r.after.coverage.eco.demand
    : 0;
  const cargoB = r.before.coverage.cargo.demand
    ? r.before.coverage.cargo.served / r.before.coverage.cargo.demand
    : 0;
  const cargoA = r.after.coverage.cargo.demand
    ? r.after.coverage.cargo.served / r.after.coverage.cargo.demand
    : 0;
  const idleDeployed = idleBefore - idleAfter;
  const workingMoved = r.moves.filter((o) => o.utilBefore > 0).length;
  const freighters = [...r.outcomes.values()].filter((o) => o.isCargo);
  const freightMoved = freighters.filter((o) => o.moved).length;
  const _reinforcedCodes = r.hubs
    .filter((h) => h.strategy === "reinforced")
    .map((h) => h.code);
  const topHub = r.hubs[0]; // most routes = #1 priority
  const topCargoB = topHub?.breakdown.cargo.demand
    ? topHub.breakdown.cargo.servedBefore / topHub.breakdown.cargo.demand
    : 0;
  const topCargoA = topHub?.breakdown.cargo.demand
    ? topHub.breakdown.cargo.servedAfter / topHub.breakdown.cargo.demand
    : 0;
  const ecoOversupply = r.hubs.reduce(
    (s, h) => s + h.breakdown.eco.overAfter,
    0
  );
  const starvedCodes = starved.map((h) => h.code);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Network rebalance — proposed plan</title>
<style>
  :root{--bg:#0f1420;--card:#1a2030;--ln:#2a3550;--tx:#e6ebf5;--mut:#8e9bb5;--hi:#37d67a;--mid:#f5a623;--lo:#ec5b5b;--mv:#6fb0ff;--pur:#c089f0}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1240px;margin:0 auto;padding:28px 20px 80px}
  h1{margin:0 0 4px;font-size:27px}.sub{color:var(--mut);margin-bottom:8px}
  .banner{background:#13243a;border:1px solid #27507e;border-radius:9px;padding:9px 14px;font-size:12.5px;color:#aacbf0;margin:14px 0 22px}
  .banner b{color:#dcebff}
  .findings{background:linear-gradient(180deg,#16203a,#131a2c);border:1px solid #32507e;border-radius:12px;padding:14px 18px;margin:14px 0 6px}
  .findings .fhead{font-weight:700;font-size:14px;margin-bottom:6px}
  .findings ul{margin:0;padding-left:20px;line-height:1.65}.findings li{margin:5px 0;font-size:13px;color:#cdd9ee}
  .findings code{background:#0a0e17;padding:1px 5px;border-radius:4px;color:#bcd0ee;font-size:12px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:10px}
  .c{background:var(--card);border:1px solid var(--ln);border-radius:12px;padding:14px 16px}
  .c .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  .c .v{font-size:24px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
  .c .v small{font-size:12px;color:var(--mut);font-weight:500}
  .c .v .ar{color:var(--mut);font-weight:400;margin:0 5px;font-size:18px}
  .c.big{background:linear-gradient(180deg,#16203a,#131a2c);border-color:#32507e}
  .u.hi,.hi{color:var(--hi)}.u.mid,.mid{color:var(--mid)}.u.lo,.lo{color:var(--lo)}
  .u{font-variant-numeric:tabular-nums;font-weight:700}
  h2{font-size:17px;margin:34px 0 6px;border-bottom:1px solid var(--ln);padding-bottom:8px}
  .h2note{color:var(--mut);font-size:12.5px;margin:0 0 12px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--ln);font-size:13px;vertical-align:middle}
  th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
  td.mut,.mut{color:var(--mut)}
  .ar{color:var(--mut);margin:0 3px}
  .mono,.route{font-variant-numeric:tabular-nums}
  .mono{font-size:12px;color:#bcd0ee}
  .rs{color:var(--mut);font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* tags */
  .tag{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
  .tag.opt{background:#13301f;color:#5be39a}.tag.lock{background:#2a2410;color:#f0cf5b}.tag.starv{background:#2a1414;color:#ec8c8c}.tag.donor{background:#2a1f10;color:#f0b25b}
  .st{font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px;white-space:nowrap}
  .st.mv{background:#13294a;color:#8fc0ff}.st.act{background:#13301f;color:#6fe0a0}.st.kept{background:#222a3e;color:#9fb0d0}.st.lock{background:#2a2410;color:#f0cf5b}.st.idle{background:#2a1414;color:#ec8c8c}
  .frm{color:var(--mv);font-size:11px}.frt,.frt2{color:#5bd6f0}
  .in{color:var(--hi);font-weight:700;font-size:12px}.out{color:var(--mid);font-weight:700;font-size:12px}
  .tgt{font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px}
  .tgt.ok{background:#13301f;color:#5be39a}.tgt.no{background:#2a2014;color:#f0b25b}
  /* coverage bars */
  .bar{position:relative;display:inline-block;width:120px;height:11px;background:#0a0e17;border:1px solid var(--ln);border-radius:6px;overflow:hidden;vertical-align:middle}
  .bar .bb{position:absolute;left:0;top:0;height:100%;background:#37507e;opacity:.55}
  .bar .ba{position:absolute;left:0;top:0;height:100%;border-radius:6px}
  .bar .ba.hi{background:var(--hi)}.bar .ba.mid{background:var(--mid)}.bar .ba.lo{background:var(--lo)}
  .cbrow{display:flex;align-items:center;gap:12px;margin:7px 0}
  .cbl{width:64px;font-size:12px;font-weight:600;color:var(--mut)}
  .cbn{font-size:12px;font-variant-numeric:tabular-nums}.cbn b{font-weight:700}
  .cbrow .bar{width:340px;max-width:46vw}
  .cdot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:middle}
  .cdot.eco{background:#5be39a}.cdot.bus{background:#f0cf5b}.cdot.first{background:#f08bd6}.cdot.cargo{background:#5bd6f0}
  .barcell{min-width:180px}.covn{margin-left:8px;font-weight:700;font-variant-numeric:tabular-nums}
  td.over{color:var(--mid);font-weight:600}
  /* hub sections */
  details.hub{background:var(--card);border:1px solid var(--ln);border-radius:11px;margin-bottom:8px;overflow:hidden}
  details.hub[open]{border-color:#37507e}
  .hub summary{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;list-style:none;flex-wrap:wrap}
  .hub summary::-webkit-details-marker{display:none}
  .hub summary::before{content:"▸";color:var(--mut);font-size:11px}
  .hub[open] summary::before{content:"▾"}
  .hub summary:hover{background:#212a3e}
  .ord{color:var(--mut);font-weight:700;font-size:12px;min-width:26px}
  .hcode{font-size:18px;font-weight:800;letter-spacing:.02em;min-width:48px}
  .hmeta{color:var(--mut);font-size:12px}
  .hutil{font-size:12px;color:var(--mut)}
  .hubbody{padding:6px 18px 20px;border-top:1px solid var(--ln)}
  .reason{color:#c7d3ea;font-size:13px;background:#12182a;border-left:3px solid #37507e;padding:9px 13px;border-radius:0 7px 7px 0;margin:14px 0}
  .mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0 6px}
  .mini .m{background:#12182a;border:1px solid var(--ln);border-radius:9px;padding:9px 12px}
  .mini .mk{color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
  .mini .mv{font-size:17px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums}
  .mini .mv .sub{font-size:11px;color:var(--mut);font-weight:500}
  h4{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:20px 0 7px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  @media(max-width:880px){.cols{grid-template-columns:1fr}}
  .outc{display:flex;flex-wrap:wrap;gap:6px}
  .chip{font-size:11px;padding:3px 9px;border-radius:7px;background:#12182a;border:1px solid var(--ln)}
  .chip i{color:var(--mut);font-style:normal}
  .chip.mv{border-color:#27507e;color:#aacbf0}.chip.idle{border-color:#6a3a3a;color:#e0a0a0}
  .muted{color:var(--mut);font-size:12.5px;padding:4px 0}
  table.bd td,table.bd th,table.ac td,table.ac th{padding:6px 8px}
  table.ac .u{font-size:12px}
  /* methodology + idle */
  details.method,details.formula{background:var(--card);border:1px solid var(--ln);border-radius:11px;margin:6px 0 0;padding:0}
  details.method summary,details.formula summary{padding:13px 16px;cursor:pointer;font-weight:600;list-style:none}
  details.method summary::-webkit-details-marker{display:none}
  details.method[open]{border-color:#37507e}
  .method ol{margin:0 18px 16px 34px;line-height:1.7}.method li{margin:4px 0}
  .method .cons{margin:0 16px 16px;padding:12px 14px;background:#12182a;border-radius:8px;font-size:12.5px;line-height:1.7}
  .method code{background:#0a0e17;padding:1px 5px;border-radius:4px;color:#bcd0ee;font-size:12px}
  .idle{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px}
  .idlec{background:#1a1622;border:1px solid #5a3a5a;border-radius:11px;padding:13px 15px}
  .idlec .bt{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:7px}
  .idle-tag{background:#3a2440;color:#e0a8e0;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px}
  .cfg2{margin-left:auto;color:var(--mut);font-size:11px}
  .why2{font-size:12.5px;line-height:1.55}.why2 b{color:#e0a8e0}
  .ctrls{display:flex;gap:8px;margin:14px 0 10px;flex-wrap:wrap}
  .ctrls button{background:var(--card);color:var(--tx);border:1px solid var(--ln);border-radius:7px;padding:7px 12px;font-size:12px;cursor:pointer}
  .ctrls button:hover{background:#212a3e;border-color:#37507e}
  .ctrls #flt{flex:1;min-width:180px;background:#0a0e17;color:var(--tx);border:1px solid var(--ln);border-radius:7px;padding:7px 12px;font-size:12px}
  .foot{color:var(--mut);font-size:12px;margin-top:30px;border-top:1px solid var(--ln);padding-top:16px;line-height:1.6}
</style></head><body><div class="wrap">
  <h1>Network rebalance — proposed plan</h1>
  <div class="sub">${totalAircraft.toLocaleString()} aircraft · ${r.hubs.length} hubs · ${changed.length} changed · ${stable.length} stable · ${starved.length} starved · best-match coverage maximiser — <b>report only, nothing sent to the game</b></div>
  <div class="banner">📡 Fresh data fetched <b>${esc(meta.fetchedAt)}</b> (${esc(meta.source)}). Review every move below; apply only after you approve. The rebalancer moves aircraft between hubs (<code>POST /aircraft/show/&lt;id&gt;/attribute</code>) and re-schedules each one with the existing optimiser — it never touches the live game in this mode.</div>

  <div class="cards">
    <div class="c big"><div class="k">Aircraft relocated</div><div class="v">${r.moves.length}<small> = ${fmt(idleDeployed)} idle deployed + ${workingMoved} working</small></div></div>
    <div class="c"><div class="k">Network utilisation</div><div class="v"><span class="u ${utilCls(r.before.fleetUtil)}">${pct0(r.before.fleetUtil)}</span><span class="ar">→</span><span class="u ${utilCls(r.after.fleetUtil)}">${pct0(r.after.fleetUtil)}</span></div></div>
    <div class="c"><div class="k">Eco demand covered</div><div class="v"><span class="u ${covCls(ecoB)}">${pct0(ecoB)}</span><span class="ar">→</span><span class="u ${covCls(ecoA)}">${pct0(ecoA)}</span></div></div>
    <div class="c"><div class="k">Idle aircraft</div><div class="v">${idleBefore}<span class="ar">→</span>${idleAfter}</div></div>
    <div class="c"><div class="k">Aircraft flying</div><div class="v">${r.before.flying}<span class="ar">→</span>${r.after.flying}</div></div>
    <div class="c"><div class="k">Served value index*</div><div class="v ${valDelta >= 0 ? "hi" : "lo"}">${valDelta >= 0 ? "+" : ""}${pct(valPct)}<small> rel.</small></div></div>
  </div>
  <div class="h2note">* Served-value is a RELATIVE index (the in-game price scale isn't calibrated, per the project notes), so treat it as a direction/magnitude of improvement, not euros. Seats, tons, utilisation and coverage are exact.</div>

  <div class="findings">
    <div class="fhead">🔑 Key findings</div>
    <ul>
      ${topHub ? `<li><b>Top hub ${esc(topHub.code)} maximised — eco <span class="${covCls(topHub.coverageAfterEco)}">${pct0(topHub.coverageBeforeEco)} → ${pct0(topHub.coverageAfterEco)}</span></b> by pulling in ${fmt(topHub.incoming.length)} aircraft. The fleet is concentrated on the most-route hubs in priority order; the fewest-route hubs${starvedCodes.length ? ` (${esc(starvedCodes.join(", "))})` : ""} are drained first to feed them and end empty — by design.</li>` : ""}
      <li><b>Freighters → cargo.</b> ${fmt(freightMoved)} freighters were relocated to the cargo-short hubs${topHub ? ` (e.g. ${esc(topHub.code)} cargo <b>${pct0(topCargoB)} → ${pct0(topCargoA)}</b>)` : ""}. Network cargo stays low (${pct0(cargoB)} → ${pct0(cargoA)}) because <b>${freighters.length} freighters can't cover ~8.7M t/week</b> — lifting it further needs BUYING freighters (buy planner: <code>report_SUMMARY.html</code>).</li>
      <li><b>⚠ Eco oversupply ≈ ${fmt(ecoOversupply)} seats/week</b> — this is the eco "burst". It's inherent to the game's scheduler, which keeps flying a route for the Business/Cargo profit even after its eco is full; pushing a hub to ~98% eco forces some half-empty eco legs. Business/First oversupply is ignored, as requested.</li>
      <li><b>Honest caveat on the network number (eco ${pct0(ecoB)} → ${pct0(ecoA)}):</b> most of that gain is from deploying your <b>${fmt(idleDeployed)} idle aircraft</b>. Pulling WORKING aircraft up to the top hubs mainly <i>concentrates</i> coverage — it's ~net-zero for total passengers (the top hubs rise, the donor/emptied hubs fall by about as much).</li>
    </ul>
  </div>

  <details class="method"><summary>📐 How this plan was built — strategy, order &amp; constraints (click to expand)</summary>
    <div class="method">
    <ol>
      <li><b>Goal = maximum demand coverage.</b> Fill as much of every route's demand as possible — Economy, Business, First AND Cargo — pushing every hub's routes toward 100%.</li>
      <li><b>Fresh data:</b> all hubs &amp; aircraft were fetched live just now — no cached state.</li>
      <li><b>Priority order = most routes first.</b> Hubs are filled in this order: ${r.hubs.map((h) => `${esc(h.code)} (${h.routeCount})`).join(" → ")}. The #1 hub is maximised first, then the LEFTOVER fleet cascades to the next, and so on.</li>
      <li><b>ECO is the objective.</b> Each hub is filled with PASSENGER aircraft to lift its Economy coverage as far as the fleet allows (Business/First are along for the ride — their oversupply is ignored, as requested).</li>
      <li><b>Bring aircraft in — fewest-route hubs first.</b> A hub pulls its OWN aircraft, then the IDLE surplus, then cannibalises WORKING aircraft from other hubs starting with the ones that have the FEWEST routes — so small hubs are drained to feed the big ones, and a large hub keeps its own fleet.</li>
      <li><b>Then freighters for cargo.</b> After the passenger fill, FREIGHTERS are added onto whatever cargo a hub still has uncovered.</li>
      <li><b>Each aircraft fills to the brim</b> via the existing optimiser (no "everything at 50%"); an aircraft that can't serve any demand profitably anywhere stays grounded (listed with its reason).</li>
      <li><b>Small / low-priority hubs may end with few or zero aircraft</b> — acceptable by design (they were drained to maximise the big hubs).</li>
    </ol>
    <div class="cons"><b>Constraints respected (reused verbatim from the live optimiser — "burst/EIS" honoured here):</b><br>
      • <b>Category / runway:</b> <code>line.category ≥ aircraft.category</code> — a big aircraft can't use a small airport (the game rejects the whole update otherwise).<br>
      • <b>Range:</b> <code>aircraft.range ≥ route.distance</code>.<br>
      • <b>Hub ownership:</b> after a move the aircraft only flies the destination hub's own routes.<br>
      • <b>900s granularity</b> and <b>anti-burst stagger</b> (per-aircraft phase offset) — departures spread across the 7 days, never all at once.<br>
      • <b>Break-even gate:</b> a round trip is scheduled only if its revenue-weighted load clears break-even — this is what keeps a hub from being handed eco/cargo capacity it can't fill (no "excessive Economy or Cargo").<br>
      • <b>Daily demand, both legs (2×):</b> demand is metered per day and a round trip counts both legs against it.
    </div>
    </div>
  </details>

  <h2>🗂 Hub-by-hub summary (processing order)</h2>
  <p class="h2note">Sorted by route count (descending) = the order each hub was optimised. "aircraft" = flying before → assigned after; arrows show before→after.</p>
  <table><thead><tr><th class="n">#</th><th>Hub</th><th class="n">routes</th><th>strategy</th><th class="n">aircraft</th><th class="n">util</th><th class="n">eco cov.</th><th class="n">moves</th><th>≥95%</th></tr></thead><tbody>${orderRows}</tbody></table>

  <h2>📊 Network coverage — before → after</h2>
  <p class="h2note">Demand met across the whole network, per class (per-day capped, both legs). Muted bar = current; colored bar = after rebalancing.</p>
  ${covBars}

  <h2>🏙 Hub details — strategy, reasoning, capacity &amp; every aircraft</h2>
  <p class="h2note">Click a hub to expand its full before/after breakdown, the aircraft that moved in/out, and the fleet based there after the plan.</p>
  <div class="ctrls">
    <button onclick="document.querySelectorAll('details.hub').forEach(d=>d.open=true)">▾ Expand all</button>
    <button onclick="document.querySelectorAll('details.hub').forEach(d=>d.open=false)">▸ Collapse all</button>
    <input id="flt" placeholder="filter hubs…" oninput="var q=this.value.toLowerCase();document.querySelectorAll('details.hub').forEach(d=>d.style.display=d.textContent.toLowerCase().includes(q)?'':'none')">
  </div>
  ${r.hubs.map(hubSection).join("")}

  <h2>🔀 Every proposed move (${r.moves.length})</h2>
  <p class="h2note">The complete list of aircraft that change hub. Source → destination, the config it carries, and its utilisation before (at the old hub) → after (at the new one).</p>
  ${r.moves.length ? `<table><thead><tr><th>Aircraft</th><th>Model</th><th>Move</th><th class="n">cat/range</th><th>Config</th><th class="n">util before→after</th><th>Now flies</th></tr></thead><tbody>${movesRows}</tbody></table>${movesExtra}` : `<div class="muted">No cross-hub moves were needed — every hub was best served by its own fleet.</div>`}

  <h2>💤 Idle after rebalancing (${r.idle.length}) — why each one stays grounded</h2>
  <p class="h2note">Aircraft the plan uses nowhere. Each group shows the reason and the constraint that prevented a useful assignment.</p>
  ${r.idle.length ? `<div class="idle">${idleCards}</div>` : `<div class="muted">Nothing idle — every aircraft is flying somewhere. 🎉</div>`}

  <div class="foot">
    <b>Expected improvement:</b> ${r.moves.length} aircraft relocated · ${activated} idle aircraft activated at home · network utilisation ${pct(r.before.fleetUtil)} → ${pct(r.after.fleetUtil)} · eco coverage ${pct(ecoB)} → ${pct(ecoA)} · idle ${idleBefore} → ${idleAfter}.${hubsBelowTarget.length ? ` ${hubsBelowTarget.length} optimised hub(s) finished below the 95% util target (${hubsBelowTarget.map((h) => esc(h.code)).join(", ")}) — usually the pyramid's last aircraft can't be fully filled by the remaining demand.` : " Every optimised hub reached the 95% utilisation target."}<br>
    Report generated in <b>report-only</b> mode — no hub change, reconfigure or planning update was sent. Apply is a separate, explicit step.
  </div>
</div></body></html>`;
}
