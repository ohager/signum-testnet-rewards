import type { Ledger } from "./db.ts";
import { getState, setState } from "./state.ts";

const key = (channelName: string) => `channel_enabled:${channelName}`;

/**
 * Whether a configured channel is currently allowed to deliver.
 *
 * Absent means enabled: a channel that an operator took the trouble to
 * configure should work without a second switch also being set. Only an
 * explicit "false" silences one, and that decision survives a restart — a
 * channel muted because it was spamming at 3am must not un-mute itself when
 * the service is redeployed.
 */
export function isChannelEnabled(db: Ledger, channelName: string): boolean {
  return getState(db, key(channelName)) !== "false";
}

export function setChannelEnabled(db: Ledger, channelName: string, enabled: boolean): void {
  setState(db, key(channelName), enabled ? "true" : "false");
}
