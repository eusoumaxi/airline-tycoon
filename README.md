# Airline Tycoon

Unofficial slot optimizer for [Airlines Manager](https://tycoon.airlines-manager.com). It downloads your weekly planning, assigns flights to maximize economy coverage without losing money, and can push the new schedules back to the game.

This project is **not affiliated** with Airlines Manager or its publishers. Use at your own risk. Game writes are opt-in (`--apply`). Reads never change anything.

## Install

Requires [Bun](https://bun.sh) 1.1+. Clone and run from source (not published to npm):

```bash
git clone https://github.com/eusoumaxi/airline-tycoon.git
cd airline-tycoon
bun install
cp .env.example .env
```

Paste a logged-in session cookie into `.env`:

```
AM_COOKIE=REMEMBERME=…; PHPSESSID=…
```

Copy it from DevTools → Network → any request → Cookie header. **Never commit `.env`.** When the cookie expires, update `AM_COOKIE` and run again.

## Quick start

```bash
bun run optimize                  # download, plan, write HTML under data/
bun run apply -- --hub LHR        # dry-run the POSTs
bun run apply -- --hub LHR --apply
```

Reports land in `data/` (gitignored). Override with `AM_DATA_DIR`.

## How it works

```
AM_COOKIE
    │
    ▼
discoverHubs()         GET /network/planning
    │
    ▼
fetchPlanning()        GET /network/planning/load/<id>
    │
    ▼
buildModel()           owned routes only (origin = hub)
                       canFly = same hub + range + airport category
    │
    ├─ optimize()            per-hub greedy eco coverage
    ├─ rebalanceNetwork()    virtual hub moves, then greedyAllocate
    └─ buildHubAdvice()      buy / reconfigure / surplus suggestions
    │
    ▼  only with --apply
updatePlanning()       POST weekly slots
moveAircraftHub()      POST hub change (CSRF; fails if in flight)
buyRoute() / sellLine()
```

1. **Discover** hubs from the planning page (nothing hardcoded).
2. **Snapshot** each hub to `data/load_<id>.json` so `--offline` can replay.
3. **Model** drops foreign routes (this hub is destination, not origin). Demand (`paxAtt*`) is **daily** — seven independent pools.
4. **Optimize** each hub independently on a 900-second grid: eco fill, per-day overshoot cap, utilisation floor, sell threshold.
5. **Apply** is dry-run until `--apply`. Aircraft in flight cannot change hub; re-run after they land.

Tune knobs in [`src/lib/config.ts`](src/lib/config.ts) (`UTIL_FLOOR`, `ECO_OVERSHOOT_CAP`, `SELL_THRESHOLD`, `BUY_CATALOG`).

## Layout

```
src/lib/     shared library (HTTP, model, optimizer, reports)
src/cli/     one file per package.json script
data/        local snapshots and HTML (gitignored)
```

| Module | Responsibility |
| --- | --- |
| [`config.ts`](src/lib/config.ts) | Env and optimizer knobs |
| [`types.ts`](src/lib/types.ts) | API payloads + optimizer model |
| [`api.ts`](src/lib/api.ts) | Game HTTP |
| [`model.ts`](src/lib/model.ts) | `buildModel`, `canFly`, durations |
| [`optimizer.ts`](src/lib/optimizer.ts) | `optimize` / `greedyAllocate` |
| [`recommend.ts`](src/lib/recommend.ts) | Buy / surplus advice |
| [`rebalance.ts`](src/lib/rebalance.ts) | Cross-hub assignment |
| [`move.ts`](src/lib/move.ts) | Relocate one aircraft |
| [`io.ts`](src/lib/io.ts) | Live download or `--offline` cache |

## CLI

Extra flags go after `--`. Mutating commands are dry-run until `--apply`. `buyroute --buy` spends in-game money.

| Command | Effect |
| --- | --- |
| `bun run optimize` | Discover, download, optimize, write HTML |
| `bun run optimize -- --hub LHR` | One hub |
| `bun run offline` | Reuse `data/load_*.json` |
| `bun run fetch` | Download only |
| `bun run apply -- --hub LHR --apply` | Push schedules |
| `bun run buyroute -- --hub LHR --country gb` | Rank buyable routes |
| `bun run buyroute -- --hub LHR --buy cdg` | Purchase `LHR→CDG` |
| `bun run rebalance` | Cross-hub HTML report |
| `bun run rebalance:apply -- --hub LHR --apply` | Move aircraft + push plans |
| `bun run move-surplus -- --apply` | Move idle surplus |
| `bun run move-hub -- --from LHR --to CDG --apply` | Relocate a whole hub |
| `bun run sell-routes -- --apply` | Close routes tagged `SELL` |

After a hub move, run `bun run apply -- --hub <DEST> --apply`. A plane cannot take a new schedule the same instant it changes hub.

| Flag | Meaning |
| --- | --- |
| `--offline` | Read cached JSON (cannot combine with `--apply`) |
| `--hub CODE` | Restrict to one IATA hub |
| `--apply` | Send writes |
| `--concurrency N` | Parallel POSTs (keep move concurrency low) |
| `--from` / `--to` | Source / destination hub |

## Environment

| Variable | Purpose |
| --- | --- |
| `AM_COOKIE` | Session cookie (required) |
| `AM_USER_AGENT` | Override Chrome UA if the game rejects the default |
| `AM_APPLY_HUBS` | Default hubs for `apply` when `--hub` is omitted |
| `AM_DATA_DIR` | Snapshot directory (default `data`) |
| `AM_SKIP_RENTALS` | `1` to ignore rental aircraft |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture, JSDoc conventions, and how releases work.

```bash
bun run check
bun run fix
```

## License

[MIT](LICENSE) © David Lara
