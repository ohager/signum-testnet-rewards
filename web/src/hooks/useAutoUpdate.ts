"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "signum-rewards:auto-update";

/**
 * Whether this reader has asked the page to keep itself current.
 *
 * Opt-in rather than on by default. Polling is the only thing on this page that
 * costs anything after the first paint, and a crawler, a link unfurler or a tab
 * someone forgot about will never flip this switch — so the request budget goes
 * to people who are actually watching. It is also the honest shape for what
 * polling is: something the reader chose, and can see that they chose.
 *
 * Kept in `localStorage` rather than for the session only, because the reader
 * this setting exists for is the one leaving the page open on a spare monitor,
 * and asking them again after every reload would defeat that.
 */
export function useAutoUpdate(): readonly [boolean, (on: boolean) => void] {
  /**
   * False for the first render, always.
   *
   * `localStorage` does not exist on the server, so consulting it during render
   * would make the client's first paint disagree with the HTML it is hydrating.
   * The effect below adopts the stored answer a tick later, which is soon
   * enough — nothing has had a chance to poll yet.
   */
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(read());
  }, []);

  const set = useCallback((on: boolean) => {
    setEnabled(on);
    write(on);
  }, []);

  return [enabled, set] as const;
}

/**
 * Storage is wrapped because in the cases that matter it throws rather than
 * returning null: Safari with cookies blocked, and locked-down enterprise
 * profiles. Somebody who cannot persist the preference should still get a
 * working switch for this visit rather than a blank page.
 */
function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function write(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Held in React state for this visit, just not remembered for the next one.
  }
}
