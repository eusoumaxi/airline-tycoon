/**
 * @fileoverview Load planning JSON: `--offline` cache or a live discover+fetch.
 */
import { discoverHubs, fetchAllPlannings } from "./api.ts";
import { DATA_DIR, ensureDataDir } from "./config.ts";
import { hasFlag } from "./flags.ts";
import type { Hub, PlanningPayload } from "./types.ts";

/**
 * Load every hub's planning.
 *
 * With `--offline`, reads `data/load_*.json` (`hubs` is then `undefined`).
 * Otherwise discovers hubs, fetches live JSON, and writes those snapshots.
 *
 * @returns `hubs` is set only on a live fetch (needed for `--apply` moves).
 */
export async function loadPlanning(): Promise<{
  hubs: Hub[] | undefined;
  payloads: PlanningPayload[];
}> {
  if (hasFlag("--offline")) {
    const glob = new Bun.Glob("load_*.json");
    const payloads: PlanningPayload[] = [];
    for await (const name of glob.scan(DATA_DIR)) {
      payloads.push(await Bun.file(`${DATA_DIR}/${name}`).json());
    }
    if (payloads.length === 0) {
      throw new Error(
        `No load_*.json in ${DATA_DIR}. Run once without --offline.`
      );
    }
    return { hubs: undefined, payloads };
  }

  const hubs = await discoverHubs();
  const payloads = await fetchAllPlannings(hubs.map((h) => h.loadId));
  await ensureDataDir();
  await Promise.all(
    hubs.map((hub, i) =>
      Bun.write(
        `${DATA_DIR}/load_${hub.loadId}.json`,
        JSON.stringify(payloads[i], null, 2)
      )
    )
  );
  return { hubs, payloads };
}
