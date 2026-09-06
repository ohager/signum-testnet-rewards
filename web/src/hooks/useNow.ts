"use client";

import { useEffect, useState } from "react";

/**
 * The current time in epoch seconds, ticking after mount.
 *
 * Seeded from a server-supplied value rather than `Date.now()` so the FIRST
 * client render is byte-identical to the server's — every "3 minutes ago" on
 * the page is derived from this, and computing it from the browser clock on the
 * initial render would produce a hydration mismatch on every visit.
 *
 * After mount it takes over from the real clock, so relative times keep ageing
 * between polls instead of freezing at whatever the last fetch said.
 */
export function useNow(serverNow: number, intervalMs = 10_000): number {
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
