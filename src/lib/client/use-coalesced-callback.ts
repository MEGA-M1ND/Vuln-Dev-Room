"use client";

import * as React from "react";

/**
 * Coalesce bursty calls into at most one invocation per window.
 *
 * A run emits many events in quick succession (patch, tests, diff…), and each
 * broadcasts `RUN_UPDATED` to every client in the room. Without coalescing,
 * every teammate would fire a refetch storm. This runs on the leading edge (so
 * the first signal is instant) and collapses the rest of the window into a
 * single trailing call.
 */
export function useCoalescedCallback(
  fn: () => void | Promise<void>,
  windowMs = 400,
): () => void {
  const fnRef = React.useRef(fn);
  fnRef.current = fn;

  const lastRun = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return React.useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastRun.current;

    if (elapsed >= windowMs) {
      lastRun.current = now;
      void fnRef.current();
      return;
    }
    // Inside the window: schedule a single trailing call.
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      lastRun.current = Date.now();
      void fnRef.current();
    }, windowMs - elapsed);
  }, [windowMs]);
}
