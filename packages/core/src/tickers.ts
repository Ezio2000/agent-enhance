const TICK_DELAYS_MS = [1000, 1000, 2000, 3000, 5000, 8000, 12000, 18000, 25000];

export interface ProgressTicker {
  dispose(): void;
}

/**
 * Progress updates with backoff: responsive at first, then sparse.
 *
 * Every update redraws the tool block, and terminals that render inline images
 * re-emit them on each redraw. Keeping a fixed one-second cadence for a
 * multi-minute generation makes finished images flicker, so the interval grows
 * once the first few updates have been delivered.
 */
export function createProgressTicker(tick: () => void): ProgressTicker {
  let index = 0;
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const schedule = (): void => {
    const delay = TICK_DELAYS_MS[Math.min(index, TICK_DELAYS_MS.length - 1)]!;
    index += 1;
    timer = setTimeout(() => {
      if (disposed) return;
      tick();
      schedule();
    }, delay);
  };
  schedule();
  return {
    dispose(): void {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
