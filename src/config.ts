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
  "REMEMBERME=Am.GameBundle.Entity.Player%3AZGF2aWRtYXhpbWlsaWFub2xhcmFAZ21haWwuY29t%3A1813725321%3Ajo-Myzsbq8GruJkDpj53o_Qs_iwVMfO1m9ZishMQ3HI~_iVMxwVlDK2RKU6CaDRqc10vC4D2fgz5joB6YspV75U~; PHPSESSID=mqahdlgf4j7l1rhqi1bmk6e0va";

// ───────────────────────────────────────────────────────────────────────────
// Apply / update (used by `bun run apply`)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hubs that `apply` will push to the game by default (codes). For now only GRU.
 * Override on the CLI with `--hub <CODE>`. Re-running apply = a full reload
 * (re-fetch + re-optimize + push) — handy after you buy new routes/aircraft.
 */
export const APPLY_HUBS = ["GRU"];

/** DEPRECATED — apply.ts no longer delays between updates: it fires `--concurrency`
 *  requests at once (default 100) with NO interval. Kept only for reference. */
export const MIN_DELAY_MS = 0;
export const MAX_DELAY_MS = 0;

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

/** Break-even load (revenue-weighted) for a PASSENGER aircraft. From accounting ≈0.15.
 *  NOTE: break-even is NO LONGER an optimisation gate — the objective is eco coverage
 *  (see ECO_TARGET). It is kept only to compute the reporting-only profit figure. */
export const BREAK_EVEN_LOAD = 0.15;

/** Break-even load for a CARGO aircraft (freighter) — higher cost share. ≈0.37. */
export const BREAK_EVEN_LOAD_CARGO = 0.37;

/**
 * ECO COVERAGE TARGET — now a REPORTING KPI only (no longer an optimisation gate).
 * The reports show "routes ≥ this fraction of eco served" as a quality marker. The
 * optimizer used to STOP serving a route at this fraction to cap the eco "burst", but
 * the player reversed that ("la idea es full llénalo"): routes are now filled to the
 * brim and the only hard rule is the per-day overshoot cap below. See `ECO_OVERSHOOT_CAP`.
 */
export const ECO_TARGET = 0.98;

/**
 * MAX ECO OVERSHOOT per route per DAY (seats). THE player's one hard rule:
 *   "lo único que debe evitar es que alguna ruta tenga más de −1500 eco por día."
 * Filling is greedy on eco coverage: an aircraft keeps taking a route while that route
 * still has POSITIVE eco demand left that day, and the flight that crosses zero is allowed
 * to overshoot the demand (coarse seats → the game shows the day's remaining go negative).
 * This cap bounds that overshoot: a flight is SKIPPED if it would drive the route+day's eco
 * below −CAP (i.e. would push the day's eco oversupply above CAP) — that means the aircraft
 * is too big for this route's residual, so it's left for a route where it fits. Once a route's
 * eco for the day is exhausted the aircraft moves to ANOTHER route still with eco that day.
 * This REPLACES the old ECO_TARGET=98% stop: we now serve to 100%+ (bounded overshoot) instead
 * of stopping 2% short. Raise for fuller planes + more burst; lower to cut oversupply waste.
 */
export const ECO_OVERSHOOT_CAP = 1500;

/**
 * MAX CARGO OVERSHOOT per route per DAY (tons) for FREIGHTERS — the cargo analogue of
 * `ECO_OVERSHOOT_CAP` (the player: "haz lo mismo para los aviones de cargo… llena el máximo
 * avión posible"). Generous by default so a freighter always gets to fill a route's cargo to
 * the brim; it only guards against dropping a big freighter onto a route with a tiny cargo
 * residual. Lower it to cap freighter oversupply more aggressively (like eco). (Passenger
 * belly cargo is NOT gated by this — a pax aircraft optimises eco; its belly just rides along.)
 */
export const CARGO_OVERSHOOT_CAP = 600;

/**
 * AIRCRAFT UTILISATION FLOOR. No flying aircraft may sit below this: the optimizer
 * fills each one as full as possible and, if it still can't clear the floor, GROUNDS
 * it (better empty than half-used — the player's rule "no aircraft under 94%"). It is
 * enforced by iteratively grounding the worst sub-floor aircraft and refilling, so the
 * freed eco is re-absorbed by the survivors (they get fuller) — a clean 100/99/…/94/0
 * pyramid with no half-used tail. Trade-off: the eco that can't be packed into a ≥floor
 * aircraft is left UNSERVED, so some routes drop below ECO_TARGET. Set to 0 to disable.
 * EXCEPTION: a plane "long-haul-maxed" (can't fit another round trip of its longest route —
 * e.g. 4× a 33.75h route = 80%, no room for a 5th) is NOT grounded; a long route caps a
 * dedicated plane below this floor and that's full, not waste (it's combined with whatever
 * other routes' eco still fits). The floor only grounds planes that genuinely had room for more.
 */
export const UTIL_FLOOR = 0.85;

/**
 * SELL THRESHOLD. A route whose eco coverage ends BELOW this in the simulation is not
 * worth serving: the optimizer STOPS using it (frees its aircraft for routes it can
 * actually fill) and the report flags it as a SELL candidate. The player's rule: "if a
 * route falls under 70% in the simulation, don't use it — sell it." Dropping a route only
 * frees capacity, so the kept routes climb toward ECO_TARGET. Set to 0 to never drop/sell.
 */
export const SELL_THRESHOLD = 0.7;

/** Number of TIGHTEN passes (grow-swap + gap-fill) that push toward more profit. */
export const TIGHTEN_ROUNDS = 4;

// ───────────────────────────────────────────────────────────────────────────
// Buy catalog — the MODERN aircraft to recommend buying for underserved routes.
// The recommender picks a model per route by category fit (a model flies a route
// only if route.category >= model.cat and model.range >= distance) and sizes a
// seat config to the route/hub demand mix. Edit this when you want other models.
//
// `paxMax` is the all-economy seat headline (the cabin's "equivalent" budget). A
// business seat costs CABIN_EQUIV.bus economy units and first costs CABIN_EQUIV.first,
// and each cargo ton costs CABIN_EQUIV.cargoTon — so eco + 2·bus + 3·first + 2·cargoT
// ≈ paxMax (calibrated from the in-game default configs the player provided).
// ───────────────────────────────────────────────────────────────────────────
export interface BuyModel {
  model: string;
  cat: number; // aircraft category (flies a route only if route.category >= cat)
  range: number; // km one-way
  speed: number; // km/h (for trips-per-week sizing)
  paxMax: number; // all-economy seat budget (cabin "equivalent" units); 0 for a freighter
  payloadMax: number; // tons (max cargo)
  price: number; // $ each
  cargo?: boolean; // true = dedicated freighter (0 seats, all payload)
  def: { eco: number; bus: number; first: number; cargo: number }; // game default config
}

/** Economy-equivalent "space cost" of one seat/ton, calibrated from the defaults. */
export const CABIN_EQUIV = { eco: 1, bus: 2, first: 3, cargoTon: 2 } as const;

export const BUY_CATALOG: BuyModel[] = [
  // ── Passenger ───────────────────────────────────────────────────────────────
  // A350-1000 — widebody (cat 8, verified from the owned fleet), 522 seats, for the
  // BIG routes (cat ≥ 8). Note: being cat 8 it can NOT serve cat-7 routes (those now
  // fall to the A321XLR, or stay unfilled if too long for it).
  { model: "A350-1000", cat: 8, range: 14750, speed: 911, paxMax: 522, payloadMax: 56.1, price: 335_000_000, def: { eco: 318, bus: 50, first: 27, cargo: 13 } },
  // A321XLR — narrowbody, for the mid (cat 5–7) routes; also cheaper on short cat ≥ 8.
  { model: "A321XLR", cat: 5, range: 8700, speed: 876, paxMax: 244, payloadMax: 24.4, price: 159_895_000, def: { eco: 83, bus: 45, first: 19, cargo: 7 } },
  // ── Cargo / freighter (the only freighters you said you can buy) ──────────────
  // Categories are estimates (the screenshots didn't show them) — adjust if wrong.
  { model: "A330-300P2F", cat: 7, range: 6850, speed: 871, paxMax: 0, payloadMax: 62, price: 260_330_000, cargo: true, def: { eco: 0, bus: 0, first: 0, cargo: 62 } },
  { model: "A321P2F", cat: 5, range: 3800, speed: 876, paxMax: 0, payloadMax: 27, price: 91_000_000, cargo: true, def: { eco: 0, bus: 0, first: 0, cargo: 27 } },
];

/** Do not move rental aircraft (they often have a fixed configuration). */
export const SKIP_RENTALS = false;
