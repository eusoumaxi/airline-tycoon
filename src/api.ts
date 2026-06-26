import { BASE_URL, COOKIE, USER_AGENT } from "./config.ts";
import type { BuyableRoute } from "./recommend.ts";
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
  // An empty `added` CLEARS the aircraft's planning (body without the `added` key,
  // matching the game's "clear" request) — used to truly idle a surplus aircraft.
  const planningData =
    plan.added.length > 0
      ? JSON.stringify({ aircraftId: plan.aircraftId, added: plan.added })
      : JSON.stringify({ aircraftId: plan.aircraftId });
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

// ───────────────────────────────────────────────────────────────────────────
// BUY ROUTE — read the buyable routes of a hub and (optionally) purchase one.
//   list    GET  /network/newline/<hubLoadId>/<country>          (HTML)
//   confirm GET  /network/newlinefinalize/<hubLoadId>/<destCode> (HTML, has token)
//   buy     POST /network/newlinefinalize/<hubLoadId>/<destCode> (form[_token]=…)
// ───────────────────────────────────────────────────────────────────────────

/** Parse the buyable-route boxes out of a /network/newline HTML page. */
export function parseBuyableRoutes(html: string, country: string): BuyableRoute[] {
  const out: BuyableRoute[] = [];
  // Each candidate is a <div class="hubListBox" …> block; split on its opening tag.
  const blocks = html.split(/(?=<div class="hubListBox")/);
  for (const b of blocks) {
    if (!b.startsWith('<div class="hubListBox"')) continue;
    const name = /data-name="([^"]*)"/.exec(b)?.[1] ?? "";
    const price = Number(/data-price="(\d+)"/.exec(b)?.[1] ?? 0);
    const dist = Number(/data-distance="(\d+)"/.exec(b)?.[1] ?? 0);
    const cat = Number(/data-category="(\d+)"/.exec(b)?.[1] ?? 0);
    const audit = /data-audit="([^"]*)"/.exec(b)?.[1] ?? "0";
    const auditPrice = Number(/data-auditprice="(\d+)"/.exec(b)?.[1] ?? 0);
    const code = /newlinefinalize\/\d+\/([a-z0-9]+)"/.exec(b)?.[1];
    const iata = /\n\s*([A-Z]{3})\s*-\s*\n\s*<i>/.exec(b)?.[1] ?? code?.toUpperCase() ?? "";
    const demandPct = Number(/barDemandFill"\s+style="width:\s*([\d.]+)%/.exec(b)?.[1] ?? 0);
    if (!code) continue;
    out.push({ code, iata, name: name.trim(), country, cat, dist, price, auditPrice, audited: audit !== "0", demandPct });
  }
  return out;
}

/** Download and parse the routes a hub can buy toward a given country (2-letter code). */
export async function fetchBuyableRoutes(hubLoadId: number, country: string): Promise<BuyableRoute[]> {
  const url = `${BASE_URL}/network/newline/${hubLoadId}/${country}`;
  const res = await fetch(url, { headers: pageHeaders() });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (cookie expired?)`);
  return parseBuyableRoutes(await res.text(), country);
}

/** Extract the CSRF token (form[_token]) from the route-finalize confirm page. */
export async function fetchBuyToken(hubLoadId: number, destCode: string): Promise<string> {
  const url = `${BASE_URL}/network/newlinefinalize/${hubLoadId}/${destCode}`;
  const res = await fetch(url, { headers: pageHeaders() });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (cookie expired?)`);
  const html = await res.text();
  const token = /name="form\[_token\]"\s+value="([^"]+)"/.exec(html)?.[1] ?? /form%5B_token%5D=([^"&']+)/.exec(html)?.[1];
  if (!token) throw new Error(`No form[_token] found on ${url} (route may already be owned, or layout changed)`);
  return token;
}

/** Finalize (PURCHASE) a route. Spends in-game money — call only when the user confirms. */
export async function buyRoute(hubLoadId: number, destCode: string): Promise<string> {
  const token = await fetchBuyToken(hubLoadId, destCode);
  const url = `${BASE_URL}/network/newlinefinalize/${hubLoadId}/${destCode}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...pageHeaders(),
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      referer: url,
      "sec-fetch-site": "same-origin",
    },
    body: `form%5B_token%5D=${encodeURIComponent(token)}`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${res.statusText}`);
  // Success usually redirects to the network map; an error keeps the form / shows a message.
  if (/erreur|error|no se|insufficient|insuffisant|solde/i.test(text.slice(0, 500))) {
    throw new Error(`Purchase rejected: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return "ok";
}

/**
 * SELL (close) a route by its line id. GET the sell form for its CSRF token, then POST to
 * confirm. IRREVERSIBLE (re-buying costs money + audit). Throws "NO_TOKEN" when the page has
 * no sell form (wrong/stale line id, or the route is already gone) — so a bad id never POSTs.
 */
export async function sellLine(lineId: number): Promise<string> {
  const url = `${BASE_URL}/network/showline/${lineId}/sell`;
  const ref = `${BASE_URL}/network/showline/${lineId}`;
  const getRes = await fetch(url, { headers: { ...listHeaders(), referer: ref } });
  if (!getRes.ok) throw new Error(`GET sell -> ${getRes.status}`);
  const token = /name="form\[_token\]"\s+value="([^"]+)"/.exec(await getRes.text())?.[1];
  if (!token) throw new Error("NO_TOKEN");
  const res = await fetch(url, {
    method: "POST",
    headers: { ...listHeaders(), "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: BASE_URL, referer: ref },
    body: `form%5B_token%5D=${encodeURIComponent(token)}`,
  });
  if (!res.ok) throw new Error(`POST sell -> ${res.status} ${res.statusText}`);
  return (await res.text()).replace(/\s+/g, " ").slice(0, 200);
}
