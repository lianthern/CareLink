-- v3.1 public plaza (逛逛空间): a white-list curation table, separate from `spaces`.
-- An owner can *request* their space be listed; only an ops operator (tools/public-space-listings.mjs,
-- run directly against this DB — see that script for why there is no admin HTTP surface) can move a
-- row to 'listed' or 'hidden'. title_override/description_override/open_url are curated copy chosen
-- at approval time — never the space's real internal name — so GET /v1/discover/spaces never has to
-- reach into `spaces`/members/photos to answer a public, unauthenticated read.
CREATE TABLE public_space_listings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id),
  status TEXT NOT NULL CHECK(status IN ('requested','listed','hidden')),
  title_override TEXT NOT NULL DEFAULT '',
  description_override TEXT NOT NULL DEFAULT '',
  open_url TEXT NOT NULL DEFAULT '',
  requested_at TEXT,
  listed_at TEXT,
  hidden_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_public_space_listings_status ON public_space_listings(status);
