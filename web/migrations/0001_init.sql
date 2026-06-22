-- 0001_init — Case store foundation (Cloudflare D1).
--
-- One row per Case. `doc` holds the full, schema-valid Case JSON (the source of
-- truth, re-validated with CaseSchema on every read/write in lib/store.ts). The
-- remaining columns are DERIVED projections of `doc`, re-computed on every write,
-- so the provider triage inbox can list/sort/filter without parsing every blob.
--
-- Safety backstops are NOT relaxed here: `doc` is the authoritative Case and the
-- derived columns are advisory indices only. court_date_verified, advice_routed,
-- and open-data verify gates all continue to live inside `doc` and are enforced
-- by the application + CaseSchema. has_provider_consent / advice_routed are
-- mirrored out purely to drive the consented triage list cheaply.

CREATE TABLE IF NOT EXISTS cases (
  -- Crockford-base32 ULID, ^case_[0-9a-hjkmnp-tv-z]{26}$ (validated in app).
  case_id              TEXT    PRIMARY KEY NOT NULL,
  -- Full Case Object as JSON (the source of truth).
  doc                  TEXT    NOT NULL,
  -- Derived projections (re-computed on every write from `doc`):
  status               TEXT    NOT NULL,
  case_type            TEXT    NOT NULL,
  court_date           TEXT,            -- authoritative court.court_date or NULL
  updated_at           TEXT    NOT NULL,
  has_provider_consent INTEGER NOT NULL DEFAULT 0, -- 1 iff a granted, live handoff_to_provider consent exists
  advice_routed        INTEGER NOT NULL DEFAULT 0  -- mirror of review.advice_routed
);

-- Provider triage inbox: filter to consented cases, soonest court date first.
CREATE INDEX IF NOT EXISTS idx_cases_consent_court_date
  ON cases (has_provider_consent, court_date);

-- Generic "most recently touched" ordering.
CREATE INDEX IF NOT EXISTS idx_cases_updated_at
  ON cases (updated_at);
