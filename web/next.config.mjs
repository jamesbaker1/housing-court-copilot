import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Makes Cloudflare bindings (e.g. the D1 `DB` binding) available during
// `next dev` via getCloudflareContext(), matching the deployed Workers runtime.
initOpenNextCloudflareForDev();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Anthropic SDK is server-only; keep it out of the client bundle.
  serverExternalPackages: ["@anthropic-ai/sdk"],
};

export default nextConfig;
