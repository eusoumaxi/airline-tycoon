/**
 * @fileoverview `process.argv` helpers shared by every CLI entry.
 */

/** Whether `flag` is present on `process.argv`. */
export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/**
 * Value immediately after `flag`.
 *
 * @example argValue("--hub") // "LHR" from `--hub LHR`
 */
export function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Numeric flag, or `fallback` when omitted. */
export function argNumber(flag: string, fallback: number): number {
  const v = argValue(flag);
  return v === undefined ? fallback : Number(v);
}
