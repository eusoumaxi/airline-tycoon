/**
 * @fileoverview Relocate one aircraft to another hub (browser form + CSRF token).
 *
 * GET `/aircraft/show/<id>/attribute` for `form[_token]`, then POST `hubId=<destLoadId>`.
 * Throws `NOT_AVAILABLE` when the plane is in flight (no token on the page).
 */
import { BASE_URL, requireCookie, USER_AGENT } from "./config.ts";

/** Document GET — no AJAX headers; those return the fleet list instead of the form. */
function getHeaders(aircraftId: number): Record<string, string> {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "en-US,en;q=0.9",
    cookie: requireCookie(),
    priority: "u=0, i",
    referer: `${BASE_URL}/aircraft/show/${aircraftId}`,
    "sec-ch-ua":
      '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
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

/** Form POST: same as GET plus `content-type` and `origin`. */
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
  const res = await fetch(`${BASE_URL}/aircraft/show/${aircraftId}/attribute`, {
    headers: getHeaders(aircraftId),
  });
  if (!res.ok) {
    throw new Error(`GET attribute -> ${res.status} (cookie expired?)`);
  }
  const token = /name="form\[_token\]"\s+value="([^"]+)"/.exec(
    await res.text()
  )?.[1];
  if (!token) {
    throw new Error("NOT_AVAILABLE"); // no hub-change form right now (in flight)
  }
  return token;
}

/**
 * Relocate one aircraft. `destLoadId` is the destination hub's **load** id.
 *
 * Success is HTTP 200. Redirects mean rejected (in flight, funds, or session).
 * Throws `NOT_AVAILABLE` when the attribute form has no CSRF token (in flight).
 */
export async function moveAircraftHub(
  aircraftId: number,
  destLoadId: number
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = await fetchAttributeToken(aircraftId);
      const res = await fetch(
        `${BASE_URL}/aircraft/show/${aircraftId}/attribute`,
        {
          body: `hubId=${destLoadId}&form%5B_token%5D=${encodeURIComponent(token)}`,
          headers: postHeaders(aircraftId),
          method: "POST",
          redirect: "manual",
        }
      );
      if (res.status >= 300 && res.status < 400) {
        throw new Error(
          `REJECTED (redirect ${res.headers.get("location") ?? "?"}) — session/funds/in-flight`
        );
      }
      if (!res.ok) {
        throw new Error(`POST attribute -> ${res.status}`);
      }
      const text = await res.text();
      if (
        /erreur|error|no se|insufficient|insuffisant|solde/i.test(
          text.slice(0, 600)
        )
      ) {
        throw new Error(`rejected: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
      }
      return; // 200 = applied
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && e.message === "NOT_AVAILABLE") {
        throw e; // in flight: retrying now won't help
      }
      await Bun.sleep(800);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("move failed");
}
