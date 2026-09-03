/**
 * @fileoverview Env, game constants, and optimizer knobs.
 *
 * Cookie lives in `AM_COOKIE` (never exported). Tune `UTIL_FLOOR`, `ECO_OVERSHOOT_CAP`,
 * `SELL_THRESHOLD`, and `BUY_CATALOG` here — not in CLI files.
 */
import { mkdir } from "node:fs/promises";
import type { BuyModel } from "./types.ts";

const cookie = process.env.AM_COOKIE?.trim() ?? "";

/** Game origin. */
export const BASE_URL = "https://tycoon.airlines-manager.com";

/** Directory for JSON snapshots and HTML reports. */
export const DATA_DIR = process.env.AM_DATA_DIR ?? "data";

/** Create `DATA_DIR` if it does not exist. */
export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

/**
 * Exact User-Agent the game expects. Override with `AM_USER_AGENT` if a request
 * is rejected after a browser update.
 */
export const USER_AGENT =
  process.env.AM_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Throw if the session cookie is missing. Call before any game request. */
export function requireCookie(): string {
  if (!cookie) {
    throw new Error(
      "Missing AM_COOKIE. Copy .env.example to .env and paste your session cookie from the game."
    );
  }
  return cookie;
}

/**
 * Hub codes `bun run apply` targets when `--hub` is omitted.
 * Set `AM_APPLY_HUBS=LHR,CDG` (comma-separated) or always pass `--hub`.
 */
export const APPLY_HUBS = (process.env.AM_APPLY_HUBS ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** Seconds in one planning week. */
export const WEEK_SECONDS = 604_800;

/** Days in a planning week. `paxAtt*` demand is daily and regenerates each day. */
export const DAYS_PER_WEEK = 7;

/** Seconds in one day. The optimizer tracks 7 daily demand pools. */
export const DAY_SECONDS = 86_400;

/** Default turnaround (s) when it cannot be inferred from the aircraft. */
export const DEFAULT_TURNAROUND = 7600;

/**
 * Planning time granularity (s). Every `takeOffTime` must be a multiple of this
 * (15 min) or the game rejects the whole aircraft update.
 */
export const TIME_GRANULARITY = 900;

/**
 * Estimated price per seat (one-way) = `base + perKm * distanceKm`.
 * Cargo is price per ton (one-way).
 */
export const PRICING = {
  bus: { base: 60, perKm: 0.4 },
  cargo: { base: 40, perKm: 0.25 },
  eco: { base: 35, perKm: 0.2 },
  first: { base: 90, perKm: 0.6 },
} as const;

/** A round trip is outbound + inbound: both legs earn revenue. */
export const LEGS_PER_ROUNDTRIP = 2;

/**
 * Break-even load (revenue-weighted) for a passenger aircraft.
 * Reporting only — not an optimisation gate. Objective is eco coverage.
 */
export const BREAK_EVEN_LOAD = 0.15;

/** Break-even load for a dedicated freighter. Reporting only. */
export const BREAK_EVEN_LOAD_CARGO = 0.37;

/**
 * Eco coverage quality marker in reports. Routes are filled to the brim;
 * the hard rule is `ECO_OVERSHOOT_CAP`.
 */
export const ECO_TARGET = 0.98;

/**
 * Max eco overshoot per route per day (seats). A flight is skipped if it would
 * drive that day's remaining eco below `-CAP` (aircraft too big for the residual).
 */
export const ECO_OVERSHOOT_CAP = 1500;

/**
 * Max cargo overshoot per route per day (tons) for freighters.
 * Passenger belly cargo is not gated by this.
 */
export const CARGO_OVERSHOOT_CAP = 600;

/**
 * Minimum utilisation for a flying aircraft. Below this the optimizer grounds
 * the plane (idle is better than half-used). Set `0` to disable.
 *
 * Exception: a long-haul aircraft that cannot fit another round trip of its
 * longest route is not grounded — that is a full week, not waste.
 */
export const UTIL_FLOOR = 0.85;

/**
 * Routes whose eco coverage finishes below this are dropped (aircraft go to
 * routes they can actually fill) and flagged as sell candidates. Set `0` to never drop.
 */
export const SELL_THRESHOLD = 0.7;

/** Re-export so callers can import knobs from this module. */
export type { BuyModel } from "./types.ts";

/** Economy-equivalent space cost of one seat / ton. */
export const CABIN_EQUIV = { bus: 2, cargoTon: 2, eco: 1, first: 3 } as const;

/**
 * Aircraft the recommender may suggest buying.
 * A model flies a route only if `route.category >= model.cat` and `range >= distance`.
 * `paxMax` is the all-economy seat budget; bus/first/cargo consume `CABIN_EQUIV` units.
 */
export const BUY_CATALOG: BuyModel[] = [
  {
    cat: 8,
    def: { bus: 50, cargo: 13, eco: 318, first: 27 },
    model: "A350-1000",
    paxMax: 522,
    payloadMax: 56.1,
    price: 335_000_000,
    range: 14_750,
    speed: 911,
  },
  {
    cat: 5,
    def: { bus: 45, cargo: 7, eco: 83, first: 19 },
    model: "A321XLR",
    paxMax: 244,
    payloadMax: 24.4,
    price: 159_895_000,
    range: 8700,
    speed: 876,
  },
  {
    cargo: true,
    cat: 7,
    def: { bus: 0, cargo: 62, eco: 0, first: 0 },
    model: "A330-300P2F",
    paxMax: 0,
    payloadMax: 62,
    price: 260_330_000,
    range: 6850,
    speed: 871,
  },
  {
    cargo: true,
    cat: 5,
    def: { bus: 0, cargo: 27, eco: 0, first: 0 },
    model: "A321P2F",
    paxMax: 0,
    payloadMax: 27,
    price: 91_000_000,
    range: 3800,
    speed: 876,
  },
];

/** Skip rental aircraft in the optimizer when `AM_SKIP_RENTALS=1`. */
export const SKIP_RENTALS = process.env.AM_SKIP_RENTALS === "1";
