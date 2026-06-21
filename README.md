# Airline Tycoon — Slot Optimizer

Automatic tool (**TypeScript + Bun**) that downloads your planning from
`tycoon.airlines-manager.com`, analyzes **every route** and **every aircraft**
across **all your hubs**, and computes the **best slot allocation** to keep
aircraft as busy as possible while **maximizing profit** (it won't fly money‑losing
flights). It can then **apply** the plan back to the game, one aircraft at a time.

> Reading the game (`list`) and computing the plan never changes anything.
> Pushing changes only happens when you explicitly run `apply --apply`.

---

## 1. Quick start

```bash
bun install                         # once

# Optimize (read-only) — analysis + proposed plan + HTML reports
bun run optimize                    # discover hubs, download, optimize, report
bun run offline                     # reuse the last downloaded JSON (no network)
bun run src/index.ts --hub GRU      # only build the HTML report for one hub

# Apply the plan to the game (push the updates)
bun run apply                       # DRY RUN for the hub(s) in APPLY_HUBS (GRU) — sends nothing
bun run apply --hub GRU             # DRY RUN for a chosen hub
bun run apply:live                  # actually SEND the updates (live) for APPLY_HUBS
bun run src/apply.ts --hub GRU --apply   # send live for a chosen hub
```

Outputs (in `.test/data/`):
- `load_<id>.json` — raw download per hub.
- `proposed_plan.json` — the proposed plan, already in the update format
  (`[{aircraftId, added:[{takeOffTime, lineId}]}]`).
- `report_<CODE>.html` — self‑contained visual report per hub (see §6).

---

## 2. The game API (from `.test/curl.md`)

| Action | Endpoint | Used here |
|---|---|---|
| **discover hubs** | `GET /network/planning` (HTML) | reads `data-hubId`/code/airportId of each hub |
| **list** | `GET /network/planning/load/<id>` | routes + aircraft of a hub |
| **update** | `POST /network/planning/0/ajax` | push one aircraft's planning (used by `apply`) |
| reconfigure | `POST /aircraft/show/<id>/reconfigure` | (future: change seat layout) |

Everything replicates the curl **exactly**, including the `User-Agent` as‑is (the
game validates it). Credentials (cookie + UA) live in [`src/config.ts`](src/config.ts);
when the cookie expires, paste the new `-b '...'` value there.

### Your hubs (8, auto‑discovered)
ADD · BOG · DXB · GRU · HKG · JFK · LAX · MIA → **~3,931 aircraft, ~2,310 routes**.

### What an aircraft may fly — `canFly()` (3 hard rules)
1. **Own hub**: a hub's `list` also returns **foreign** routes (that only touch
   the hub as destination). A route is owned only if `airportOneId == hubAirportId`
   (the hub is the ORIGIN, first code in the name). Loading GRU → `GRU / ATM` is
   owned; `MIA / GRU` is MIA's and is dropped. An aircraft only flies its hub's routes.
2. **Range**: `range ≥ distance` (one way).
3. **Runway / airport size**: `line.category ≥ aircraft.category`. Bigger aircraft
   need bigger airports — a small airport rejects them (*"l'avion a besoin de plus
   grande pistes"*). Verified against every real flown pair. **If even one flight
   breaks any rule, the game rejects the WHOLE aircraft update.**

### takeOffTime granularity (15 min)
Every `takeOffTime` must be a **multiple of 900 s** or the update is rejected
(*"ne respecte pas la granularité… TakeOffTime % 900 != 0"*). The scheduler works
on a 900 s grid and round-trip durations are rounded up to a whole slot, so flights
never overlap or over-subscribe the week.

### Demand (confirmed DAILY)
`paxAttEco/Bus/First/Cargo` is **per‑day** demand (the game's "REMAINING DEMAND"
table shows it Mon..Sun, matching `paxAtt*`). So weekly demand = `paxAtt × 7`
(`DEMAND_DAYS`).

### Time mechanics (calibrated from your data)
- Planning week = **604,800 s** (7 days); `utilizationPercentage` = flight time /
  week (verified: computed 91.7% ≈ game).
- Round‑trip duration = `2·distance/speed·3600 + turnaround` (~7,600 s, measured
  per aircraft).
- Passenger aircraft also carry **cargo** in the belly (`payloadUsed` t).

---

## 3. The algorithm (`src/optimizer.ts`)

Each hub is optimized independently (no aircraft crosses hubs).

### Flight value = PROFIT (revenue − cost)
Flying empty seats **loses money** (fuel). So a flight's value is its **profit**:

```
value = Σ_class min(seats, remaining_demand)·price  −  COST_PER_KM·distance·2
```

Only the **real demand** it fills earns; leftover seats fly empty and earn 0. If
`value ≤ 0` (a near‑empty flight) it is **NOT scheduled → the slot is left free**.
This caps oversupply on its own (once demand runs out, extra flights stop being
profitable) and avoids losing money. Aircraft with no profitable flight are left
**unused**.

### Phase A — Greedy by profit/second (lazy heap)
Schedules, flight by flight, the highest **profit‑per‑second** of the hub fleet,
subtracting demand and time. Uses a **priority queue with lazy invalidation**
(profits only drop as demand is consumed) → fast even with thousands of aircraft
(~4 s for all 8 hubs).

### Phase B — Tighten (more profit, less idle)
- **grow‑swap**: replace a flight with a longer/more profitable one that fits the gap.
- **gap‑fill**: add profitable flights that still fit.

> Freighters (`isCargo`, e.g. 200× 747‑8F with 134 t and 0 seats) are modeled the
> same: their profit comes from **cargo**. Passenger aircraft add belly cargo on top.

### Schedule (slots)
`takeOffTime`s are spread with uniform slack plus a **per‑aircraft pseudo‑random
phase offset** (deterministic): not everything starts Monday 00:00 — each aircraft
begins at a different point of the week and aircraft on the same route are
staggered. Uniform spread (~equal flights per day/hour), **no overlaps**; a flight
may cross the weekend (the game allows it).

---

## 4. Apply / reload (`src/apply.ts`)

`apply` re‑fetches, re‑optimizes and **pushes** the plan to the game — so
re‑running it is a full **reload**, handy after you buy new routes or aircraft.

- **Dry run by default** (`bun run apply`) — prints exactly what would be sent,
  sends nothing. Add `--apply` to send live.
- **Scope**: `APPLY_HUBS` in config (currently `["GRU"]`) or `--hub <CODE>`.
- **Random 5–10 s delay** between each aircraft update (`MIN_DELAY_MS` /
  `MAX_DELAY_MS`) — looks human and avoids rate limits.
- The update **replaces** that aircraft's whole planning (not additive). The game
  answers `{"result":true}` on success or a plain-text reason on rejection; both
  are checked, so a rejected aircraft is reported as `✗ FAIL` with the reason.

> **Verified live on GRU**: all 4 aircraft applied (131 flights), categories valid,
> 900 s grid, no overlap. Re-fetching confirms the planning matches what was sent.

```bash
bun run apply               # dry run, GRU
bun run apply:live          # live, GRU
```

---

## 5. Tunable parameters (`src/config.ts`)

| Parameter | What it does | Default |
|---|---|---|
| `AUTO_DISCOVER_HUBS` | Discover and optimize all hubs. | `true` |
| `APPLY_HUBS` | Hubs that `apply` pushes by default. | `["GRU"]` |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | Random delay between aircraft updates. | `5000` / `10000` |
| `DEMAND_DAYS` | Period of `paxAtt*` (daily → ×7). | `7` |
| `PRICING` | Price per seat/ton = `base + perKm·distance`. | approx. AM |
| `COST_PER_KM` | Flight cost per km/leg. ↑ = demand higher load (more free slots). | `10` |
| `MIN_FILL` | Minimum pax load factor to fly (safeguard). | `0` |
| `TIGHTEN_ROUNDS` | Tighten passes. | `4` |

> `COST_PER_KM` is the key knob: raise it to leave more slots free (won't fly
> poorly‑filled flights); lower it to fly more. It pairs with `PRICING` (both
> approximate, tune to the game's audit); the relative allocation is robust to scale.
> Leftover **bus/first** on eco‑heavy routes are empty premium seats on flights
> that are **profitable from eco** — they don't lose money; remove them with
> **reconfigure** (fewer premium seats), not with slots.

---

## 6. HTML report per hub

`bun run src/index.ts --hub BOG` writes `report_BOG.html` (self‑contained):
summary cards, **unused aircraft**, and per aircraft a **collapsible game‑style
weekly grid** (Mon→Sun × 0‑23 h, each flight a block in the route's real color).
Expanding an aircraft shows **● Current vs ● Proposed** side by side (the
transition). Includes expand/collapse‑all buttons and an aircraft/route filter.

---

## 7. Results (8 hubs · 3,931 aircraft · ~2,310 routes)

| Metric | CURRENT | PROPOSED |
|---|---|---|
| Average utilization | 91.7% | **99.8%** |
| Flying aircraft | 3,509 | **3,930 / 3,931** |
| **Unused** aircraft | 422 | **1** (the B727, no profitable route) |
| Served value/week | €47.1 B | **€65.7 B (+€18.6 B)** |
| Hub violations | — | **0** |

Where there is no profitable flight (demand exhausted / range‑limited aircraft)
the slot is left **free** instead of losing money.

---

## 8. Project layout

```
src/
  config.ts     credentials (cookie/UA) + model & apply parameters
  types.ts      domain types (hub, routes, aircraft, plan)
  api.ts        discover hubs + list fetch (exact curl) + updatePlanning
  model.ts      route ownership, canFly (hub+range), durations, pricing, demand
  optimizer.ts  profit model + greedy (lazy heap) + tighten + scheduling
  report.ts     route/fleet analysis, comparison, per-hub summary, unused aircraft
  html.ts       per-hub HTML artifact (collapsible game-style weekly grid)
  index.ts      orchestration: discover → download → analyze → optimize → report (+HTML)
  apply.ts      push the plan to the game (dry-run default, random delay, reload)
```
