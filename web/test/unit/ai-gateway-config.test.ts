/**
 * Cloudflare AI Gateway routing config (lib/anthropic.aiGatewayConfig).
 *
 * Unconfigured → no transport override (direct to api.anthropic.com). Configured
 * → route through the gateway URL, with optional authenticated-gateway header.
 */
import { describe, it, expect } from "vitest";

import { aiGatewayConfig } from "@/lib/anthropic";

describe("aiGatewayConfig", () => {
  it("returns no override when unconfigured", () => {
    expect(aiGatewayConfig({})).toEqual({});
  });

  it("builds the gateway URL from account + gateway ids", () => {
    const cfg = aiGatewayConfig({ CF_AIG_ACCOUNT_ID: "acct123", CF_AIG_GATEWAY_ID: "hcc-gw" });
    expect(cfg.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/acct123/hcc-gw/anthropic");
    expect(cfg.defaultHeaders).toBeUndefined();
  });

  it("prefers an explicit full base URL", () => {
    const cfg = aiGatewayConfig({
      ANTHROPIC_GATEWAY_BASE_URL: "https://gw.example/anthropic",
      CF_AIG_ACCOUNT_ID: "acct123",
      CF_AIG_GATEWAY_ID: "hcc-gw",
    });
    expect(cfg.baseURL).toBe("https://gw.example/anthropic");
  });

  it("adds the cf-aig-authorization header for an authenticated gateway", () => {
    const cfg = aiGatewayConfig({
      CF_AIG_ACCOUNT_ID: "acct123",
      CF_AIG_GATEWAY_ID: "hcc-gw",
      CF_AIG_TOKEN: "secret",
    });
    expect(cfg.defaultHeaders).toEqual({ "cf-aig-authorization": "Bearer secret" });
  });

  it("ignores a half-configured pair (account without gateway)", () => {
    expect(aiGatewayConfig({ CF_AIG_ACCOUNT_ID: "acct123" })).toEqual({});
  });
});
