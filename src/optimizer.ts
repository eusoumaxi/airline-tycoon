import {
  COST_PER_KM,
  LEGS_PER_ROUNDTRIP,
  MIN_FILL,
  SKIP_RENTALS,
  TIGHTEN_ROUNDS,
  WEEK_SECONDS,
} from "./config.ts";
import { canFly, capacityOf, linesByHub, roundTripDuration } from "./model.ts";
import type { Aircraft, AircraftPlan, AssignedTrip, CabinClass, Line } from "./types.ts";

const CLASSES: CabinClass[] = ["eco", "bus", "first", "cargo"];

/** Entrada del heap: clave (densidad), id de avion y epoca (para invalidar). */
interface HeapEntry {
  key: number;
  id: number;
  epoch: number;
}

/** Max-heap binario simple por `key`. */
class MaxHeap {
  private h: HeapEntry[] = [];
  get size(): number {
    return this.h.length;
  }
  push(e: HeapEntry): void {
    const h = this.h;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].key >= h[i].key) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop(): HeapEntry | undefined {
    const h = this.h;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l].key > h[m].key) m = l;
        if (r < h.length && h[r].key > h[m].key) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * BENEFICIO de UN vuelo ida+vuelta de `a` en `line`, dado el estado de la
 * demanda: ingresos de la DEMANDA REAL que llenaria menos el coste del vuelo.
 *   value = Σ_clase  min(asientos, demanda_restante) · precio        (ingresos)
 *         − COST_PER_KM · distancia · 2                              (coste)
 * Los asientos que sobran (sobreoferta) valen 0 (vuelan vacios, no ingresan).
 * Si value <= 0 el vuelo NO se programa (pierde plata) -> el slot queda libre.
 * Asi la sobreoferta se acota sola: al agotarse la demanda, los vuelos extra
 * dejan de ser rentables y no se vuelan.
 */
function roundTripValue(a: Aircraft, line: Line): {
  value: number;
  fillWithin: Record<CabinClass, number>;
  fillOver: Record<CabinClass, number>;
} {
  const cap = capacityOf(a);
  const fillWithin = { eco: 0, bus: 0, first: 0, cargo: 0 } as Record<CabinClass, number>;
  const fillOver = { eco: 0, bus: 0, first: 0, cargo: 0 } as Record<CabinClass, number>;
  let revenue = 0;
  let paxSeats = 0;
  let paxFilled = 0;
  for (const c of CLASSES) {
    const seats = cap[c];
    if (seats <= 0) continue;
    const within = Math.max(0, Math.min(seats, line.remaining[c])); // demanda real que llena
    fillWithin[c] = within;
    fillOver[c] = seats - within; // asientos vacios (sobreoferta), no ingresan
    revenue += within * line.price[c];
    if (c !== "cargo") {
      paxSeats += seats;
      paxFilled += within;
    }
  }
  // Salvaguarda opcional: exigir un minimo de ocupacion pax para volar.
  if (MIN_FILL > 0 && paxSeats > 0 && paxFilled < MIN_FILL * paxSeats) {
    return { value: 0, fillWithin, fillOver };
  }
  const cost = COST_PER_KM * line.distance * LEGS_PER_ROUNDTRIP;
  return { value: revenue * LEGS_PER_ROUNDTRIP - cost, fillWithin, fillOver };
}

interface Candidate {
  line: Line;
  duration: number;
  value: number;
  density: number; // valor por segundo de avion
  fillWithin: Record<CabinClass, number>;
  fillOver: Record<CabinClass, number>;
}

/** Mejor linea (mayor beneficio por segundo) para un avion en el estado actual. */
function bestLineFor(a: Aircraft, lines: Line[]): Candidate | null {
  let best: Candidate | null = null;
  for (const line of lines) {
    if (!canFly(a, line)) continue;
    const duration = roundTripDuration(a, line);
    if (duration > a.freeTime) continue;
    const { value, fillWithin, fillOver } = roundTripValue(a, line);
    if (value <= 0) continue; // no rentable -> no se vuela (slot libre)
    const density = value / duration;
    if (!best || density > best.density) best = { line, duration, value, density, fillWithin, fillOver };
  }
  return best;
}

/** Aplica un vuelo: descuenta demanda/margen y tiempo, registra la asignacion. */
function commitTrip(a: Aircraft, cand: Candidate): void {
  for (const c of CLASSES) {
    cand.line.remaining[c] = Math.max(0, cand.line.remaining[c] - cand.fillWithin[c]);
    cand.line.over[c] += cand.fillOver[c];
  }
  a.freeTime -= cand.duration;
  a.assigned.push({
    lineId: cand.line.id,
    duration: cand.duration,
    within: { ...cand.fillWithin },
    over: { ...cand.fillOver },
    value: cand.value,
  });
}

/** Deshace un vuelo: devuelve demanda/margen y tiempo (para el grow-swap). */
function uncommitTrip(a: Aircraft, line: Line, trip: AssignedTrip): void {
  for (const c of CLASSES) {
    line.remaining[c] += trip.within[c];
    line.over[c] = Math.max(0, line.over[c] - trip.over[c]);
  }
  a.freeTime += trip.duration;
}

/**
 * Asignacion greedy global por densidad de valor.
 *
 * Mientras exista algun vuelo con valor positivo que quepa, se elige el de mayor
 * valor-por-segundo en toda la flota y se programa UN vuelo. Por el modelo de 3
 * niveles esto:
 *  - sirve primero la demanda mas rentable con los aviones mas eficientes,
 *  - reparte cada avion entre varias lineas si conviene,
 *  - prefiere rellenar demanda que quede (p.ej. 400 eco) antes que sobre-ofertar,
 *  - solo sobre-oferta de mas para llenar el avion al maximo (MAX_OCCUPANCY),
 *  - respeta alcance y tiempo semanal.
 */
function greedyAllocate(aircraft: Aircraft[], hubLines: Line[]): void {
  const fleet = aircraft.filter((a) => !(SKIP_RENTALS && a.isRental));
  const byId = new Map(fleet.map((a) => [a.id, a]));

  // Heap lazy: la densidad de un avion solo puede BAJAR cuando otro avion
  // consume demanda de su mejor linea. Por eso una entrada del heap es una cota
  // superior: al sacarla, recalculamos; si sigue igual es el maximo real y se
  // confirma; si bajo, se reinserta con la nueva densidad. La epoca descarta
  // entradas viejas de un avion que ya avanzo.
  const heap = new MaxHeap();
  const epoch = new Map<number, number>();
  const bump = (id: number) => {
    const e = (epoch.get(id) ?? 0) + 1;
    epoch.set(id, e);
    return e;
  };

  for (const a of fleet) {
    const c = bestLineFor(a, hubLines);
    if (c) heap.push({ key: c.density, id: a.id, epoch: bump(a.id) });
  }

  for (let top = heap.pop(); top; top = heap.pop()) {
    if (top.epoch !== epoch.get(top.id)) continue; // entrada superada
    const a = byId.get(top.id)!;
    const fresh = bestLineFor(a, hubLines);
    if (!fresh) continue; // ya no cabe nada para este avion
    if (fresh.density < top.key - 1e-6) {
      heap.push({ key: fresh.density, id: a.id, epoch: bump(a.id) }); // bajo: reinsertar
      continue;
    }
    commitTrip(a, fresh); // es el maximo real -> programar el vuelo
    const next = bestLineFor(a, hubLines);
    if (next) heap.push({ key: next.density, id: a.id, epoch: bump(a.id) });
  }
}

/**
 * RE-TESELADO (grow-swap + gap-fill) para acercar la utilizacion a ~100%.
 *
 * El greedy ya empaqueta hasta que no cabe ningun vuelo mas, pero deja huecos
 * mas cortos que cualquier ruta. Aqui, por cada avion:
 *   - GROW-SWAP: cambia un vuelo por otro MAS LARGO que quepa en el hueco (suele
 *     pagar mas: ruta mas larga = mas ingresos), reduciendo el espacio vacio.
 *   - GAP-FILL: si aun cabe algun vuelo en el hueco, lo añade.
 * Es consciente de la demanda (des-asigna y re-evalua), asi no rompe el reparto.
 */
function tightenPacking(aircraft: Aircraft[], lines: Map<number, Line>, candLines: Line[]): void {
  const fleet = aircraft.filter((a) => !(SKIP_RENTALS && a.isRental));

  for (const a of fleet) {
    for (let round = 0; round < TIGHTEN_ROUNDS; round++) {
      let improved = false;

      // GROW-SWAP: por cada vuelo, intentar cambiarlo por uno mas largo que llene mas.
      for (let i = 0; i < a.assigned.length; i++) {
        const trip = a.assigned[i];
        const oldLine = lines.get(trip.lineId)!;
        uncommitTrip(a, oldLine, trip); // libera tiempo y demanda

        // Buscar la mejor ruta mas larga que el vuelo actual y que quepa.
        let best: Candidate | null = null;
        for (const line of candLines) {
          if (!canFly(a, line)) continue;
          const duration = roundTripDuration(a, line);
          if (duration <= trip.duration || duration > a.freeTime) continue; // debe ser MAS larga y caber
          const { value, fillWithin, fillOver } = roundTripValue(a, line);
          const density = value / duration;
          if (!best || density > best.density) best = { line, duration, value, density, fillWithin, fillOver };
        }

        // Aceptar solo si no perdemos valor (ruta mas larga suele pagar mas).
        if (best && best.value >= trip.value) {
          commitTrip(a, best);
          a.assigned[i] = a.assigned[a.assigned.length - 1];
          a.assigned.pop(); // el nuevo vuelo quedo al final; quitamos el hueco del indice i
          improved = true;
        } else {
          // Restaurar el vuelo original tal cual.
          for (const c of CLASSES) {
            oldLine.remaining[c] = Math.max(0, oldLine.remaining[c] - trip.within[c]);
            oldLine.over[c] += trip.over[c];
          }
          a.freeTime -= trip.duration;
        }
      }

      // GAP-FILL: añadir cualquier vuelo que aun quepa en el hueco.
      let fill = bestLineFor(a, candLines);
      while (fill) {
        commitTrip(a, fill);
        improved = true;
        fill = bestLineFor(a, candLines);
      }

      if (!improved) break;
    }
  }
}

/**
 * Genera los takeOffTime de un avion: empaqueta los vuelos secuencialmente
 * desde t=0 y reparte el tiempo sobrante como holgura uniforme entre vuelos
 * (salidas mas regulares). Garantiza que no se solapen.
 */
function scheduleTimes(a: Aircraft): { takeOffTime: number; lineId: number }[] {
  const n = a.assigned.length;
  if (n === 0) return [];
  const used = a.assigned.reduce((s, t) => s + t.duration, 0);
  const slack = Math.max(0, WEEK_SECONDS - used);
  const gap = Math.floor(slack / n);

  const out: { takeOffTime: number; lineId: number }[] = [];
  let t = 0;
  for (const trip of a.assigned) {
    out.push({ takeOffTime: Math.round(t), lineId: trip.lineId });
    t += trip.duration + gap;
  }
  return out;
}

export interface OptimizationResult {
  plans: AircraftPlan[];
  /** Vuelos totales programados. */
  totalFlights: number;
}

/** Ejecuta el algoritmo completo y devuelve el plan por avion (sin enviarlo). */
export function optimize(aircraft: Aircraft[], lines: Map<number, Line>): OptimizationResult {
  // Los hubs son independientes (ningun avion vuela rutas de otro hub), asi que
  // optimizamos cada hub por separado: mismo resultado y mucho mas rapido.
  const hubIdx = linesByHub(lines);
  const byHub = new Map<number, Aircraft[]>();
  for (const a of aircraft) {
    const arr = byHub.get(a.hubId) ?? byHub.set(a.hubId, []).get(a.hubId)!;
    arr.push(a);
  }
  for (const [hubId, planes] of byHub) {
    const hubLines = hubIdx.get(hubId) ?? [];
    greedyAllocate(planes, hubLines); // sirve demanda rentable (slots no rentables quedan libres)
    tightenPacking(planes, lines, hubLines); // re-tesela hacia vuelos mas rentables
  }

  const plans: AircraftPlan[] = [];
  let totalFlights = 0;
  for (const a of aircraft) {
    const added = scheduleTimes(a);
    totalFlights += added.length;
    plans.push({ aircraftId: a.id, added });
  }
  return { plans, totalFlights };
}
