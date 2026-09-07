import type { HealthCondition, HealthAlertKind } from "./healthState.ts";
import { isHealthAlertKind } from "./healthState.ts";

export interface Streaks {
  present: number;
  absent: number;
}

export type HysteresisCounters = Map<string, Streaks>;

export function emptyCounters(): HysteresisCounters {
  return new Map();
}

export interface HysteresisOptions {
  openAfterChecks: number;
  closeAfterChecks: number;
}

export interface HysteresisResult {
  toOpen: HealthCondition[];
  toResolve: string[];
  counters: HysteresisCounters;
}

/**
 * Decides which alerts to open and resolve, requiring a condition to persist
 * before acting on it.
 *
 * The database's partial unique index already prevents duplicate open incidents;
 * this adds the second half of the protection by refusing to react to a
 * condition that has not held for several consecutive checks. Together they mean
 * a flapping signal produces no notifications at all rather than a stream.
 *
 * `openKinds` is filtered to the kinds this module raises. An open alert with no
 * matching condition looks exactly like a condition that has cleared, so without
 * that filter every incident raised anywhere else in the service — a failed
 * payout, an orphaned accrual that was already paid — gets quietly closed a few
 * ticks after it opens, by a loop that knows nothing about it.
 */
export function applyHysteresis(
  counters: HysteresisCounters,
  activeConditions: HealthCondition[],
  openKinds: Set<string>,
  opts: HysteresisOptions,
): HysteresisResult {
  const next: HysteresisCounters = new Map(counters);
  const activeByKind = new Map<HealthAlertKind, HealthCondition>();
  for (const c of activeConditions) activeByKind.set(c.kind, c);

  const owned = new Set<string>([...openKinds].filter(isHealthAlertKind));
  const allKinds = new Set<string>([...next.keys(), ...activeByKind.keys(), ...owned]);
  const toOpen: HealthCondition[] = [];
  const toResolve: string[] = [];

  for (const kind of allKinds) {
    const previous = next.get(kind) ?? { present: 0, absent: 0 };
    const condition = activeByKind.get(kind as HealthAlertKind);

    if (condition) {
      const streaks = { present: previous.present + 1, absent: 0 };
      next.set(kind, streaks);
      if (streaks.present >= opts.openAfterChecks && !owned.has(kind)) {
        toOpen.push(condition);
      }
    } else {
      const streaks = { present: 0, absent: previous.absent + 1 };
      next.set(kind, streaks);
      if (streaks.absent >= opts.closeAfterChecks && owned.has(kind)) {
        toResolve.push(kind);
      }
    }
  }

  return { toOpen, toResolve, counters: next };
}
