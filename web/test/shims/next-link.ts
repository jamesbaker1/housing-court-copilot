// Test shim: `next/link` is a React component that drags a large slice of the
// Next.js runtime through Vitest's transform when a server library imports a
// component module for its *pure* helpers (e.g. lib/store imports
// components/provider/TriageList only for `hasGrantedHandoffConsent`). Under the
// node project there is no rendering, so we alias next/link to a trivial stub.
// The real pure helpers in the importing component still run; only the unused
// React/Next surface is stubbed out. See vitest.config.ts `resolve.alias`.
export default function Link() {
  return null;
}
