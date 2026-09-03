/**
 * @fileoverview Console and HTML number helpers.
 */
/** Integer thousands, e.g. `12,345`. */
export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Fraction as a percentage string, e.g. `94.2%`. */
export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** USD display. */
export function moneyUsd(n: number): string {
  return `$${fmt(n)}`;
}

/** Escape text for HTML attributes and bodies. */
export function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c
  );
}
