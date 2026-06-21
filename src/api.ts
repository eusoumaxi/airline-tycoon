import { BASE_URL, COOKIE, USER_AGENT } from "./config.ts";
import type { AircraftPlan, Hub, PlanningPayload } from "./types.ts";

/** Headers para pedir una pagina HTML (como navegacion del navegador). */
function pageHeaders(): Record<string, string> {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "es,en-US;q=0.9,en;q=0.8,ru;q=0.7,fr;q=0.6,pt;q=0.5",
    cookie: COOKIE,
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": USER_AGENT,
  };
}

/**
 * Descubre todos los hubs del jugador leyendo la pagina /network/planning.
 * Cada hub aparece como `data-hubId="<loadId>"` junto a su codigo y airportId,
 * p.ej. `... BOG / 156`. Devuelve [{loadId, code, airportId}].
 */
export async function discoverHubs(): Promise<Hub[]> {
  const url = `${BASE_URL}/network/planning`;
  const res = await fetch(url, { headers: pageHeaders() });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (¿cookie caducada?)`);
  const html = await res.text();

  const hubs: Hub[] = [];
  const seen = new Set<number>();
  // <span ... data-airportid="156" data-hubId="9572489"> BOG / <img...>
  const re = /data-airportid="(\d+)"\s+data-hubId="(\d+)">\s*([A-Z]{3})/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const loadId = Number(m[2]);
    if (seen.has(loadId)) continue;
    seen.add(loadId);
    hubs.push({ loadId, code: m[3], airportId: Number(m[1]) });
  }
  return hubs;
}

/** Headers que replican EXACTAMENTE el curl del list (incluye el User-Agent tal cual). */
function listHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "es,en-US;q=0.9,en;q=0.8,ru;q=0.7,fr;q=0.6,pt;q=0.5",
    cookie: COOKIE,
    priority: "u=1, i",
    referer: `${BASE_URL}/network/planning`,
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": USER_AGENT,
    "x-requested-with": "XMLHttpRequest",
  };
}

/** Descarga el planning de un hub (endpoint `list` del curl). */
export async function fetchPlanning(planningId: number): Promise<PlanningPayload> {
  const url = `${BASE_URL}/network/planning/load/${planningId}`;
  const res = await fetch(url, { headers: listHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET ${url} -> ${res.status} ${res.statusText}. ` +
        `Probablemente la cookie caduco; actualiza COOKIE en src/config.ts.\n${body.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as PlanningPayload;
  if (!data?.aircraftDataArray || !data?.lineDataArray) {
    throw new Error(`Respuesta inesperada de ${url}: faltan aircraftDataArray/lineDataArray`);
  }
  return data;
}

/** Descarga y fusiona varios hubs en un unico payload. */
export async function fetchAllPlannings(planningIds: number[]): Promise<PlanningPayload[]> {
  return Promise.all(planningIds.map(fetchPlanning));
}

// ───────────────────────────────────────────────────────────────────────────
// UPDATE — implementado pero NO se llama (el usuario pidio solo el algoritmo).
// Cuando quieras aplicar el plan, llama a esta funcion. Necesita la cookie viva.
// ───────────────────────────────────────────────────────────────────────────
export async function updatePlanning(plan: AircraftPlan): Promise<unknown> {
  const url = `${BASE_URL}/network/planning/0/ajax`;
  const planningData = JSON.stringify({ aircraftId: plan.aircraftId, added: plan.added });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...listHeaders(),
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: BASE_URL,
    },
    body: `planningData=${encodeURIComponent(planningData)}`,
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${res.statusText}`);
  return res.json().catch(() => ({}));
}
