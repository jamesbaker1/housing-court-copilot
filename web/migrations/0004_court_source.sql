-- 0004_court_source — OPTIONAL acceleration table for eTrack email ingest
-- (ROADMAP Tier-2 #6, live court-date sourcing).
--
-- ADDITIVE ONLY. Does NOT modify 0001/0002/0003. Creating this table changes no
-- existing behavior: the connector's `findCaseByIndexNumber` (lib/court-source)
-- already resolves an inbound eTrack reminder to a case by scanning the public
-- store on `court.index_number`. This table simply lets a future Integrate-phase
-- wiring turn that O(n) scan into an O(1) lookup keyed by the index number that
-- appears on the inbound email. It is safe to apply and leave unused.
--
-- WHY a separate mapping (not just the cases table):
--   - The index number is the JOIN KEY eTrack mail carries; the store does not
--     index it. One case has at most one index number, but an index number form
--     can be written slightly differently across systems, so we store the exact
--     string the operator registered with eTrack alongside a normalized form for
--     matching.
--   - Keeping the mapping out of `cases` avoids touching the owned Case schema
--     and keeps this migration trivially reversible (DROP TABLE).
--
-- Privacy / safety notes:
--   - A court index number is part of the PUBLIC court record (not a secret),
--     but it is still case-identifying. It lives only here keyed to the opaque
--     internal case_id; no tenant name / phone / address is stored.
--   - Court-date VERIFICATION is NEVER decided by this table. It only answers
--     "which case does this index number belong to". The authoritative write
--     still goes through lib/court-date.setCourtDate (INVARIANT #2).

-- Maps a court index number (as it appears on eTrack mail) to an internal case.
CREATE TABLE IF NOT EXISTS court_index_map (
  index_normalized TEXT PRIMARY KEY NOT NULL, -- case-insensitive/whitespace-stripped match key
  index_number     TEXT NOT NULL,             -- the exact index string as registered/displayed
  case_id          TEXT NOT NULL,             -- ^case_[0-9a-hjkmnp-tv-z]{26}$ (validated in app)
  created_at       TEXT NOT NULL,             -- ISO-8601 when the mapping was recorded
  updated_at       TEXT NOT NULL              -- ISO-8601 of the last upsert
);

-- Reverse lookup (case_id -> its index number) for maintenance / re-sync.
CREATE INDEX IF NOT EXISTS idx_court_index_map_case ON court_index_map (case_id);
