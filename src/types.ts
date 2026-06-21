// ───────────────────────────────────────────────────────────────────────────
// Tipos del dominio (respuesta de /network/planning/load/<id>)
// ───────────────────────────────────────────────────────────────────────────

/** Una linea/ruta tal como la entrega la API. */
export interface RawLine {
  id: number;
  name: string; // "BOG / CCS"
  airportOneId: number;
  airportTwoId: number;
  distance: number; // km (un sentido)
  baseDuration: number; // s, referencia del juego
  category: number; // 1..10
  paxAttEco: number; // pax esperados ECO  (ver DEMAND_DAYS para el periodo)
  paxAttBus: number; // pax esperados BUS
  paxAttFirst: number; // pax esperados FIRST
  paxAttCargo: number; // demanda de carga
  color: string;
}

/** Un vuelo dentro del planning semanal de un avion. */
export interface PlanningSlot {
  takeOffTime: number; // s desde el inicio de la semana (0..604800)
  lineId: number;
  aircraftId: number;
}

/** Un avion tal como lo entrega la API. */
export interface RawAircraft {
  id: number;
  name: string;
  hubId: number;
  category: number;
  range: number; // km (alcance, un sentido)
  isRental: boolean;
  isCargo: boolean;
  seatsEco: number;
  seatsBus: number;
  seatsFirst: number;
  payloadUsed: number; // toneladas de carga (bodega) por vuelo
  consumption: number;
  utilizationPercentage: number; // % de tiempo de la semana ya ocupado
  aircraftListName: string; // modelo, "A350-1000"
  picture: string;
  speed: number; // km/h
  planningList: PlanningSlot[];
  lineList: Record<string, { name: string; color: string; distance: number; duration: number }>;
}

/** Respuesta completa del endpoint de carga del planning. */
export interface PlanningPayload {
  hubAirportId: number;
  lineDataArray: RawLine[];
  aircraftDataArray: RawAircraft[];
}

// ───────────────────────────────────────────────────────────────────────────
// Tipos del modelo enriquecido (lo que usa el optimizador)
// ───────────────────────────────────────────────────────────────────────────

export type CabinClass = "eco" | "bus" | "first" | "cargo";

/** Un hub (base) descubierto desde la pagina de planning. */
export interface Hub {
  loadId: number; // id para /network/planning/load/<loadId>
  code: string; // "BOG"
  airportId: number; // 156  (== hubAirportId del payload y aircraft.hubId)
}

export interface Line extends RawLine {
  /**
   * Hub propietario de la ruta (== airportOneId == aircraft.hubId que la vuela).
   * El endpoint de un hub tambien devuelve rutas AJENAS (donde el hub es el
   * destino, airportTwoId); esas se descartan al construir el modelo.
   */
  hubId: number;
  /** Demanda semanal restante por clase (se va consumiendo en el optimizador). */
  remaining: Record<CabinClass, number>;
  /** Demanda semanal total por clase (constante de referencia). */
  weeklyDemand: Record<CabinClass, number>;
  /** Asientos ya sobre-ofertados por clase (por encima de la demanda). */
  over: Record<CabinClass, number>;
  /** Precio estimado por asiento/tonelada (un sentido) segun distancia. */
  price: Record<CabinClass, number>;
}

/** Un vuelo ya asignado a un avion, con su aporte para poder des-asignarlo. */
export interface AssignedTrip {
  lineId: number;
  duration: number;
  within: Record<CabinClass, number>; // asientos servidos dentro de demanda
  over: Record<CabinClass, number>; // asientos sobre-ofertados
  value: number; // valor del vuelo al asignarlo
}

export interface Aircraft extends RawAircraft {
  /** Turnaround inferido para este avion (s). */
  turnaround: number;
  /** Tiempo libre restante en la semana (s). */
  freeTime: number;
  /** Vuelos asignados por el optimizador (en orden). */
  assigned: AssignedTrip[];
}

/** Resultado: un slot propuesto para un avion (formato listo para el update). */
export interface ProposedFlight {
  takeOffTime: number;
  lineId: number;
}

export interface AircraftPlan {
  aircraftId: number;
  added: ProposedFlight[];
}
