/**
 * @fileoverview Domain types: raw game JSON plus the optimizer model.
 *
 * `Raw*` / `PlanningPayload` match `/network/planning/load/<id>`.
 * `Line` / `Aircraft` add daily demand pools and the current assignment.
 */

/** Route as returned by the planning-load endpoint. */
export interface RawLine {
  /** Origin airport id (the owning hub for routes kept in the model). */
  airportOneId: number;
  /** Destination airport id. */
  airportTwoId: number;
  /** Game reference duration (seconds). */
  baseDuration: number;
  /** Airport category 1–10. The aircraft category must be ≤ this. */
  category: number;
  color: string;
  /** One-way distance (km). */
  distance: number;
  id: number;
  /** `"LHR / CDG"` — origin IATA is always first. */
  name: string;
  paxAttBus: number;
  paxAttCargo: number;
  /** Expected economy passengers **per day**. */
  paxAttEco: number;
  paxAttFirst: number;
}

/** One slot in the aircraft's current weekly plan. */
export interface PlanningSlot {
  aircraftId: number;
  lineId: number;
  /** Seconds from week start (`0`–`WEEK_SECONDS`), multiple of `TIME_GRANULARITY`. */
  takeOffTime: number;
}

/** Aircraft as returned by the planning-load endpoint. */
export interface RawAircraft {
  /** Type name, e.g. `"A350-1000"`. */
  aircraftListName: string;
  category: number;
  consumption: number;
  /** Home hub airport id. The aircraft only flies routes owned by this hub. */
  hubId: number;
  id: number;
  /** Freighter: zero seats, payload is cargo tons. */
  isCargo: boolean;
  isRental: boolean;
  lineList: Record<
    string,
    { name: string; color: string; distance: number; duration: number }
  >;
  name: string;
  /** Belly or freighter cargo capacity (tons). */
  payloadUsed: number;
  picture: string;
  planningList: PlanningSlot[];
  /** One-way range (km). */
  range: number;
  seatsBus: number;
  seatsEco: number;
  seatsFirst: number;
  /** Cruise speed (km/h). */
  speed: number;
  utilizationPercentage: number;
}

/** JSON body of `GET /network/planning/load/<loadId>`. */
export interface PlanningPayload {
  aircraftDataArray: RawAircraft[];
  hubAirportId: number;
  lineDataArray: RawLine[];
}

/** Cabin keys used in demand, capacity, and overshoot maps. */
export type CabinClass = "eco" | "bus" | "first" | "cargo";

/** Hub discovered from `/network/planning`. */
export interface Hub {
  /** Airport id (`payload.hubAirportId` / `aircraft.hubId`). */
  airportId: number;
  /** IATA code, e.g. `"LHR"`. */
  code: string;
  /** Id for `GET /network/planning/load/<loadId>`. */
  loadId: number;
}

/** Owned route plus daily demand pools used by the optimizer. */
export interface Line extends RawLine {
  /** Demand per class for ONE day (= `paxAtt*`); every day starts here. */
  dailyDemand: Record<CabinClass, number>;
  /**
   * Owning hub of the route (== airportOneId == aircraft.hubId that may fly it).
   * A hub's endpoint also returns FOREIGN routes (where the hub is the
   * destination, airportTwoId); those are dropped when building the model.
   */
  hubId: number;
  /** Seats oversupplied per class, indexed by DAY (above that day's demand). */
  over: Record<CabinClass, number>[];
  /** Estimated price per seat/ton (one way) by distance. */
  price: Record<CabinClass, number>;
  /**
   * Remaining demand per class, indexed by day (`0` = Monday). A departure on day
   * `d` only consumes `remaining[d]`. Each day resets to `dailyDemand`.
   */
  remaining: Record<CabinClass, number>[];
  /** Total weekly demand per class (= dailyDemand × 7, constant reference for reports). */
  weeklyDemand: Record<CabinClass, number>;
}

/** A flight already assigned to an aircraft, with its contribution. */
export interface AssignedTrip {
  /** Departure day (0=Mon .. 6=Sun) — which daily demand pool it consumes. */
  day: number;
  duration: number;
  lineId: number;
  over: Record<CabinClass, number>; // oversupplied seats (empty, above demand)
  /** Concrete take-off time (s from week start, multiple of TIME_GRANULARITY). */
  takeOffTime: number;
  value: number; // flight value (profit) when assigned
  within: Record<CabinClass, number>; // seats served within that day's demand
}

/** Aircraft plus the optimizer's current assignment and scheduling cursor. */
export interface Aircraft extends RawAircraft {
  /** Flights assigned by the optimizer (in take-off order). */
  assigned: AssignedTrip[];
  /**
   * Scheduling cursor: the next free second in the week (0..WEEK_SECONDS). Flights
   * are laid down sequentially from here, so the take-off time — and therefore the
   * departure DAY — is decided during allocation (no separate, demand-blind pass).
   */
  cursor: number;
  /** Turnaround inferred for this aircraft (s). */
  turnaround: number;
}

/** One proposed slot ready for `updatePlanning`. */
export interface ProposedFlight {
  lineId: number;
  takeOffTime: number;
}

/** Weekly plan ready to POST: `{ aircraftId, added: [{ lineId, takeOffTime }] }`. */
export interface AircraftPlan {
  added: ProposedFlight[];
  aircraftId: number;
}

/** Cabin keys used by demand, capacity, and overshoot maps. */
export const CABIN_CLASSES = ["eco", "bus", "first", "cargo"] as const;
/** Passenger cabins only (excludes cargo). */
export const PAX_CLASSES = ["eco", "bus", "first"] as const;
/** Week starts Monday, matching game `takeOffTime` (0 = Mon 00:00). */
export const WEEKDAYS = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

/** Empty per-class counts. */
export function emptyCabin(): Record<CabinClass, number> {
  return { bus: 0, cargo: 0, eco: 0, first: 0 };
}

/** True if two weekly plans list the same flights. */
export function plansEqual(
  a: readonly { lineId: number; takeOffTime: number }[],
  b: readonly { lineId: number; takeOffTime: number }[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (f: { lineId: number; takeOffTime: number }) =>
    `${f.lineId}@${f.takeOffTime}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((x, i) => x === right[i]);
}

/** Catalog aircraft used by the buy recommender. */
export interface BuyModel {
  cargo?: boolean;
  cat: number;
  def: CabinConfig;
  model: string;
  paxMax: number;
  payloadMax: number;
  price: number;
  range: number;
  speed: number;
}

/** Seat / cargo layout shown on the buy or reconfigure screen. */
export interface CabinConfig {
  bus: number;
  cargo: number;
  eco: number;
  first: number;
}

/** A route that can be bought from a hub. */
export interface BuyableRoute {
  audited: boolean;
  auditPrice: number;
  cat: number;
  code: string;
  country: string;
  demandPct: number;
  dist: number;
  iata: string;
  name: string;
  price: number;
}

/** How the recommender would fill leftover demand on a route. */
export interface FillPlan {
  buyModel?: BuyModel;
  cargoLed: boolean;
  note?: "low-cat" | "belly-cargo" | "no-reach";
  reuseIdle?: { model: string; available: number; ids: number[] };
}

/** A route whose optimized coverage is still below demand. */
export interface UnderservedRoute {
  coverageEco: number;
  fill: FillPlan;
  line: Line;
  residual?: Record<CabinClass, number>;
  served: Record<CabinClass, number>;
  uncovered: Record<CabinClass, number>;
  uncoveredValue: number;
}

/** Shopping-list row: buy `count` of `model` configured as `config`. */
export interface BuyOrder {
  cargoLed: boolean;
  config: CabinConfig;
  count: number;
  loadPerAircraft: Record<CabinClass, number>;
  model: BuyModel;
  profit: number;
  routes: string[];
  totalPrice: number;
  uncoveredEco: number;
  util: number;
}

/** What to do with idle aircraft the optimizer grounded. */
export type SurplusAction =
  | {
      kind: "buy-route";
      maxCat: number;
      minRange: number;
      route?: BuyableRoute;
      text: string;
    }
  | {
      config: CabinConfig;
      kind: "reconfigure-cargo";
      text: string;
      tons: number;
    }
  | { kind: "move-hub"; text: string; toCode: string; uncoveredEco: number }
  | { kind: "surplus"; text: string };

/** Idle aircraft of one model, plus the recommended action. */
export interface SurplusGroup {
  action: SurplusAction;
  alt?: string;
  cat: number;
  count: number;
  ids: number[];
  model: string;
  range: number;
  reason: string;
  seats: CabinConfig;
}

/** Per-hub shopping list, surplus actions, and uncovered demand. */
export interface HubAdvice {
  bellyCargo: { line: Line; tons: number }[];
  bellyCreditTons: number;
  buyOrders: BuyOrder[];
  code: string;
  demand: Record<CabinClass, number>;
  flying: number;
  hubId: number;
  idle: number;
  residual: Record<CabinClass, number>;
  routeCount: number;
  servedNow: Record<CabinClass, number>;
  smallRouteGap: { line: Line; uncovered: Record<CabinClass, number> }[];
  surplus: SurplusGroup[];
  total: number;
  uncoveredCargoTons: number;
  uncoveredEcoSeats: number;
  underserved: UnderservedRoute[];
}
