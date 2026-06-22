-- 0003_security — boundary hardening: per-case capability tokens, OTP-backed
-- owner sessions, and a D1-backed rate-limit token bucket.
--
-- ADDITIVE ONLY. Does NOT modify 0001/0002. These tables lock the front door:
-- the `cases` GET/PATCH/DELETE boundary now requires PROOF OF OWNERSHIP — either
-- a per-case capability token (minted at case creation, NOT the loggable URL id)
-- or an OTP-verified owner session — and every public entry point is metered by
-- the rate-limit bucket.
--
-- Privacy / safety notes:
--   - Capability tokens and session tokens are stored as a SHA-256 HASH only
--     (never the plaintext secret), mirroring the OTP table's posture. A DB leak
--     does not yield a usable bearer secret.
--   - A capability token is bound to exactly one case_id. A session (issued after
--     OTP verification) is bound to a verified phone and authorizes every case
--     that phone owns via case_owners (0002).
--   - The rate-limit bucket is keyed by an opaque bucket key (e.g. "ip:1.2.3.4",
--     "otp_phone:+1555...", "otp_ip:1.2.3.4", "sms_global") and is best-effort:
--     a missing/erroring backend fails OPEN for metering (never blocks a tenant
--     because the limiter is down) but the SMS global ceiling is enforced
--     defensively in app code.

-- Per-case capability tokens. One row per minted token; a case may have several
-- (e.g. re-issued on resume). The token's PLAINTEXT is returned to the client
-- ONCE at creation and never persisted; only its hash lives here.
CREATE TABLE IF NOT EXISTS case_tokens (
  token_hash  TEXT PRIMARY KEY NOT NULL,  -- SHA-256 hex of the capability secret
  case_id     TEXT NOT NULL,              -- ^case_[0-9a-hjkmnp-tv-z]{26}$ (validated in app)
  created_at  TEXT NOT NULL,              -- ISO-8601 when minted
  expires_at  TEXT,                       -- ISO-8601 expiry, or NULL for no expiry
  revoked     INTEGER NOT NULL DEFAULT 0  -- 1 = revoked (e.g. on tenant delete)
);

CREATE INDEX IF NOT EXISTS idx_case_tokens_case ON case_tokens (case_id);

-- OTP-verified owner sessions. Issued by the OTP verify route on success; bound
-- to the now-verified phone. Authorizes any case that phone owns (case_owners).
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash  TEXT PRIMARY KEY NOT NULL,  -- SHA-256 hex of the session secret
  phone_e164  TEXT NOT NULL,              -- the verified phone this session belongs to
  created_at  TEXT NOT NULL,              -- ISO-8601 when issued
  expires_at  TEXT NOT NULL,              -- ISO-8601 expiry (sessions are bounded)
  revoked     INTEGER NOT NULL DEFAULT 0  -- 1 = revoked
);

CREATE INDEX IF NOT EXISTS idx_owner_sessions_phone ON owner_sessions (phone_e164);

-- D1-backed token-bucket rate limiter. One row per (bucket_key, window) pair.
-- The app uses a fixed-window counter keyed by bucket + an integer window index
-- (floor(now / window_ms)); a fresh window starts a fresh count. Old rows are
-- swept lazily / by the Ops cron.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT NOT NULL,             -- opaque key, e.g. "ip:1.2.3.4" or "otp_phone:+1555..."
  window_start INTEGER NOT NULL,          -- window index = floor(epoch_ms / window_ms)
  count        INTEGER NOT NULL DEFAULT 0, -- requests counted in this window
  updated_at   TEXT NOT NULL,             -- ISO-8601 of the last increment
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
