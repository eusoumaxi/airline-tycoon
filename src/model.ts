import { DAYS_PER_WEEK, DEFAULT_TURNAROUND, PRICING, TIME_GRANULARITY, WEEK_SECONDS } from "./config.ts";
import type {
  Aircraft,
  CabinClass,
  Line,
  PlanningPayload,
  RawAircraft,
  RawLine,
} from "./types.ts";

/** Pure round-trip flight time (s) of an aircraft given its speed. */
function flightTime(distanceKm: number, speedKmh: number): number {
  return (2 * distanceKm) / speedKmh * 3600;
}

/**
 * Infer the aircraft's real turnaround from its already-assigned routes
 * (duration = flight time + turnaround). Falls back to the default if it has none.
 */
function inferTurnaround(a: RawAircraft): number {
  const samples: number[] = [];
  for (const info of Object.values(a.lineList)) {
    const t = info.duration - flightTime(info.distance, a.speed);
    if (Number.isFinite(t) && t > 0) samples.push(t);
  }
  if (samples.length === 0) return DEFAULT_TURNAROUND;
  samples.sort((x, y) => x - y);
  return Math.round(samples[Math.floor(samples.length / 2)]); // median
}

/**
 * Round-trip duration (s) of a specific aircraft on a specific line, rounded UP
 * to a whole TIME_GRANULARITY slot. The game schedules on a 900 s grid, so a
 * flight effectively occupies its time rounded up to the next slot boundary;
 * using this everywhere keeps packing consistent with the schedule (no overlap,
 * no over-subscription).
 */
export function roundTripDuration(a: Aircraft, line: RawLine): number {
  const raw = flightTime(line.distance, a.speed) + a.turnaround;
  return Math.ceil(raw / TIME_GRANULARITY) * TIME_GRANULARITY;
}

/** Max number of round trips that fit in the week for that aircraft/line. */
export function maxTripsByTime(a: Aircraft, line: RawLine): number {
  return Math.floor(WEEK_SECONDS / roundTripDuration(a, line));
}

/** Does the aircraft reach the line? (range >= one-way distance). */
export function reaches(a: RawAircraft, line: RawLine): boolean {
  return a.range >= line.distance;
}

/**
 * Can this aircraft fly this route? Three hard conditions:
 *   1. Same hub: the route must depart from the aircraft's hub (aircraft.hubId).
 *      A BOG aircraft cannot fly a GRU route, etc.
 *   2. Range: range >= distance (one way).
 *   3. Runway/airport size: line.category >= aircraft.category. Bigger aircraft
 *      (higher category) need bigger airports; a small airport (low category)
 *      rejects them ("needs larger runways"). Verified: holds for every real
 *      flown pair. If any flight breaks this, the game rejects the WHOLE update.
 */
export function canFly(a: Aircraft, line: Line): boolean {
  return a.hubId === line.hubId && a.range >= line.distance && line.category >= a.category;
}

/** Price per seat/ton (one way) as a function of distance. */
function priceFor(cls: CabinClass, distanceKm: number): number {
  const p = PRICING[cls];
  return p.base + p.perKm * distanceKm;
}

/** Aircraft capacity per class (seats / cargo tons per flight). */
export function capacityOf(a: RawAircraft): Record<CabinClass, number> {
  return {
    eco: a.seatsEco,
    bus: a.seatsBus,
    first: a.seatsFirst,
    cargo: a.payloadUsed, // available cargo (tons)
  };
}

/** Build the enriched model from one or more payloads. */
export function buildModel(payloads: PlanningPayload[]): {
  lines: Map<number, Line>;
  aircraft: Aircraft[];
} {
  const lines = new Map<number, Line>();
  const aircraft: Aircraft[] = [];

  for (const payload of payloads) {
    for (const raw of payload.lineDataArray) {
      // Only routes OWNED by the hub (origin == hub). The endpoint also returns
      // foreign routes (e.g. "MIA / GRU" when loading GRU) which must be dropped.
      if (raw.airportOneId !== payload.hubAirportId) continue;
      if (lines.has(raw.id)) continue;
      // Demand is DAILY (paxAtt*). Keep 7 independent daily pools so a flight only
      // ever consumes the day it departs on — that is what caps per-day oversupply.
      const dailyDemand: Record<CabinClass, number> = {
        eco: raw.paxAttEco,
        bus: raw.paxAttBus,
        first: raw.paxAttFirst,
        cargo: raw.paxAttCargo,
      };
      const weeklyDemand: Record<CabinClass, number> = {
        eco: dailyDemand.eco * DAYS_PER_WEEK,
        bus: dailyDemand.bus * DAYS_PER_WEEK,
        first: dailyDemand.first * DAYS_PER_WEEK,
        cargo: dailyDemand.cargo * DAYS_PER_WEEK,
      };
      lines.set(raw.id, {
        ...raw,
        hubId: payload.hubAirportId,
        dailyDemand,
        weeklyDemand,
        remaining: Array.from({ length: DAYS_PER_WEEK }, () => ({ ...dailyDemand })),
        over: Array.from({ length: DAYS_PER_WEEK }, () => ({ eco: 0, bus: 0, first: 0, cargo: 0 })),
        price: {
          eco: priceFor("eco", raw.distance),
          bus: priceFor("bus", raw.distance),
          first: priceFor("first", raw.distance),
          cargo: priceFor("cargo", raw.distance),
        },
      });
    }

    for (const raw of payload.aircraftDataArray) {
      aircraft.push({
        ...raw,
        turnaround: inferTurnaround(raw),
        cursor: 0,
        assigned: [],
      });
    }
  }

  return { lines, aircraft };
}

/** Index lines by hub (so each aircraft only evaluates its own hub's lines). */
export function linesByHub(lines: Map<number, Line>): Map<number, Line[]> {
  const idx = new Map<number, Line[]>();
  for (const line of lines.values()) {
    const arr = idx.get(line.hubId) ?? idx.set(line.hubId, []).get(line.hubId)!;
    arr.push(line);
  }
  return idx;
}

/** Reset the model's mutable state (per-day demand and schedule) to re-optimize. */
export function resetModel(lines: Map<number, Line>, aircraft: Aircraft[]): void {
  for (const line of lines.values()) {
    line.remaining = Array.from({ length: DAYS_PER_WEEK }, () => ({ ...line.dailyDemand }));
    line.over = Array.from({ length: DAYS_PER_WEEK }, () => ({ eco: 0, bus: 0, first: 0, cargo: 0 }));
  }
  for (const a of aircraft) {
    a.cursor = 0;
    a.assigned = [];
  }
}
