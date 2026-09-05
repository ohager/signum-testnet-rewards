import type { HealthCondition, HealthAlertKind } from "./healthState.ts";

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

  const allKinds = new Set<string>([...next.keys(), ...activeByKind.keys(), ...openKinds]);
  const toOpen: HealthCondition[] = [];
  const toResolve: string[] = [];

  for (const kind of allKinds) {
    const previous = next.get(kind) ?? { present: 0, absent: 0 };
    const condition = activeByKind.get(kind as HealthAlertKind);

    if (condition) {
      const streaks = { present: previous.present + 1, absent: 0 };
      next.set(kind, streaks);
      if (streaks.present >= opts.openAfterChecks && !openKinds.has(kind)) {
        toOpen.push(condition);
      }
    } else {
      const streaks = { present: 0, absent: previous.absent + 1 };
      next.set(kind, streaks);
      if (streaks.absent >= opts.closeAfterChecks && openKinds.has(kind)) {
        toResolve.push(kind);
      }
    }
  }

  return { toOpen, toResolve, counters: next };
}
