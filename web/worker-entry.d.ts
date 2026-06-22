/**
 * Ambient type for the OpenNext-generated worker, imported by worker-entry.ts.
 *
 * `.open-next/worker.js` is a gitignored BUILD ARTIFACT that may or may not exist
 * at typecheck time (CI runs `tsc --noEmit` before any build). Declaring the
 * module here lets the cron wrapper typecheck deterministically whether or not
 * the artifact is present, without an `@ts-expect-error` that flips between the
 * two states. At runtime Wrangler resolves the real emitted module.
 */
declare module "*/.open-next/worker.js" {
  const worker: { fetch: (...args: unknown[]) => Promise<Response> };
  export default worker;
  export const DOQueueHandler: unknown;
  export const DOShardedTagCache: unknown;
  export const BucketCachePurge: unknown;
}
