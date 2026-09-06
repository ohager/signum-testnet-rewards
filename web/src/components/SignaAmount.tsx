import { formatSigna } from "@/lib/format";

const cn = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

/**
 * Renders a planck value as SIGNA, with the fractional part de-emphasised.
 *
 * Takes a bigint rather than the admin panel's string: this side decodes rows
 * itself, so the value is already exact by the time it reaches a component and
 * there is no JSON boundary to serialise across.
 */
export function SignaAmount({
  planck,
  decimals = 2,
  className,
}: {
  planck: bigint;
  decimals?: number;
  className?: string;
}) {
  const { whole, fraction } = formatSigna(planck, decimals);
  return (
    <span className={cn("tabular-nums", className)}>
      {whole}
      <span style={{ fontSize: "0.65em", opacity: 0.6 }}>.{fraction}</span>
    </span>
  );
}
