/**
 * @fileoverview Build the optimizer model from planning JSON.
 *
 * Drops foreign routes (hub is destination, not origin). Infers turnaround from
 * existing assignments. `canFly` is hub + range + airport category.
 */
import {
  DAYS_PER_WEEK,
  DEFAULT_TURNAROUND,
  PRICING,
  TIME_GRANULARITY,
} from "./config.ts";
import type {
  Aircraft,
  CabinClass,
  Line,
  PlanningPayload,
  RawAircraft,
  RawLine,
} from "./types.ts";
import { emptyCabin } from "./types.ts";

/** Pure round-trip flight time (s) of an aircraft given its speed. */
function flightTime(distanceKm: number, speedKmh: number): number {
  return ((2 * distanceKm) / speedKmh) * 3600;
}

/**
 * Infer the aircraft's real turnaround from its already-assigned routes
 * (duration = flight time + turnaround). Falls back to the default if it has none.
 */
function inferTurnaround(a: RawAircraft): number {
  const samples: number[] = [];
  for (const info of Object.values(a.lineList)) {
    const t = info.duration - flightTime(info.distance, a.speed);
    if (Number.isFinite(t) && t > 0) {
      samples.push(t);
    }
  }
  if (samples.length === 0) {
    return DEFAULT_TURNAROUND;
  }
  samples.sort((x, y) => x - y);
  return Math.round(samples[Math.floor(samples.length / 2)]); // median
}

/**
 * Round-trip block time (seconds), rounded up to `TIME_GRANULARITY`.
 * The game rejects take-offs that are not on the 900 s grid.
 */
export function roundTripDuration(a: Aircraft, line: RawLine): number {
  const raw = flightTime(line.distance, a.speed) + a.turnaround;
  return Math.ceil(raw / TIME_GRANULARITY) * TIME_GRANULARITY;
}

/**
 * Whether `a` may fly `line`: same hub, range ≥ distance, `line.category >= a.category`.
 * One illegal slot rejects the entire aircraft update.
 */
export function canFly(a: Aircraft, line: Line): boolean {
  return (
    a.hubId === line.hubId &&
    a.range >= line.distance &&
    line.category >= a.category
  );
}

/** Price per seat/ton (one way) as a function of distance. */
function priceFor(cls: CabinClass, distanceKm: number): number {
  const p = PRICING[cls];
  return p.base + p.perKm * distanceKm;
}

/** Aircraft capacity per class (seats / cargo tons per flight). */
export function capacityOf(a: RawAircraft): Record<CabinClass, number> {
  return {
    bus: a.seatsBus,
    cargo: a.payloadUsed, // available cargo (tons)
    eco: a.seatsEco,
    first: a.seatsFirst,
  };
}

/**
 * Build `Line` and `Aircraft` maps from planning JSON.
 *
 * Keeps only routes owned by the hub (`airportOneId === hubAirportId`).
 * Demand is copied into seven daily pools. Turnaround is inferred per aircraft.
 */
export function buildModel(payloads: PlanningPayload[]): {
  lines: Map<number, Line>;
  aircraft: Aircraft[];
} {
  const lines = new Map<number, Line>();
  const aircraft: Aircraft[] = [];

  for (const payload of payloads) {
    for (const raw of payload.lineDataArray) {
      // Only routes OWNED by the hub (origin == hub). The endpoint also returns
      // foreign routes (where this hub is only the destination) which must be dropped.
      if (raw.airportOneId !== payload.hubAirportId) {
        continue;
      }
      if (lines.has(raw.id)) {
        continue;
      }
      // Demand is DAILY (paxAtt*). Keep 7 independent daily pools so a flight only
      // ever consumes the day it departs on — that is what caps per-day oversupply.
      const dailyDemand: Record<CabinClass, number> = {
        bus: raw.paxAttBus,
        cargo: raw.paxAttCargo,
        eco: raw.paxAttEco,
        first: raw.paxAttFirst,
      };
      const weeklyDemand: Record<CabinClass, number> = {
        bus: dailyDemand.bus * DAYS_PER_WEEK,
        cargo: dailyDemand.cargo * DAYS_PER_WEEK,
        eco: dailyDemand.eco * DAYS_PER_WEEK,
        first: dailyDemand.first * DAYS_PER_WEEK,
      };
      lines.set(raw.id, {
        ...raw,
        dailyDemand,
        hubId: payload.hubAirportId,
        over: Array.from({ length: DAYS_PER_WEEK }, emptyCabin),
        price: {
          bus: priceFor("bus", raw.distance),
          cargo: priceFor("cargo", raw.distance),
          eco: priceFor("eco", raw.distance),
          first: priceFor("first", raw.distance),
        },
        remaining: Array.from({ length: DAYS_PER_WEEK }, () => ({
          ...dailyDemand,
        })),
        weeklyDemand,
      });
    }

    for (const raw of payload.aircraftDataArray) {
      aircraft.push({
        ...raw,
        assigned: [],
        cursor: 0,
        turnaround: inferTurnaround(raw),
      });
    }
  }

  return { aircraft, lines };
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

/** IATA code of each hub, taken from owned route names (`LHR / CDG` → `LHR`). */
export function hubCodes(lines: Iterable<Line>): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of lines) {
    if (!map.has(line.hubId)) {
      map.set(line.hubId, line.name.split(" / ")[0] ?? "?");
    }
  }
  return map;
}
