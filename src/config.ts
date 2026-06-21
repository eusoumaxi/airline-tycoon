// ───────────────────────────────────────────────────────────────────────────
// Configuration. Edit your cookie/credentials and the model parameters here.
// ───────────────────────────────────────────────────────────────────────────

export const BASE_URL = "https://tycoon.airlines-manager.com";

/**
 * If true, discover ALL your hubs by reading /network/planning (recommended).
 * Each aircraft is automatically restricted to the routes of ITS own hub.
 * If false, the PLANNING_IDS below are used instead.
 */
export const AUTO_DISCOVER_HUBS = true;

/**
 * Planning IDs to load (one per hub) when AUTO_DISCOVER_HUBS = false.
 * The number in /network/planning/load/<id> (= data-hubId).
 * Your hubs: ADD 9357042 · BOG 9572489 · DXB 3858219 · GRU 17462623 ·
 *            HKG 8817303 · JFK 4745504 · LAX 4305752 · MIA 4122142
 */
export const PLANNING_IDS = [9572489];

/** EXACT User-Agent from the curl (do not change: the game validates it). */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * Session cookie. Paste the `-b '...'` value from the curl here when it expires.
 * REMEMBERME + PHPSESSID are what authenticate you; AWSALB rotates on its own.
 */
export const COOKIE =
  "REMEMBERME=Am.GameBundle.Entity.Player%3AZGF2aWRtYXhpbWlsaWFub2xhcmFAZ21haWwuY29t%3A1813540149%3A5_bC4xxNLHKJqqonMg9NPyv2k3Ps0DA5GAzkNjuXKe0~_iVMxwVlDK2RKU6CaDRqc10vC4D2fgz5joB6YspV75U~; PHPSESSID=4rfcb31qiq79blfd60qtvsal7r";

// ───────────────────────────────────────────────────────────────────────────
// Apply / update (used by `bun run apply`)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hubs that `apply` will push to the game by default (codes). For now only GRU.
 * Override on the CLI with `--hub <CODE>`. Re-running apply = a full reload
 * (re-fetch + re-optimize + push) — handy after you buy new routes/aircraft.
 */
export const APPLY_HUBS = ["GRU"];

/** Random delay between each aircraft update (ms). Looks human, avoids rate limits. */
export const MIN_DELAY_MS = 5_000; // 5 s
export const MAX_DELAY_MS = 10_000; // 10 s

// ───────────────────────────────────────────────────────────────────────────
// Game mechanics (calibrated from the real data)
// ───────────────────────────────────────────────────────────────────────────

/** Seconds in one planning week. */
export const WEEK_SECONDS = 604800;

/** Default turnaround (s) when it can't be inferred from the aircraft. ~7600 measured. */
export const DEFAULT_TURNAROUND = 7600;

/**
 * Planning time granularity (s). The game requires every takeOffTime to be a
 * multiple of this (15 min) — otherwise the whole update is rejected
 * ("ne respecte pas la granularité du planning, TakeOffTime % 900 != 0").
 */
export const TIME_GRANULARITY = 900;

// ───────────────────────────────────────────────────────────────────────────
// Economic model parameters — TUNE to the game's audit.
// The optimizer is robust to scale: these weights set the RELATIVE value order
// between classes and routes, which is what drives the assignment.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Period of the `paxAtt*` demand. CONFIRMED: it is DAILY demand (the game's
 * "REMAINING DEMAND" table shows it per day, Mon..Sun, matching paxAtt*).
 * So weekly demand = paxAtt * 7.
 */
export const DEMAND_DAYS = 7;

/**
 * Estimated price per seat (one-way) = base + perKm * distanceKm.
 * Rough Airlines-Manager-style values (First > Bus > Eco).
 * Cargo: price per ton (one-way).
 */
export const PRICING = {
  eco: { base: 35, perKm: 0.2 },
  bus: { base: 60, perKm: 0.4 },
  first: { base: 90, perKm: 0.6 },
  cargo: { base: 40, perKm: 0.25 }, // per ton
} as const;

/** A round trip is outbound+inbound: both legs earn revenue. */
export const LEGS_PER_ROUNDTRIP = 2;

// ── Profit model (revenue − cost) ───────────────────────────────────────────
// Flying empty seats LOSES money (fuel). So a flight's value is its PROFIT:
// revenue from the REAL demand it fills minus the flight cost. If that is <= 0
// (a near-empty flight) it is NOT scheduled -> the slot is left free. This caps
// oversupply on its own (once demand runs out, extra flights stop being
// profitable) and avoids losing money on routes with no need for it.

/**
 * Flight cost per km and per leg (fuel+fees), in the same units as PRICING.
 * flight_cost = COST_PER_KM * distance * 2 (round trip). Calibrated so a flight
 * that would only carry belly cargo (empty seats) comes out negative and is NOT
 * flown, while one that serves real demand is. Raise it to demand higher loads
 * (more free slots); lower it to fly more.
 */
export const COST_PER_KM = 10;

/**
 * Small safeguard: a flight is only considered if it fills at least this
 * fraction of its pax capacity with real demand (avoids micro-flights serving
 * just a couple of pax). The profit term already does almost all the work.
 */
export const MIN_FILL = 0;

/** Number of TIGHTEN passes (grow-swap + gap-fill) that push toward more profit. */
export const TIGHTEN_ROUNDS = 4;

/** Do not move rental aircraft (they often have a fixed configuration). */
export const SKIP_RENTALS = false;
