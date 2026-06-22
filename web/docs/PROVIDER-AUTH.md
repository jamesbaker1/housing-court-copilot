# Provider authentication — Cloudflare Access

The provider surface (`/provider` UI + `/api/provider/*` API) is gated by
**Cloudflare Access**. Staff authenticate against your organization's identity
provider; the app never stores staff credentials. Next.js middleware
(`middleware.ts`) verifies the per-request Access JWT before any provider route
runs, and forwards the authenticated email downstream for audit.

## How it works

1. Cloudflare Access sits in front of the Worker. A request to `/provider*` or
   `/api/provider/*` that hasn't authenticated is intercepted by Access and the
   user is sent through your IdP login.
2. After login, Access forwards the request with a signed JWT in the
   `Cf-Access-Jwt-Assertion` header (and a `CF_Authorization` cookie for browser
   navigations).
3. `middleware.ts` calls `verifyAccessRequest()` in `lib/auth/access.ts`, which:
   - fetches and caches your team's public keys (JWKS) from
     `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`,
   - verifies the JWT signature,
   - enforces `iss === https://<CF_ACCESS_TEAM_DOMAIN>` and `aud === CF_ACCESS_AUD`.
4. On success the request proceeds with `x-access-email` set (provider identity
   for audit). On failure: **403 JSON** for API routes, **403 HTML** for pages.

Defense in depth: even though Access blocks unauthenticated traffic at the edge,
the middleware re-verifies the JWT inside the Worker so a misconfigured route or
a bypassed edge can't expose provider data.

## Environment variables

Set these as Worker `[vars]` (or `wrangler secret put` for production). They are
**plain env vars, not bindings** — do not put them in `wrangler.toml`'s
`[[d1_databases]]`.

| Var | Required | Example | Meaning |
| --- | --- | --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | yes (prod) | `myteam.cloudflareaccess.com` | Your Access team domain. Scheme optional; the helper normalizes it. Used to derive the JWKS URL and the expected issuer. |
| `CF_ACCESS_AUD` | yes (prod) | `f0e1d2c3...` | The Application Audience (AUD) tag of the self-hosted Access application (copy from the app's Overview page). |
| `CF_ACCESS_DISABLE_DEV` | no | `1` | When set to `1`, forces real Access verification even in `next dev`. Leave unset for normal local development. |

In production (`NODE_ENV === "production"`) both `CF_ACCESS_TEAM_DOMAIN` and
`CF_ACCESS_AUD` **must** be set, or every provider request fails closed (403).

## Local development

`next dev` runs with `NODE_ENV !== "production"`, so the middleware **bypasses**
Access by default and logs `DEV: Access bypassed ...` for each provider request.
No Access tunnel is required to work on the provider UI locally.

To exercise the real verification path locally, set `CF_ACCESS_DISABLE_DEV=1`
and provide `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` (you'll also need a valid
Access token, e.g. via `cloudflared access`).

## Setting up the Cloudflare Access application (operator, deploy-time)

> These steps require a Cloudflare account/login and are **not** run by the
> local build. Perform them in the Cloudflare Zero Trust dashboard.

1. **Find your team domain.** Zero Trust dashboard → **Settings → Custom Pages**
   (or the dashboard URL): it is `https://<team-name>.cloudflareaccess.com`.
   Set `CF_ACCESS_TEAM_DOMAIN=<team-name>.cloudflareaccess.com`.

2. **Create a self-hosted application.** Zero Trust → **Access → Applications →
   Add an application → Self-hosted**.
   - **Application domain / path:** your Worker's hostname with path `/provider`
     (add a second path `/api/provider` if your domain model needs it, or use a
     wildcard such as `/provider*`). This must cover both the UI and API prefixes
     the middleware matches.
   - **Session duration:** per your policy.

3. **Add an access policy.** e.g. an **Allow** policy whose Include rule is
   *Emails ending in* your staff domain, or a specific email list / IdP group.

4. **Copy the AUD tag.** Open the application → **Overview** → copy the
   **Application Audience (AUD) Tag**. Set `CF_ACCESS_AUD=<that value>`.

5. **Set the Worker vars/secrets** at deploy time, e.g.:

   ```sh
   wrangler secret put CF_ACCESS_TEAM_DOMAIN
   wrangler secret put CF_ACCESS_AUD
   ```

   (or define them under `[vars]` in `wrangler.toml` if non-secret is acceptable
   for the team domain / AUD).

6. **Verify.** Hit `/provider` unauthenticated — Access should challenge you.
   After login, the app loads and provider API responses carry your identity.
   An expired/invalid token yields a 403 from the middleware.

## Audit

On a verified request the middleware sets `x-access-email` (and `x-access-sub`)
on the forwarded request headers. Provider route handlers can read
`request.headers.get("x-access-email")` to attribute actions to a staff member
without re-verifying the JWT.
