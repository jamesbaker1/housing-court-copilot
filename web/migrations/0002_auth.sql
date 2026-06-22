-- 0002_auth — OPTIONAL SMS-OTP tenant "resume my case on another device".
--
-- ADDITIVE ONLY. Does NOT modify 0001 (the `cases` table is untouched). Tenants
-- stay anonymous by default. These tables only come into play if a tenant OPTS
-- IN to linking a case to a verified phone so they can resume it elsewhere. This
-- is never a login wall and never gates access to the copilot.
--
-- Privacy / safety notes:
--   - We store the phone in E.164 only after it is verified by a one-time code.
--   - OTPs are stored as a HASH (never the plaintext code), with a short expiry
--     and a hard attempt cap, so the table is rate-limit friendly and a DB leak
--     does not reveal live codes.
--   - case_owners is the link table (a phone may own several cases across
--     devices/sessions; a case may, in edge cases, be linked from more than one
--     verification, hence a composite identity rather than a single FK).
--   - No safety backstop in `cases`/`doc` is touched: court_date_verified,
--     advice_routed and the open-data verify gates all still live in the Case
--     doc and are enforced there. This is purely a resume-convenience index.

-- Verified phones. A row exists once a phone has completed >=1 OTP verification.
CREATE TABLE IF NOT EXISTS tenant_phones (
  phone_e164  TEXT PRIMARY KEY NOT NULL,  -- ^\+[1-9]\d{1,14}$ (validated in app)
  created_at  TEXT NOT NULL              -- ISO-8601 of first verification
);

-- Link table: which case(s) a verified phone may resume.
CREATE TABLE IF NOT EXISTS case_owners (
  case_id     TEXT NOT NULL,  -- ^case_[0-9a-hjkmnp-tv-z]{26}$ (validated in app)
  phone_e164  TEXT NOT NULL,  -- references tenant_phones(phone_e164)
  linked_at   TEXT NOT NULL,  -- ISO-8601 when the link was established
  PRIMARY KEY (case_id, phone_e164)
);

-- Lookup all cases a phone owns (resume flow), and all owners of a case.
CREATE INDEX IF NOT EXISTS idx_case_owners_phone ON case_owners (phone_e164);

-- Pending one-time codes. At most one live code per phone (PK on phone_e164);
-- a fresh request replaces (UPSERT) any prior pending code for that phone.
CREATE TABLE IF NOT EXISTS otp_codes (
  phone_e164  TEXT PRIMARY KEY NOT NULL,  -- the phone the code was sent to
  code_hash   TEXT NOT NULL,             -- SHA-256 hex of the 6-digit code (never the code)
  case_id     TEXT NOT NULL,             -- case to link on successful verify
  expires_at  TEXT NOT NULL,             -- ISO-8601 expiry; codes are short-lived
  attempts    INTEGER NOT NULL DEFAULT 0 -- failed verify attempts; hard-capped in app
);
