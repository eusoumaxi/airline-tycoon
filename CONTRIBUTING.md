# Contributing

This is a clone-and-run Bun CLI (not published to npm). Fork, patch, open a pull request against `main`.

## Setup

```bash
git clone https://github.com/eusoumaxi/airline-tycoon.git
cd airline-tycoon
bun install
cp .env.example .env
```

Put a session cookie in `.env` (`AM_COOKIE`). Never commit `.env` or any cookie, hub ID, or planning JSON.

```bash
bun run check    # Ultracite / Biome
bun run fix      # auto-fix
```

There is no test suite. Check a change with `bun run optimize -- --offline` against a saved snapshot, then a dry-run command (no `--apply`) before any live write.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/` | Shared library: HTTP, model, optimizer, reports |
| `src/cli/` | One entry file per `package.json` script |
| `src/lib/config.ts` | Env vars and optimizer knobs |
| `src/lib/types.ts` | Domain types (API payloads + optimizer model) |
| `data/` | Local snapshots and HTML (gitignored) |

`src/lib` must stay free of `process.argv` except `flags.ts` / `io.ts` (offline cache). Game writes live only in CLI files that require `--apply`.

## Flows

**Read (safe):** cookie → `discoverHubs` → `fetchPlanning` → `buildModel` → `optimize` / `rebalanceNetwork` / `buildHubAdvice` → HTML + JSON under `data/`.

**Write (opt-in):** same as read, then `updatePlanning`, `moveAircraftHub`, `buyRoute`, or `sellLine`. Default is dry-run.

Hubs are discovered from the game. Do not hardcode airport or load IDs.

## Comments

English only. Third person. Write for the next contributor, not as a diary.

- Every module starts with `@fileoverview`.
- Every **exported** function, constant, and type gets JSDoc: what it does, side effects, and game constraints (900 s grid, daily demand, CSRF, in-flight moves).
- CLI files document usage with `@example` (`bun run … -- --flag`).
- Skip comments that restate the next line. Keep “why” comments for non-obvious game behaviour.
- Do not mention “the bug we fixed”, “the player asked”, or numbered internal scripts.

## Pull requests

- Small, focused diffs.
- Run `bun run check` before opening the PR.
- Do not add dependencies for something a few lines of TypeScript already do.
- Do not commit `data/`, `.env`, or personal airline stats.

## Release

Not on npm. Users install from GitHub:

```bash
git clone https://github.com/eusoumaxi/airline-tycoon.git
```

To cut a version: bump `version` in `package.json`, tag `vX.Y.Z`, push the tag, create a GitHub Release. MIT license already covers reuse.
