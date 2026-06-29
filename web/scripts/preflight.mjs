#!/usr/bin/env node
/**
 * Deploy preflight for the Housing Court Copilot (Cloudflare Workers).
 *
 * Read-only. Probes the REMOTE Cloudflare state via wrangler and reports whether
 * the deployment is ready, so an operator isn't surprised by a half-configured
 * Worker. It checks, in order:
 *   1. wrangler auth (whoami)
 *   2. the D1 database exists AND has been migrated (num_tables > 0)
 *   3. the R2 evidence bucket exists
 *   4. which Worker secrets are set (vs. the required/optional sets below)
 *
 * It NEVER prints secret values and never mutates anything. Exit code 1 if a
 * BLOCKER is missing (auth / D1 not migrated / a required secret), else 0.
 *
 * Usage:  node scripts/preflight.mjs        (from web/)
 *         npm run preflight
 *
 * The required/optional split mirrors what the code actually reads:
 *   - CASE_PII_KEY        — field-level PII encryption (lib/crypto-field.ts). The
 *                           app fails closed without it; nothing can be stored.
 *   - ANTHROPIC_API_KEY   — every LLM surface (intake/chat/defenses/answer/…).
 *   - TURNSTILE_SECRET_KEY— bot gate; FAILS CLOSED in prod, so the public LLM
 *                           entry points are blocked until it (and the public
 *                           NEXT_PUBLIC_TURNSTILE_SITE_KEY build var) are set.
 *   - CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD — gate the /provider surface. Absent
 *                           ⇒ provider console returns 403 (tenant app still works).
 *   - Optional: TWILIO_* (SMS reminders), SOCRATA_APP_TOKEN (open-data rate),
 *               COURT_DATA_VENDOR_API_KEY (court-date vendor).
 */
import { execFileSync } from "node:child_process";

const DB_NAME = "housing-court-copilot";
const R2_BUCKET = "housing-court-copilot-evidence";
const WORKER = "housing-court-copilot";

/** Secrets that must be set for the app to function (boot / core features). */
const REQUIRED_SECRETS = [
  "CASE_PII_KEY",
  "ANTHROPIC_API_KEY",
  "TURNSTILE_SECRET_KEY",
];
/** Needed only for the provider surface; tenant app works without them. */
const PROVIDER_SECRETS = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"];
/** Nice-to-have integrations; each self-gates off when unset. */
const OPTIONAL_SECRETS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
  "SOCRATA_APP_TOKEN",
  "COURT_DATA_VENDOR_API_KEY",
];

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const ok = (m) => console.log(`${GREEN}✓${RST} ${m}`);
const bad = (m) => console.log(`${RED}✗${RST} ${m}`);
const warn = (m) => console.log(`${YEL}!${RST} ${m}`);

let blockers = 0;

/** Run a wrangler subcommand, returning stdout (or null on failure). */
function wrangler(args) {
  try {
    return execFileSync("npx", ["wrangler", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (err) {
    return err.stdout ? String(err.stdout) : null;
  }
}

console.log(`\n${DIM}Housing Court Copilot — deploy preflight${RST}\n`);

// 1) Auth ---------------------------------------------------------------------
const who = wrangler(["whoami"]);
if (who && /You are logged in/.test(who)) {
  const email = (who.match(/associated with the email\s+([^\s.]+@[^\s.]+\.[^\s.]+)/) || [])[1];
  ok(`wrangler authenticated${email ? ` (${email})` : ""}`);
} else {
  bad("wrangler is NOT authenticated — run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN).");
  blockers++;
}

// 2) D1 -----------------------------------------------------------------------
const d1 = wrangler(["d1", "list", "--json"]);
let d1Row = null;
if (d1) {
  try {
    d1Row = JSON.parse(d1).find((d) => d.name === DB_NAME) ?? null;
  } catch {
    /* fall through */
  }
}
if (!d1Row) {
  bad(`D1 "${DB_NAME}" not found — create it: \`wrangler d1 create ${DB_NAME}\` and set database_id in wrangler.toml.`);
  blockers++;
} else {
  // The `d1 list` num_tables stat is cached and can lag a fresh migration, so
  // ask the DB directly how many app tables it has (authoritative).
  const count = remoteTableCount();
  if (count === 0) {
    bad(`D1 "${DB_NAME}" exists but is NOT migrated (0 tables) — run \`wrangler d1 migrations apply ${DB_NAME} --remote\`.`);
    blockers++;
  } else if (count === null) {
    warn(`D1 "${DB_NAME}" exists but its table count could not be read — verify with \`wrangler d1 migrations list ${DB_NAME} --remote\`.`);
  } else {
    ok(`D1 "${DB_NAME}" migrated (${count} tables)`);
  }
}

/** Live count of app tables in the remote D1 (null if the query failed). */
function remoteTableCount() {
  const out = wrangler([
    "d1",
    "execute",
    DB_NAME,
    "--remote",
    "--json",
    "--command",
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';",
  ]);
  if (!out) return null;
  try {
    const parsed = JSON.parse(out.slice(out.indexOf("[")));
    const rows = (Array.isArray(parsed) ? parsed : []).flatMap((r) => r.results ?? []);
    const n = rows[0]?.n;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

// 3) R2 -----------------------------------------------------------------------
const r2 = wrangler(["r2", "bucket", "list"]);
if (r2 && new RegExp(`name:\\s+${R2_BUCKET}`).test(r2)) {
  ok(`R2 bucket "${R2_BUCKET}" exists`);
} else {
  warn(`R2 bucket "${R2_BUCKET}" missing — \`wrangler r2 bucket create ${R2_BUCKET}\`. Until then evidence upload/download return 503 (the app otherwise works).`);
}

// 4) Secrets ------------------------------------------------------------------
const secretsRaw = wrangler(["secret", "list", "--name", WORKER]);
let setSecrets = new Set();
if (secretsRaw) {
  try {
    for (const s of JSON.parse(secretsRaw)) setSecrets.add(s.name);
  } catch {
    // Non-JSON (e.g. worker not deployed yet) — treat as none set.
  }
}

const report = (name, list, sink) => {
  const missing = list.filter((s) => !setSecrets.has(s));
  if (missing.length === 0) {
    ok(`${name}: all set (${list.join(", ")})`);
  } else {
    sink(`${name}: missing ${missing.join(", ")} — set with \`wrangler secret put <NAME> --name ${WORKER}\`.`);
  }
  return missing;
};

const missReq = report("Required secrets", REQUIRED_SECRETS, (m) => { bad(m); blockers++; });
report("Provider secrets", PROVIDER_SECRETS, warn);
report("Optional secrets", OPTIONAL_SECRETS, warn);

// Public build var (baked into the client bundle at build time, not a secret).
warn("Build var NEXT_PUBLIC_TURNSTILE_SITE_KEY must be present at `next build` time for the real Turnstile widget (otherwise the dev placeholder ships).");

// Summary ---------------------------------------------------------------------
console.log("");
if (blockers === 0) {
  console.log(`${GREEN}READY${RST} — no blockers. Deploy with \`npm run deploy\`.`);
  process.exit(0);
} else {
  console.log(`${RED}NOT READY${RST} — ${blockers} blocker(s) above. Resolve them, then re-run \`npm run preflight\`.`);
  if (missReq.includes("CASE_PII_KEY")) {
    console.log(
      `${DIM}  Tip: generate a fresh PII key →\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put CASE_PII_KEY --name ${WORKER}${RST}`,
    );
  }
  process.exit(1);
}
