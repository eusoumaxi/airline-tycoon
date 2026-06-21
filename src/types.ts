// ───────────────────────────────────────────────────────────────────────────
// Domain types (response of /network/planning/load/<id>)
// ───────────────────────────────────────────────────────────────────────────

/** A line/route as returned by the API. */
export interface RawLine {
  id: number;
  name: string; // "BOG / CCS"
  airportOneId: number; // origin (the hub, for routes owned by this hub)
  airportTwoId: number; // destination
  distance: number; // km (one way)
  baseDuration: number; // s, game reference
  category: number; // 1..10
  paxAttEco: number; // expected eco pax  (see DEMAND_DAYS for the period)
  paxAttBus: number; // expected business pax
  paxAttFirst: number; // expected first pax
  paxAttCargo: number; // cargo demand
  color: string;
}

/** One flight inside an aircraft's weekly planning. */
export interface PlanningSlot {
  takeOffTime: number; // s from the start of the week (0..604800)
  lineId: number;
  aircraftId: number;
}

/** An aircraft as returned by the API. */
export interface RawAircraft {
  id: number;
  name: string;
  hubId: number; // home hub airportId (only flies routes owned by this hub)
  category: number;
  range: number; // km (one way)
  isRental: boolean;
  isCargo: boolean; // freighter (0 seats, all payload)
  seatsEco: number;
  seatsBus: number;
  seatsFirst: number;
  payloadUsed: number; // cargo (belly / freighter) capacity in tons
  consumption: number;
  utilizationPercentage: number; // % of the week already busy
  aircraftListName: string; // model, "A350-1000"
  picture: string;
  speed: number; // km/h
  planningList: PlanningSlot[];
  lineList: Record<string, { name: string; color: string; distance: number; duration: number }>;
}

/** Full response of the planning-load endpoint. */
export interface PlanningPayload {
  hubAirportId: number;
  lineDataArray: RawLine[];
  aircraftDataArray: RawAircraft[];
}

// ───────────────────────────────────────────────────────────────────────────
// Enriched model types (used by the optimizer)
// ───────────────────────────────────────────────────────────────────────────

export type CabinClass = "eco" | "bus" | "first" | "cargo";

/** A hub (base) discovered from the planning page. */
export interface Hub {
  loadId: number; // id for /network/planning/load/<loadId>
  code: string; // "BOG"
  airportId: number; // 156  (== payload.hubAirportId and aircraft.hubId)
}

export interface Line extends RawLine {
  /**
   * Owning hub of the route (== airportOneId == aircraft.hubId that may fly it).
   * A hub's endpoint also returns FOREIGN routes (where the hub is the
   * destination, airportTwoId); those are dropped when building the model.
   */
  hubId: number;
  /**
   * Remaining demand per class, indexed by DAY (0=Mon .. 6=Sun). The game meters
   * demand per day, so a flight departing on day `d` only draws from `remaining[d]`.
   * Each day starts at `dailyDemand` (= `paxAtt*`). This is what stops the optimizer
   * from oversupplying a single day (the bug that lost money on near-empty flights).
   */
  remaining: Record<CabinClass, number>[];
  /** Demand per class for ONE day (= `paxAtt*`); every day starts here. */
  dailyDemand: Record<CabinClass, number>;
  /** Total weekly demand per class (= dailyDemand × 7, constant reference for reports). */
  weeklyDemand: Record<CabinClass, number>;
  /** Seats oversupplied per class, indexed by DAY (above that day's demand). */
  over: Record<CabinClass, number>[];
  /** Estimated price per seat/ton (one way) by distance. */
  price: Record<CabinClass, number>;
}

/** A flight already assigned to an aircraft, with its contribution. */
export interface AssignedTrip {
  lineId: number;
  /** Departure day (0=Mon .. 6=Sun) — which daily demand pool it consumes. */
  day: number;
  /** Concrete take-off time (s from week start, multiple of TIME_GRANULARITY). */
  takeOffTime: number;
  duration: number;
  within: Record<CabinClass, number>; // seats served within that day's demand
  over: Record<CabinClass, number>; // oversupplied seats (empty, above demand)
  value: number; // flight value (profit) when assigned
}

export interface Aircraft extends RawAircraft {
  /** Turnaround inferred for this aircraft (s). */
  turnaround: number;
  /**
   * Scheduling cursor: the next free second in the week (0..WEEK_SECONDS). Flights
   * are laid down sequentially from here, so the take-off time — and therefore the
   * departure DAY — is decided during allocation (no separate, demand-blind pass).
   */
  cursor: number;
  /** Flights assigned by the optimizer (in take-off order). */
  assigned: AssignedTrip[];
}

/** Result: a proposed flight for an aircraft (ready for the update format). */
export interface ProposedFlight {
  takeOffTime: number;
  lineId: number;
}

export interface AircraftPlan {
  aircraftId: number;
  added: ProposedFlight[];
}
