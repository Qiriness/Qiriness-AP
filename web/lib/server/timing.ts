/**
 * How long each read behind a page took, printed to the server console.
 *
 * OFF UNLESS `PAGE_TIMING=1`. It exists to measure page loads (dev against a
 * production build, before and after a change), not to run permanently. Only
 * labels and milliseconds are printed — never an argument, a row or a name.
 *
 * Server-only.
 */

const enabled = () => process.env.PAGE_TIMING === "1";

/** Await `work`, printing `label` and its duration when timing is on. */
export async function timed<T>(label: string, work: Promise<T>): Promise<T> {
  if (!enabled()) return work;
  const started = performance.now();
  try {
    return await work;
  } finally {
    console.log(`[timing] ${label} ${Math.round(performance.now() - started)} ms`);
  }
}
