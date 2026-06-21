import { BASE_URL, COOKIE, USER_AGENT } from "./config.ts";
import type { AircraftPlan, Hub, PlanningPayload } from "./types.ts";

/** Headers for an HTML page request (like a normal browser navigation). */
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

/** Headers that EXACTLY replicate the `list` curl (incl. the User-Agent as-is). */
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

/**
 * Discover all the player's hubs by reading /network/planning. Each hub appears
 * as `data-airportid="156" data-hubId="9572489"> BOG / <img...>`.
 * Returns [{loadId, code, airportId}].
 */
export async function discoverHubs(): Promise<Hub[]> {
  const url = `${BASE_URL}/network/planning`;
  const res = await fetch(url, { headers: pageHeaders() });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (cookie expired?)`);
  const html = await res.text();

  const hubs: Hub[] = [];
  const seen = new Set<number>();
  const re = /data-airportid="(\d+)"\s+data-hubId="(\d+)">\s*([A-Z]{3})/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const loadId = Number(m[2]);
    if (seen.has(loadId)) continue;
    seen.add(loadId);
    hubs.push({ loadId, code: m[3], airportId: Number(m[1]) });
  }
  return hubs;
}

/** Download one hub's planning (the `list` endpoint from the curl). */
export async function fetchPlanning(planningId: number): Promise<PlanningPayload> {
  const url = `${BASE_URL}/network/planning/load/${planningId}`;
  const res = await fetch(url, { headers: listHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET ${url} -> ${res.status} ${res.statusText}. ` +
        `The cookie probably expired; update COOKIE in src/config.ts.\n${body.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as PlanningPayload;
  if (!data?.aircraftDataArray || !data?.lineDataArray) {
    throw new Error(`Unexpected response from ${url}: missing aircraftDataArray/lineDataArray`);
  }
  return data;
}

/** Download and return several hubs' planning. */
export async function fetchAllPlannings(planningIds: number[]): Promise<PlanningPayload[]> {
  return Promise.all(planningIds.map(fetchPlanning));
}

// ───────────────────────────────────────────────────────────────────────────
// UPDATE — pushes one aircraft's weekly planning to the game. Used by apply.ts.
// One POST per aircraft, body = planningData={"aircraftId":X,"added":[...]}.
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

  // The game returns {"result":true,"message":"..."} on success, or a plain-text
  // error ("Su planning no se añadió a causa del error siguiente: ...") on
  // rejection — even with HTTP 200. Detect both so a rejection is a real failure.
  const text = await res.text();
  let ok: boolean;
  let message = text.trim();
  try {
    const j = JSON.parse(text);
    ok = j?.result === true;
    if (j?.message) message = j.message;
  } catch {
    ok = !/no se a|n'a pas|error|granularit|piste|d[eé]coller/i.test(text);
  }
  if (!ok) throw new Error(message.slice(0, 220));
  return message;
}
