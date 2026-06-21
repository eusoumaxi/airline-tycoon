import { DEFAULT_TURNAROUND, DEMAND_DAYS, PRICING, WEEK_SECONDS } from "./config.ts";
import type {
  Aircraft,
  CabinClass,
  Line,
  PlanningPayload,
  RawAircraft,
  RawLine,
} from "./types.ts";

/** Tiempo de vuelo puro ida+vuelta (s) de un avion segun su velocidad. */
function flightTime(distanceKm: number, speedKmh: number): number {
  return (2 * distanceKm) / speedKmh * 3600;
}

/**
 * Infere el turnaround real del avion a partir de sus rutas ya asignadas
 * (duration = tiempo de vuelo + turnaround). Si no tiene rutas, usa el default.
 */
function inferTurnaround(a: RawAircraft): number {
  const samples: number[] = [];
  for (const info of Object.values(a.lineList)) {
    const t = info.duration - flightTime(info.distance, a.speed);
    if (Number.isFinite(t) && t > 0) samples.push(t);
  }
  if (samples.length === 0) return DEFAULT_TURNAROUND;
  samples.sort((x, y) => x - y);
  return Math.round(samples[Math.floor(samples.length / 2)]); // mediana
}

/** Duracion ida+vuelta (s) de un avion concreto en una linea concreta. */
export function roundTripDuration(a: Aircraft, line: RawLine): number {
  return Math.round(flightTime(line.distance, a.speed) + a.turnaround);
}

/** Maximo de vuelos (ida+vuelta) que caben en la semana para ese avion/linea. */
export function maxTripsByTime(a: Aircraft, line: RawLine): number {
  return Math.floor(WEEK_SECONDS / roundTripDuration(a, line));
}

/** ¿El avion alcanza la linea? (alcance >= distancia de un sentido). */
export function reaches(a: RawAircraft, line: RawLine): boolean {
  return a.range >= line.distance;
}

/**
 * ¿Este avion PUEDE volar esta ruta? Dos condiciones duras:
 *   1. Mismo hub: la ruta debe salir del hub del avion (aircraft.hubId).
 *      Un avion de BOG no puede volar una ruta de GRU, etc.
 *   2. Alcance: range >= distancia (un sentido).
 */
export function canFly(a: Aircraft, line: Line): boolean {
  return a.hubId === line.hubId && a.range >= line.distance;
}

/** Precio por asiento/tonelada (un sentido) en funcion de la distancia. */
function priceFor(cls: CabinClass, distanceKm: number): number {
  const p = PRICING[cls];
  return p.base + p.perKm * distanceKm;
}

/** Capacidad de un avion por clase (asientos / toneladas de carga por vuelo). */
export function capacityOf(a: RawAircraft): Record<CabinClass, number> {
  return {
    eco: a.seatsEco,
    bus: a.seatsBus,
    first: a.seatsFirst,
    cargo: a.payloadUsed, // bodega disponible (toneladas)
  };
}

/** Construye el modelo enriquecido a partir de uno o varios payloads. */
export function buildModel(payloads: PlanningPayload[]): {
  lines: Map<number, Line>;
  aircraft: Aircraft[];
} {
  const lines = new Map<number, Line>();
  const aircraft: Aircraft[] = [];

  for (const payload of payloads) {
    for (const raw of payload.lineDataArray) {
      // Solo rutas PROPIAS del hub (origen == hub). El endpoint tambien trae
      // rutas ajenas (p.ej. "MIA / GRU" al cargar GRU) que hay que descartar.
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

/** Indexa las lineas por hub (para que cada avion solo evalue las de su hub). */
export function linesByHub(lines: Map<number, Line>): Map<number, Line[]> {
  const idx = new Map<number, Line[]>();
  for (const line of lines.values()) {
    const arr = idx.get(line.hubId) ?? idx.set(line.hubId, []).get(line.hubId)!;
    arr.push(line);
  }
  return idx;
}

/** Reinicia el estado mutable del modelo (demanda y tiempo) para re-optimizar. */
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
