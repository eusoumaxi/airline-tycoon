# Airline Tycoon — Optimizador de Slots

Sistema automático en **TypeScript + Bun** que descarga tu planning de
`tycoon.airlines-manager.com`, analiza **todas las rutas** y **cada avión** de
**todos tus hubs**, y calcula el **mejor reparto de slots** para tener los aviones
lo **más ocupados posible** (utilización ≈ 100%) maximizando el valor servido,
respetando qué avión puede volar qué ruta.

> ⚠️ **No envía ningún cambio al juego.** Solo descarga (`list`) y calcula. El
> `update` está implementado pero **nunca se llama**: revisas el plan y luego se
> aplica cuando tú quieras.

---

## 1. Cómo ejecutarlo

```bash
bun install            # una vez
bun run src/index.ts             # descubre tus hubs + descarga + optimiza + reporte
bun run src/index.ts --offline   # usa el último JSON descargado (sin red)
bun run src/index.ts --fetch-only# solo descarga y guarda el JSON
```

Salidas:
- Reporte por consola (análisis de rutas, flota, comparación, resumen por hub).
- `.test/data/load_<id>.json` — copia cruda de cada hub.
- `.test/data/proposed_plan.json` — **el plan propuesto**, ya en el formato del
  `update` (lista de `{aircraftId, added:[{takeOffTime, lineId}]}`).

---

## 2. La API del juego (de `.test/curl.md`)

| Acción | Endpoint | Uso aquí |
|---|---|---|
| **descubrir hubs** | `GET /network/planning` (HTML) | ✅ lee `data-hubId`/código/airportId de cada hub |
| **list** | `GET /network/planning/load/<id>` | ✅ rutas + aviones de un hub |
| **update** | `POST /network/planning/0/ajax` | ⛔ implementado, **no se llama** |
| reconfigure | `POST /aircraft/show/<id>/reconfigure` | (futuro: cambiar asientos) |

Todo se hace replicando el curl **exactamente**, incluido el `User-Agent` tal cual
(el juego lo valida). Credenciales (cookie + UA) en [`src/config.ts`](src/config.ts);
cuando la cookie caduque, pega el nuevo valor `-b '...'` ahí.

### Tus hubs (8, auto-descubiertos)
ADD · BOG · DXB · GRU · HKG · JFK · LAX · MIA → **~3.931 aviones, ~2.310 rutas**.

### ⚠️ Qué ruta es de qué hub (regla clave)
El `list` de un hub también devuelve rutas **ajenas** (que solo tocan el hub como
destino). Una ruta es **propia del hub solo si `airportOneId == hubAirportId`**
(el hub es el ORIGEN, el primer código del nombre):
- Cargando GRU → `GRU / ATM` es **propia** (origen GRU), `MIA / GRU` es **ajena**
  (es de MIA, solo termina en GRU) y se **descarta**.
Por eso un avión solo puede volar rutas de SU hub. Además: **alcance** (`range ≥
distancia`). Esas dos son las condiciones de `canFly()`.

### Demanda (confirmada DIARIA)
`paxAttEco/Bus/First/Cargo` es la demanda **por día** (la tabla "DEMANDA RESTANTE"
del juego la muestra Lunes..Domingo y coincide con `paxAtt*`). Por eso la demanda
semanal = `paxAtt × 7` (`DEMAND_DAYS`).

### Mecánica de tiempo (calibrada con tus datos)
- Semana de planning = **604.800 s** (7 días); `utilizationPercentage` = tiempo de
  vuelo / semana (verificado: cálculo 91,7% ≈ juego). 
- Duración ida+vuelta = `2·distancia/velocidad·3600 + turnaround` (~7.600 s,
  medido por avión).
- Aviones de pax llevan **carga** en bodega (`payloadUsed` t).

---

## 3. El algoritmo (`src/optimizer.ts`)

Cada hub se optimiza por separado (son independientes; ningún avión cruza de hub).

### Valor de un vuelo = BENEFICIO (ingresos − coste)
Volar asientos vacíos **pierde dinero** (combustible). Por eso el valor de un
vuelo es su **beneficio**:

```
valor = Σ_clase min(asientos, demanda_restante)·precio  −  COST_PER_KM·distancia·2
```

Solo cuenta la **demanda real** que llenaría; los asientos que sobran vuelan
vacíos y valen 0. Si `valor ≤ 0` (vuelo casi vacío) **NO se programa → el slot
queda libre**. Así la sobreoferta se acota sola (al agotarse la demanda, los
vuelos extra dejan de ser rentables) y *no se pierde plata en rutas sin
necesidad*. Aviones que no tengan ningún vuelo rentable quedan **sin usar**.

### Fase A — Greedy global por beneficio/segundo (heap lazy)
Programa, vuelo a vuelo, el de mayor **beneficio por segundo** de la flota del
hub, descontando demanda y tiempo. Usa una **cola de prioridad con invalidación
perezosa** (los beneficios solo bajan al consumirse demanda) → rápido incluso
con miles de aviones (~4 s los 8 hubs).

### Fase B — Re-teselado (más beneficio sin huecos innecesarios)
- **grow-swap**: cambia un vuelo por otro **más largo/rentable** que llene el hueco.
- **gap-fill**: añade vuelos rentables que aún quepan.

> Cargueros (`isCargo`, p.ej. 747-8F con 134 t y 0 asientos) se modelan igual: su
> beneficio sale de la **carga**. Los aviones de pax llevan además carga en bodega.

### Horarios (slots)
Los `takeOffTime` se reparten secuencialmente con la holgura distribuida →
salidas regulares y **sin solapes** dentro de la semana.

---

## 4. Parámetros ajustables (`src/config.ts`)

| Parámetro | Qué hace | Default |
|---|---|---|
| `AUTO_DISCOVER_HUBS` | Descubre y optimiza todos los hubs. | `true` |
| `DEMAND_DAYS` | Período de `paxAtt*` (diario → ×7). | `7` |
| `PRICING` | Precio por asiento/tonelada = `base + perKm·distancia`. | aprox. AM |
| `COST_PER_KM` | Coste del vuelo por km y sentido. ↑ = exige más ocupación (más slots libres). | `10` |
| `MIN_FILL` | Ocupación pax mínima para volar (salvaguarda). | `0` |
| `TIGHTEN_ROUNDS` | Rondas del re-teselado. | `4` |

> **`COST_PER_KM` es el mando clave**: subirlo deja más slots libres (no vuela
> vuelos poco llenos); bajarlo vuela más. Va emparejado con `PRICING` (ambos
> aproximados, afinables al audit del juego); el reparto relativo es robusto a la
> escala. La sobreoferta de **bus/first** en rutas de mucho eco son asientos
> premium vacíos en vuelos *rentables por el eco* — no pierden plata; se quitan
> con **reconfigure** (menos asientos premium), no con slots.

---

## 5. Resultados (8 hubs · 3.931 aviones · ~2.310 rutas)

| Métrica | ACTUAL | PROPUESTO |
|---|---|---|
| Utilización media | 91,7% | **99,8%** |
| Aviones volando | 3.509 | **3.930 / 3.931** |
| Aviones **sin usar** | 422 | **1** (el B727, sin ruta rentable) |
| Valor servido/semana | €47,1 B | **€65,7 B (+€18,6 B)** |
| Violaciones de hub | — | **0** |

Cada hub queda en **99%+** de utilización **rentable**. Donde no hay vuelo
rentable (demanda agotada / avión limitado por alcance) el slot queda **libre**
en vez de perder plata. La sobreoferta de pax desaparece; los asientos premium
vacíos en rutas de mucho eco son de *reconfigure*, no de slots.

### Artefacto HTML por hub
`bun run src/index.ts --hub BOG` genera `report_BOG.html` (autocontenido):
tarjetas de resumen, **aviones sin usar**, y por avión una **rejilla semanal
colapsable tipo el juego** (Lun→Dom × 0-23 h, cada vuelo un bloque del color real
de la ruta) con botones desplegar/colapsar y filtro.

---

## 6. Aplicar el plan (más adelante)

Recorre `proposed_plan.json` y llama por avión a `updatePlanning(plan)` de
[`src/api.ts`](src/api.ts) (un POST por avión). **Hoy esto no se ejecuta.**

---

## 7. Estructura

```
src/
  config.ts     credenciales (cookie/UA) + parámetros del modelo
  types.ts      tipos del dominio (hub, rutas, aviones, plan)
  api.ts        descubrir hubs + fetch del list (curl exacto) + updatePlanning (NO se llama)
  model.ts      hub de cada ruta, canFly (hub+alcance), duraciones, precios, demanda
  optimizer.ts  algoritmo: beneficio (ingresos−coste) + greedy (heap lazy) + re-teselado
  report.ts     análisis de rutas/flota, comparación, resumen por hub, aviones sin usar
  html.ts       artefacto HTML por hub (rejilla semanal colapsable tipo el juego)
  index.ts      orquestación: descubre → descarga → analiza → optimiza → reporta (+HTML)
```
