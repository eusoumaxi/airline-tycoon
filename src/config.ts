// ───────────────────────────────────────────────────────────────────────────
// Configuracion. Edita aqui cookies/credenciales y los parametros del modelo.
// ───────────────────────────────────────────────────────────────────────────

export const BASE_URL = "https://tycoon.airlines-manager.com";

/**
 * Si true, descubre TODOS tus hubs leyendo /network/planning (recomendado).
 * Cada avion queda restringido a las rutas de SU hub automaticamente.
 * Si false, se usan los PLANNING_IDS de abajo.
 */
export const AUTO_DISCOVER_HUBS = true;

/**
 * IDs de planning a cargar (uno por hub) si AUTO_DISCOVER_HUBS = false.
 * El numero que aparece en /network/planning/load/<id> (= data-hubId).
 * Tus hubs: ADD 9357042 · BOG 9572489 · DXB 3858219 · GRU 17462623 ·
 *           HKG 8817303 · JFK 4745504 · LAX 4305752 · MIA 4122142
 */
export const PLANNING_IDS = [9572489];

/** User-Agent EXACTO del curl (no cambiar: el juego lo valida). */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * Cookie de sesion. Pega aqui el valor `-b '...'` del curl cuando caduque.
 * REMEMBERME + PHPSESSID son los que autentican; AWSALB rota solo.
 */
export const COOKIE =
  "REMEMBERME=Am.GameBundle.Entity.Player%3AZGF2aWRtYXhpbWlsaWFub2xhcmFAZ21haWwuY29t%3A1813540149%3A5_bC4xxNLHKJqqonMg9NPyv2k3Ps0DA5GAzkNjuXKe0~_iVMxwVlDK2RKU6CaDRqc10vC4D2fgz5joB6YspV75U~; PHPSESSID=4rfcb31qiq79blfd60qtvsal7r";

// ───────────────────────────────────────────────────────────────────────────
// Mecanica del juego (calibrada con los datos reales)
// ───────────────────────────────────────────────────────────────────────────

/** Segundos en una semana de planning. */
export const WEEK_SECONDS = 604800;

/** Turnaround por defecto (s) si no se puede inferir del avion. ~7600 medido. */
export const DEFAULT_TURNAROUND = 7600;

// ───────────────────────────────────────────────────────────────────────────
// Parametros del modelo economico — AJUSTA segun el audit del juego.
// El optimizador es robusto a la escala: estos pesos definen el ORDEN
// relativo de valor entre clases y rutas, que es lo que decide la asignacion.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Periodo de la demanda `paxAtt*`. CONFIRMADO: es demanda DIARIA (la tabla
 * "DEMANDA RESTANTE" del juego la muestra por dia, Lunes..Domingo, y coincide
 * con paxAtt*). Por tanto la demanda semanal = paxAtt * 7.
 */
export const DEMAND_DAYS = 7;

/**
 * Precio estimado por asiento (un sentido) = base + perKm * distanciaKm.
 * Valores aproximados estilo Airlines Manager (First > Bus > Eco).
 * Carga: precio por tonelada (un sentido).
 */
export const PRICING = {
  eco: { base: 35, perKm: 0.2 },
  bus: { base: 60, perKm: 0.4 },
  first: { base: 90, perKm: 0.6 },
  cargo: { base: 40, perKm: 0.25 }, // por tonelada
} as const;

/** Un vuelo es ida+vuelta: ambos tramos generan ingresos. */
export const LEGS_PER_ROUNDTRIP = 2;

// ── Modelo de BENEFICIO (ingresos − coste) ──────────────────────────────────
// Volar asientos vacios PIERDE dinero (combustible). Por eso el valor de un
// vuelo es su BENEFICIO: ingresos de la DEMANDA REAL que llena menos el coste
// del vuelo. Si sale <= 0 (vuelo casi vacio) NO se programa -> el slot queda
// libre. Asi la sobreoferta se acota sola (al agotarse la demanda los vuelos
// dejan de ser rentables) y no se pierde plata en rutas sin necesidad.

/**
 * Coste del vuelo por km y por sentido (combustible+tasas), en las mismas
 * unidades que PRICING. coste_vuelo = COST_PER_KM * distancia * 2 (ida+vuelta).
 * Calibrado para que: un vuelo que solo llevaria carga de bodega (pax vacio)
 * salga negativo y NO se vuele, pero uno que sirve demanda real si. Subelo para
 * exigir mas ocupacion (mas slots libres); bajalo para volar mas.
 */
export const COST_PER_KM = 10;

/**
 * Margen pequeno de sobreoferta tolerada: un vuelo aun se considera si llena al
 * menos esta fraccion de su capacidad con demanda real (evita micro-vuelos que
 * solo sirven 2 pax). Es una salvaguarda; el beneficio ya hace casi todo.
 */
export const MIN_FILL = 0;

/** Valor residual (fraccion del precio) de la sobreoferta en modo anti-idle. */
export const OVERSUPPLY_EPSILON = 0.01;

/**
 * Rondas del pase de RE-TESELADO (grow-swap + gap-fill) que acerca la
 * utilizacion a ~100% cambiando vuelos por otros mas largos que llenen el hueco.
 * Mas rondas = empaquetado mas apretado (rendimientos decrecientes).
 */
export const TIGHTEN_ROUNDS = 4;

/** No mover aviones de alquiler (suelen tener configuracion fija). */
export const SKIP_RENTALS = false;
