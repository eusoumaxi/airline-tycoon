import { DEFAULT_TURNAROUND, DEMAND_DAYS, PRICING, WEEK_SECONDS } from "./config.ts";
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

/** Round-trip duration (s) of a specific aircraft on a specific line. */
export function roundTripDuration(a: Aircraft, line: RawLine): number {
  return Math.round(flightTime(line.distance, a.speed) + a.turnaround);
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
 * Can this aircraft fly this route? Two hard conditions:
 *   1. Same hub: the route must depart from the aircraft's hub (aircraft.hubId).
 *      A BOG aircraft cannot fly a GRU route, etc.
 *   2. Range: range >= distance (one way).
 */
export function canFly(a: Aircraft, line: Line): boolean {
  return a.hubId === line.hubId && a.range >= line.distance;
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
      const weeklyDemand: Record<CabinClass, number> = {
        eco: raw.paxAttEco * DEMAND_DAYS,
        bus: raw.paxAttBus * DEMAND_DAYS,
        first: raw.paxAttFirst * DEMAND_DAYS,
        cargo: raw.paxAttCargo * DEMAND_DAYS,
      };
      lines.set(raw.id, {
        ...raw,
        hubId: payload.hubAirportId,
        weeklyDemand,
        remaining: { ...weeklyDemand },
        over: { eco: 0, bus: 0, first: 0, cargo: 0 },
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
        freeTime: WEEK_SECONDS,
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

/** Reset the model's mutable state (demand and time) to re-optimize. */
export function resetModel(lines: Map<number, Line>, aircraft: Aircraft[]): void {
  for (const line of lines.values()) {
    line.remaining = { ...line.weeklyDemand };
    line.over = { eco: 0, bus: 0, first: 0, cargo: 0 };
  }
  for (const a of aircraft) {
    a.freeTime = WEEK_SECONDS;
    a.assigned = [];
  }
}
