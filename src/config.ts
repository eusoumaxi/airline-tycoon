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
export const MIN_DELAY_MS = 1_000; // 1 s
export const MAX_DELAY_MS = 1_000; // 1 s

// ───────────────────────────────────────────────────────────────────────────
// Game mechanics (calibrated from the real data)
// ───────────────────────────────────────────────────────────────────────────

/** Seconds in one planning week. */
export const WEEK_SECONDS = 604800;

/** Days in a planning week. Demand (`paxAtt*`) is DAILY and regenerates each day. */
export const DAYS_PER_WEEK = 7;

/** Seconds in one day. The game meters demand PER DAY (Mon..Sun), so the optimizer
 *  tracks 7 daily demand pools and assigns every flight a departure day. */
export const DAY_SECONDS = 86400;

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

// ── Profit model: real break-even (revenue − cost) ───────────────────────────
// A flight's cost (fuel + WEAR/maintenance + fees) is almost FIXED — it barely
// depends on how full the plane is (a 747-8F freighter flying 0 pax still costs
// money). Verified in the player's own accounting:
//   · A380  full long-haul: revenue €4.29M, cost €0.66M  -> cost ≈ 15% of revenue
//   · 747-8F freighter (0 pax): revenue €1.96M, cost €0.73M -> cost ≈ 37%
// So a flight breaks even at ~that load factor: below it the (fixed) cost eats
// the revenue and the flight LOSES money. The optimizer therefore flies a round
// trip only if its REVENUE-WEIGHTED load (across ALL classes — eco that goes
// half-empty is subsidised by business/first/cargo) clears the break-even; else
// it leaves the aircraft idle (better idle than a money-losing flight, and less
// wear). Raise these to fly fewer / fuller flights (protect the fleet); lower to
// fly more. These are scale-free ratios, so they don't depend on price tuning.

/** Break-even load (revenue-weighted) for a PASSENGER aircraft. From accounting ≈0.15. */
export const BREAK_EVEN_LOAD = 0.15;

/** Break-even load for a CARGO aircraft (freighter) — higher cost share. ≈0.37. */
export const BREAK_EVEN_LOAD_CARGO = 0.37;

/** Number of TIGHTEN passes (grow-swap + gap-fill) that push toward more profit. */
export const TIGHTEN_ROUNDS = 4;

/** Do not move rental aircraft (they often have a fixed configuration). */
export const SKIP_RENTALS = false;
