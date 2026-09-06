"use client";

import { Card, CardLabel, CardSub } from "@/components/Card";

/**
 * The route-level error boundary.
 *
 * Reaching this means the Turso read threw — an expired token, a deleted
 * database, an outage. The page says so plainly instead of showing zeroes:
 * "0 SIGNA pending" and "we could not reach the database" look identical to a
 * miner otherwise, and only one of them is a reason to worry.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="page-layout">
      <Card>
        <CardLabel>Status unavailable</CardLabel>
        <p className="text-[var(--amber)]">
          The published status could not be read just now.
        </p>
        <CardSub>
          This page reports a snapshot published by the rewards service. Failing to read it says
          nothing about whether the service itself is running, and no rewards are affected.
        </CardSub>
        <button
          onClick={reset}
          className="mt-4 px-3 py-1 text-[10px] uppercase tracking-[2px]"
          style={{ color: "var(--blue2)", border: "1px solid var(--border2)" }}
        >
          Try again
        </button>
      </Card>
    </main>
  );
}
