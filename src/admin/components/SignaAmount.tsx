const cn = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

const PLANCK_PER_SIGNA = 100_000_000n;

/**
 * Renders a planck value as SIGNA, with the fractional part de-emphasised.
 *
 * Takes planck as a string because it crosses a JSON boundary, and formats via
 * BigInt so no float rounding is involved regardless of magnitude.
 */
export function SignaAmount({
  planck,
  decimals = 2,
  className,
}: {
  planck: string;
  decimals?: number;
  className?: string;
}) {
  const value = BigInt(planck);
  const whole = value / PLANCK_PER_SIGNA;
  const frac = (value % PLANCK_PER_SIGNA).toString().padStart(8, "0").slice(0, decimals);
  return (
    <span className={cn("tabular-nums", className)}>
      {new Intl.NumberFormat().format(whole)}
      <span style={{ fontSize: "0.65em", opacity: 0.6 }}>.{frac}</span>
    </span>
  );
}
