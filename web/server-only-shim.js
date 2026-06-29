// No-op shim for the `server-only` package, used ONLY by the Wrangler/esbuild
// bundle of the ops `worker-entry.ts` wrapper (see the [alias] in wrangler.toml).
//
// `server-only` is a Next.js build-time MARKER: importing it throws if the module
// is ever pulled into a CLIENT bundle. The Next/OpenNext build understands it and
// strips it for the server bundle. But our thin Cloudflare worker-entry wrapper is
// bundled SEPARATELY by Wrangler, and it transitively imports the marker through
// lib/retention -> lib/store -> lib/crypto-field. That code only ever runs
// server-side (the Worker), so the marker is a no-op here — this empty module lets
// the wrapper bundle resolve without weakening the real client/server guard, which
// still applies in the Next build where it matters.
export {};
