// ───────────────────────────────────────────────────────────────────────────
// Shared helper to MOVE an aircraft to another hub in the game — replicating the
// EXACT browser navigation flow the player uses:
//   GET  /aircraft/show/<id>/attribute            (document nav, no content-type/origin)
//        → the form page with form[_token]  (if on the ground)
//   POST /aircraft/show/<id>/attribute            hubId=<destLoadId>&form[_token]=…
// An aircraft can ONLY change hub when NOT in flight: in flight the GET returns the big
// fleet-list page with no token (→ NOT_AVAILABLE; retry once landed). The body hubId is the
// destination hub's LOAD id (e.g. 8817303 for HKG). A move OK = 200; rejected = 302→/aircraft.
// ───────────────────────────────────────────────────────────────────────────

import { BASE_URL, COOKIE, USER_AGENT } from "./config.ts";

/** Headers for the GET — a plain browser NAVIGATION (document), NOT ajax: no content-type,
 *  no origin, no x-requested-with. Sending those made the server return the wrong page. */
function getHeaders(aircraftId: number): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "es,en-US;q=0.9,en;q=0.8,ru;q=0.7,fr;q=0.6,pt;q=0.5",
    cookie: COOKIE,
    priority: "u=0, i",
    referer: `${BASE_URL}/aircraft/show/${aircraftId}`,
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": USER_AGENT,
  };
}

/** Headers for the POST — same navigation request PLUS the form content-type + origin. */
function postHeaders(aircraftId: number): Record<string, string> {
  return {
    ...getHeaders(aircraftId),
    "cache-control": "max-age=0",
    "content-type": "application/x-www-form-urlencoded",
    origin: BASE_URL,
    referer: `${BASE_URL}/aircraft/show/${aircraftId}/attribute`,
  };
}

/** Fetch the hub-change CSRF token. Throws "NOT_AVAILABLE" when the form isn't on the
 *  page (the aircraft can't change hub right now — usually because it's in flight). */
async function fetchAttributeToken(aircraftId: number): Promise<string> {
  const res = await fetch(`${BASE_URL}/aircraft/show/${aircraftId}/attribute`, { headers: getHeaders(aircraftId) });
  if (!res.ok) throw new Error(`GET attribute -> ${res.status} (cookie expired?)`);
  const token = /name="form\[_token\]"\s+value="([^"]+)"/.exec(await res.text())?.[1];
  if (!token) throw new Error("NOT_AVAILABLE"); // no hub-change form right now (in flight)
  return token;
}

/** Move an aircraft to another hub. `destLoadId` = the hub LOAD id. A successful move
 *  returns 200; a rejected one 302-redirects (stale session / in flight / no funds). */
export async function moveAircraftHub(aircraftId: number, destLoadId: number): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = await fetchAttributeToken(aircraftId);
      const res = await fetch(`${BASE_URL}/aircraft/show/${aircraftId}/attribute`, {
        method: "POST",
        redirect: "manual",
        headers: postHeaders(aircraftId),
        body: `hubId=${destLoadId}&form%5B_token%5D=${encodeURIComponent(token)}`,
      });
      if (res.status >= 300 && res.status < 400) throw new Error(`REJECTED (redirect ${res.headers.get("location") ?? "?"}) — session/funds/in-flight`);
      if (!res.ok) throw new Error(`POST attribute -> ${res.status}`);
      const text = await res.text();
      if (/erreur|error|no se|insufficient|insuffisant|solde/i.test(text.slice(0, 600))) throw new Error(`rejected: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
      return; // 200 = applied
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && e.message === "NOT_AVAILABLE") throw e; // in flight: retrying now won't help
      await Bun.sleep(800);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("move failed");
}
