import { WEEK_SECONDS } from "./config.ts";
import { capacityOf, roundTripDuration } from "./model.ts";
import type { Aircraft, CabinClass, Line, ProposedFlight } from "./types.ts";

const CLASSES: CabinClass[] = ["eco", "bus", "first", "cargo"];
const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (n: number) => Math.round(n).toLocaleString("es-ES");
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Convierte segundos de la semana en "Lun 14:30". */
function dayTime(t: number): string {
  const d = Math.floor(t / 86400) % 7;
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${DAYS[d]} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function utilOf(durations: number[]): number {
  return Math.min(1, durations.reduce((s, d) => s + d, 0) / WEEK_SECONDS);
}

/**
 * Genera un HTML autocontenido para UN hub mostrando como quedaria el planning
 * con el reajuste: resumen, linea de tiempo semanal por avion (bloques de color
 * = rutas) y tabla de rutas (demanda vs oferta).
 */
export function buildHubHtml(
  hubCode: string,
  hubAircraft: Aircraft[],
  lines: Map<number, Line>,
  plansById: Map<number, ProposedFlight[]>,
): string {
  const hubLines = [...lines.values()].filter((l) => hubAircraft[0] && l.hubId === hubAircraft[0].hubId);

  // ── Oferta por ruta (del plan propuesto) ────────────────────────────────────
  const offered = new Map<number, Record<CabinClass, number>>();
  const flightsPerLine = new Map<number, number>();
  for (const a of hubAircraft) {
    const plan = plansById.get(a.id) ?? [];
    const cap = capacityOf(a);
    for (const f of plan) {
      const o = offered.get(f.lineId) ?? { eco: 0, bus: 0, first: 0, cargo: 0 };
      for (const c of CLASSES) o[c] += cap[c];
      offered.set(f.lineId, o);
      flightsPerLine.set(f.lineId, (flightsPerLine.get(f.lineId) ?? 0) + 1);
    }
  }

  // ── Utilizacion antes/despues ───────────────────────────────────────────────
  let beforeSum = 0,
    afterSum = 0,
    flying = 0;
  const rows = hubAircraft
    .map((a) => {
      const before = utilOf(a.planningList.map((p) => (lines.get(p.lineId) ? roundTripDuration(a, lines.get(p.lineId)!) : 0)));
      const plan = plansById.get(a.id) ?? [];
      const after = utilOf(plan.map((f) => (lines.get(f.lineId) ? roundTripDuration(a, lines.get(f.lineId)!) : 0)));
      beforeSum += before;
      afterSum += after;
      if (plan.length) flying++;
      return { a, before, after, plan };
    })
    .sort((x, y) => y.after - x.after);

  const before = hubAircraft.length ? beforeSum / hubAircraft.length : 0;
  const after = hubAircraft.length ? afterSum / hubAircraft.length : 0;
  const idleRows = rows.filter((r) => r.plan.length === 0);

  // ── Leyenda de rutas (color del juego) ──────────────────────────────────────
  const lineColor = new Map<number, string>();
  for (const l of hubLines) lineColor.set(l.id, l.color || "#999");

  // ── HTML ────────────────────────────────────────────────────────────────────
  // Cabecera de horas y lineas de hora (cada 3h) para la rejilla tipo el juego.
  const hourTicks = Array.from({ length: 9 }, (_, i) => i * 3)
    .map((h) => `<span class="hr" style="left:${(h / 24) * 100}%">${h}</span>`)
    .join("");
  const hourLines = Array.from({ length: 24 }, (_, h) => `<i style="left:${(h / 24) * 100}%"></i>`).join("");

  /** Rejilla semanal 7 dias x 24h de un avion (vuelos = bloques de color). */
  const weekGrid = (a: Aircraft, plan: ProposedFlight[]): string => {
    const dayRows = DAYS.map((dname, d) => {
      const dStart = d * 86400;
      const dEnd = dStart + 86400;
      const segs = plan
        .map((f) => {
          const line = lines.get(f.lineId);
          if (!line) return "";
          const dur = roundTripDuration(a, line);
          const s = f.takeOffTime;
          const e = s + dur;
          const os = Math.max(s, dStart);
          const oe = Math.min(e, dEnd);
          if (os >= oe) return "";
          const left = ((os - dStart) / 86400) * 100;
          const w = ((oe - os) / 86400) * 100;
          const label = s >= dStart && s < dEnd ? esc(line.name) : ""; // etiqueta solo el dia de salida
          return `<div class="seg" style="left:${left}%;width:${w}%;background:${lineColor.get(f.lineId) ?? "#999"}" title="${esc(line.name)} · ${dayTime(s)} → ${dayTime(e)} · ${(dur / 3600).toFixed(1)}h"><span>${label}</span></div>`;
        })
        .join("");
      return `<div class="drow"><span class="dl">${dname}</span><div class="dtrack">${hourLines}${segs}</div></div>`;
    }).join("");
    return `<div class="grid"><div class="ghead"><span class="dl"></span><div class="hticks">${hourTicks}</div></div>${dayRows}</div>`;
  };

  const timeline = rows
    .map(({ a, after, plan }) => {
      const routes = [...new Set(plan.map((f) => f.lineId))]
        .map((id) => `${esc(lines.get(id)?.name ?? String(id))}×${plan.filter((f) => f.lineId === id).length}`)
        .join(", ");
      const cls = after >= 0.99 ? "hi" : after >= 0.9 ? "mid" : "lo";
      return `<details class="acd">
        <summary>
          <span class="nm"><b>${esc(a.name)}</b> <i>${esc(a.aircraftListName)}</i></span>
          <span class="su ${cls}">${plan.length ? pct(after) : "—"}</span>
          <span class="rs">${esc(routes) || "sin usar"}</span>
        </summary>
        ${weekGrid(a, plan)}
      </details>`;
    })
    .join("");

  const routeRows = hubLines
    .map((l) => {
      const o = offered.get(l.id) ?? { eco: 0, bus: 0, first: 0, cargo: 0 };
      const cell = (c: CabinClass) => {
        const d = l.weeklyDemand[c];
        const diff = o[c] - d;
        const cls = diff > 0 ? "over" : "under";
        return `<td class="${cls}"><b>${fmt(o[c])}</b> / ${fmt(d)}<span class="d">${diff >= 0 ? "+" : ""}${fmt(diff)}</span></td>`;
      };
      return `<tr>
        <td><span class="dot" style="background:${l.color || "#999"}"></span>${esc(l.name)}</td>
        <td class="n">${fmt(l.distance)}</td>
        <td class="n">${flightsPerLine.get(l.id) ?? 0}</td>
        ${cell("eco")}${cell("bus")}${cell("first")}${cell("cargo")}
      </tr>`;
    })
    .join("");

  const flights = [...flightsPerLine.values()].reduce((s, n) => s + n, 0);

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Planning ${esc(hubCode)} — reajuste</title>
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
  /* lista colapsable de aviones con rejilla semanal */
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
  .rs{color:var(--mut);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .grid{padding:9px 14px 12px;border-top:1px solid var(--ln);background:#11182680}
  .ghead,.drow{display:flex;align-items:center;gap:8px;height:21px}
  .dl{width:30px;color:var(--mut);font-size:11px;flex:none;text-align:right}
  .hticks{position:relative;flex:1;height:13px}
  .hticks .hr{position:absolute;font-size:9px;color:#46527a;transform:translateX(-50%)}
  .dtrack{position:relative;flex:1;height:18px;background:#0a0e17;border-radius:3px;border:1px solid var(--ln)}
  .dtrack>i{position:absolute;top:0;height:100%;border-left:1px solid #161d30}
  .seg{position:absolute;top:1px;height:16px;border-radius:2px;overflow:hidden;display:flex;align-items:center;box-shadow:0 0 0 1px #0006 inset}
  .seg span{font-size:9px;color:#10151f;font-weight:700;padding:0 4px;white-space:nowrap}
  td.over{color:var(--lo)}td.under{color:var(--mut)}
  td.over .d,td.under .d{display:block;font-size:10px}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .note{color:var(--mut);font-size:12px;margin-top:8px}
  .ctrls{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
  .ctrls button{background:var(--card);color:var(--tx);border:1px solid var(--ln);border-radius:7px;padding:7px 12px;font-size:12px;cursor:pointer}
  .ctrls button:hover{background:#212a3e;border-color:#37507e}
  .ctrls #flt{flex:1;min-width:180px;background:#0a0e17;color:var(--tx);border:1px solid var(--ln);border-radius:7px;padding:7px 12px;font-size:12px}
</style></head><body><div class="wrap">
  <h1>Planning ${esc(hubCode)} — cómo quedaría con el reajuste</h1>
  <div class="sub">${hubAircraft.length} aviones · ${hubLines.length} rutas · ${fmt(flights)} vuelos/semana · NO se ha enviado ningún cambio al juego</div>

  <div class="cards">
    <div class="c"><div class="k">Utilización media</div><div class="v">${pct(after)} <small>antes ${pct(before)}</small></div></div>
    <div class="c"><div class="k">Aviones volando</div><div class="v">${flying}<small> / ${hubAircraft.length}</small></div></div>
    <div class="c"><div class="k">Aviones sin usar</div><div class="v ${idleRows.length ? "warn" : ""}">${idleRows.length}</div></div>
    <div class="c"><div class="k">Vuelos / semana</div><div class="v">${fmt(flights)}</div></div>
  </div>

  ${
    idleRows.length
      ? `<h2>Aviones sin usar (${idleRows.length}) — sin vuelo rentable disponible (deja el slot libre)</h2>
  <table><thead><tr><th>Avión</th><th>Modelo</th><th class="n">Alcance km</th><th class="n">Eco/Bus/Fst</th><th class="n">Carga t</th></tr></thead><tbody>
  ${idleRows
    .map(
      ({ a }) =>
        `<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.aircraftListName)}</td><td class="n">${fmt(a.range)}</td><td class="n">${a.seatsEco}/${a.seatsBus}/${a.seatsFirst}</td><td class="n">${a.payloadUsed}</td></tr>`,
    )
    .join("")}
  </tbody></table>`
      : ""
  }

  <h2>Planning semanal por avión — clic para desplegar la rejilla (Lun→Dom × 0-23h)</h2>
  <div class="note" style="margin-bottom:10px">Cada fila es un avión (colapsada). Al desplegar ves su semana día por día; cada bloque de color es un vuelo (color = ruta del juego), posicionado por su hora de salida y duración.</div>
  <div class="ctrls">
    <button onclick="document.querySelectorAll('.acd').forEach(d=>d.open=true)">▾ Desplegar todos</button>
    <button onclick="document.querySelectorAll('.acd').forEach(d=>d.open=false)">▸ Colapsar todos</button>
    <input id="flt" placeholder="filtrar por avión o ruta…" oninput="var q=this.value.toLowerCase();document.querySelectorAll('.acd').forEach(d=>d.style.display=d.textContent.toLowerCase().includes(q)?'':'none')">
  </div>
  <div class="aclist">${timeline}</div>

  <h2>Rutas — oferta / demanda semanal (verde = bajo demanda, rojo = sobreoferta)</h2>
  <table>
    <thead><tr><th>Ruta</th><th class="n">km</th><th class="n">vuelos</th><th>Eco</th><th>Business</th><th>First</th><th>Carga (t)</th></tr></thead>
    <tbody>${routeRows}</tbody>
  </table>
  <div class="note">Cada celda: <b>ofertado</b> / demanda semanal, y la diferencia (+ = sobreoferta).</div>
</div></body></html>`;
}
