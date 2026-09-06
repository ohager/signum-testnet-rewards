const PLANCK_PER_SIGNA = 100_000_000n;

/**
 * Formats planck as SIGNA.
 *
 * BigInt throughout: planck values are exact integers and a float conversion
 * would start losing the low digits above ~90M SIGNA. Splitting the fraction
 * out lets the UI de-emphasise it without a second parse.
 */
export function formatSigna(planck: bigint, decimals = 2): { whole: string; fraction: string } {
  const negative = planck < 0n;
  const value = negative ? -planck : planck;
  const whole = new Intl.NumberFormat("en-US").format(value / PLANCK_PER_SIGNA);
  const fraction = (value % PLANCK_PER_SIGNA).toString().padStart(8, "0").slice(0, decimals);
  return { whole: negative ? `-${whole}` : whole, fraction };
}

const UNITS: [limit: number, seconds: number, name: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [2_592_000, 86_400, "day"],
  [31_536_000, 2_592_000, "month"],
  [Infinity, 31_536_000, "year"],
];

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * "3 minutes ago" / "in 2 hours" from epoch SECONDS.
 *
 * Every timestamp in the read-model is epoch seconds — the service converts
 * chain time before publishing — so nothing downstream has to know that two
 * time bases exist.
 */
export function relativeTime(epochSeconds: number, nowSeconds: number): string {
  const delta = epochSeconds - nowSeconds;
  const magnitude = Math.abs(delta);
  for (const [limit, divisor, unit] of UNITS) {
    if (magnitude < limit) return RELATIVE.format(Math.round(delta / divisor), unit);
  }
  return RELATIVE.format(Math.round(delta / 31_536_000), "year");
}

/** Epoch seconds as a fixed UTC stamp, for tooltips where "ago" is too vague. */
export function absoluteTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** Shortens an account id for display without hiding enough to be ambiguous. */
export function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/**
 * "in 5h 38m" / "12m ago" from epoch SECONDS.
 *
 * Where `relativeTime` rounds to one unit — "in 6 hours" for anything from 5h30
 * to 6h29 — this keeps the hours AND the minutes, which is what a schedule
 * needs: a miner waiting on the next cycle wants to know it is 5h 38m away, not
 * roughly six hours. Still coarse below the minute, because the runner promises
 * a schedule and not a second-accurate countdown.
 *
 * Days are split out so an old timestamp reads as "3d 4h" rather than "76h 12m".
 */
export function countdown(epochSeconds: number, nowSeconds: number): string {
  const delta = epochSeconds - nowSeconds;
  const minutes = Math.floor(Math.abs(delta) / 60);
  const hours = Math.floor(minutes / 60);
  const text =
    hours >= 24
      ? `${Math.floor(hours / 24)}d ${hours % 24}h`
      : hours > 0
        ? `${hours}h ${minutes % 60}m`
        : `${minutes}m`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

/**
 * Formats planck as SIGNA for prose: "1", "10", "0.5".
 *
 * Where `formatSigna` pads to a fixed width so figures line up down a column,
 * this trims trailing zeros. A rule reads as a rule — "1 SIGNA a block" — while
 * "1.00 SIGNA a block" reads as a measurement of something that varies.
 */
export function formatSignaPlain(planck: bigint): string {
  const { whole, fraction } = formatSigna(planck, 8);
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}
