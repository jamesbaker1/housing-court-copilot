// OpenNext → Cloudflare Workers adapter config. Default configuration: it wires
// the Next.js 15 server output for the Workers runtime. Caching/queue overrides
// can be added here later if needed; the default is sufficient for v1 (the Case
// store uses D1 directly, not the Next data cache).
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
