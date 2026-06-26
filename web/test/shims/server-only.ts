// Test shim: `server-only` is a Next.js build-time guard that throws if a
// server module is bundled into a client component. Under Vitest's node
// environment there is no client/server split, so we alias it to a harmless
// empty module (matching what Next.js does on the server) so server-only
// libraries (lib/anthropic, lib/crypto-field, lib/auth/session, ...) import
// cleanly in unit tests. See vitest.config.ts `resolve.alias`.
export {};
