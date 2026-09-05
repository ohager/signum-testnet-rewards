import { ChainTime } from "@signumjs/util";
import type { ChainDay } from "./types.ts";

/**
 * Maps a Signum chain timestamp (seconds since genesis) to its UTC calendar day.
 *
 * Cap accounting buckets on this rather than wall-clock time so that a catch-up
 * after an outage attributes blocks to the day they were actually mined.
 */
export function toChainDay(chainTimestamp: number): ChainDay {
  const date = ChainTime.fromChainTimestamp(chainTimestamp).getDate();
  return date.toISOString().slice(0, 10);
}
