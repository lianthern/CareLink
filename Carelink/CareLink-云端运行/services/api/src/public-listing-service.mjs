import { id } from "./util.mjs";

// v3.1 public plaza (逛逛空间): white-list curation, not self-serve publishing. An owner can only ever
// move a space to 'requested'; only tools/public-space-listings.mjs (run by an operator directly
// against the DB) can move a row to 'listed' or 'hidden'. discover() below is the one public,
// unauthenticated read in this file — it must never join out to `spaces`/members/photos, so the
// field whitelist is enforced structurally by only ever selecting the three curated columns.
export class PublicListingService {
  constructor(core) {
    this.core = core;
    this.db = core.db;
  }

  row(spaceId) {
    return this.core.one("SELECT * FROM public_space_listings WHERE space_id=?", spaceId);
  }

  view(row, spaceId) {
    if (!row) {
      return { spaceId, status: "unlisted", title: "", description: "", openUrl: "",
        requestedAt: null, listedAt: null, hiddenAt: null, version: 0 };
    }
    return { spaceId, status: row.status, title: row.title_override, description: row.description_override,
      openUrl: row.open_url, requestedAt: row.requested_at, listedAt: row.listed_at, hiddenAt: row.hidden_at,
      version: row.version };
  }

  // Owner-only status read for the /manage/:sid settings tab.
  status(accountCtx, spaceId) {
    this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
    return this.view(this.row(spaceId), spaceId);
  }

  // Owner-only "申请公开这个空间". Idempotent: a second request while already 'requested' or
  // 'listed' is a no-op (never regresses a listed space back to pending, never duplicates a row);
  // requesting again after an ops 'hide' re-opens it for review.
  request(ctx, accountCtx, spaceId) {
    return this.core.mutation(ctx, {
      endpoint: `/v1/spaces/${spaceId}/public-listing-requests`,
      scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true })
    }, () => {
      this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      const existing = this.row(spaceId);
      const now = this.core.now();
      if (!existing) {
        const rowId = id("psl");
        this.db.prepare(`INSERT INTO public_space_listings(
          id,space_id,status,requested_at,created_at,updated_at,version
        ) VALUES(?,?,'requested',?,?,?,1)`).run(rowId, spaceId, now, now, now);
        this.core.audit({ spaceId, aggregateType: "public_space_listing", aggregateId: rowId,
          eventType: "requested", actorKind: "space_owner", authorizationId: spaceId, detail: {}, requestId: ctx.requestId });
      } else if (existing.status === "hidden") {
        this.db.prepare(`UPDATE public_space_listings SET status='requested',requested_at=?,updated_at=?,version=version+1
          WHERE id=? AND version=?`).run(now, now, existing.id, existing.version);
        this.core.audit({ spaceId, aggregateType: "public_space_listing", aggregateId: existing.id,
          eventType: "requested", actorKind: "space_owner", authorizationId: spaceId, detail: {}, requestId: ctx.requestId });
      }
      // existing.status is 'requested' or 'listed': already pending / already public, no-op.
      return this.view(this.row(spaceId), spaceId);
    });
  }

  // Public, unauthenticated read for /discover. Field whitelist is structural: the SELECT only
  // ever names title_override/description_override/open_url, so there is no internal id, space
  // name, member, or photo data this can leak even if the mapping below is edited carelessly later.
  discover() {
    const rows = this.core.all(`SELECT title_override,description_override,open_url FROM public_space_listings
      WHERE status='listed' AND community_submission_id IS NULL AND open_url<>'' ORDER BY listed_at DESC, updated_at DESC LIMIT 100`);
    const community = this.community ? this.community.list({query:{pageSize:100}}, 'public').submissions.map(s => ({title:s.title, description:s.description, url:`/app#community-space/${s.id}`})) : [];
    return { spaces: [...community, ...rows.map((row) => ({ title: row.title_override, description: row.description_override, url: row.open_url }))].slice(0,100) };
  }
}
