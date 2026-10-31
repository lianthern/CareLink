import { ApiError, assert } from "./errors.mjs";
import { id, json, parseJson, secret } from "./util.mjs";
import { enumValue, object, SCOPES, setValues, string, TASKS } from "./schemas.mjs";

export class SpaceService {
  constructor(core, identity) {
    this.core = core;
    this.db = core.db;
    this.identity = identity;
  }

  requireNotice(ctx, purpose) {
    const notice = this.core.one("SELECT * FROM consent_notices WHERE purpose=? AND locale='zh-CN' AND retired_at IS NULL ORDER BY version DESC LIMIT 1", purpose);
    assert(notice && ctx.notice && ctx.notice.purpose === purpose && Number(ctx.notice.version) === notice.version &&
      ctx.notice.contentHash === notice.content_hash, "notice_acknowledgement_required", 409);
    return notice;
  }

  // Shared by create() and ensurePersonal(): inserts the spaces/scenes rows
  // and the notice_ack_events provenance row. collectionState defaults to the
  // normal explicit-create-flow default ('paused' — sharing and collection
  // stay off until the owner opens them in management); ensurePersonal()
  // overrides it to 'open' since a personal space exists specifically so its
  // owner can upload into it immediately.
  // auto_approve_uploads is unconditionally 1 here — both callers are "a
  // space is being newly created" (explicit create() and lazy
  // ensurePersonal() alike), and A's contract is "new spaces default on,
  // existing spaces keep their current (off) behavior". Existing spaces
  // never pass through this method again, so migration 0015's DEFAULT 0
  // stays their permanent starting point until an owner flips the setting
  // via transitionAutoApproveUploads() below.
  #insertSpaceRow(accountCtx, name, notice, { collectionState = "paused", personalDefault = false } = {}) {
    const spaceId = id("space");
    const sceneId = id("scene");
    const now = this.core.now();
    this.db.prepare(`INSERT INTO spaces(
      id,name,owner_account_id,space_lifecycle,collection_state,sharing_state,scene_id,is_personal_default,auto_approve_uploads,version,created_at,updated_at
    ) VALUES(?,?,?,'active',?,'private',?,?,1,1,?,?)`).run(spaceId, name, accountCtx.accountId, collectionState,
    sceneId, personalDefault ? 1 : 0, now, now);
    this.db.prepare(`INSERT INTO scenes(
      id,space_id,scene_readiness,scene_mode,version,created_at,updated_at
    ) VALUES(?,?,'unavailable','rotation360',1,?,?)`).run(sceneId, spaceId, now, now);
    this.db.prepare(`INSERT INTO notice_ack_events(
      id,space_id,actor_auth_kind,authorization_id,notice_id,notice_version,notice_hash,notice_purpose,target_mutation_id,acknowledged_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id("ack"), spaceId, "account", accountCtx.session.id, notice.id,
    notice.version, notice.content_hash, "space_create", spaceId, now);
    return { spaceId, sceneId, now };
  }

  create(ctx, accountCtx) {
    const body = object(ctx.body, ["name"], ["name"]);
    const name = string(body.name, { max: 120 });
    return this.core.mutation(ctx, { endpoint: "/v1/spaces", scope: accountCtx.session.id }, () => {
      const notice = this.requireNotice(ctx, "space_create");
      const { spaceId, sceneId } = this.#insertSpaceRow(accountCtx, name, notice);
      this.core.audit({ spaceId, aggregateType: "space", aggregateId: spaceId, eventType: "created", actorKind: "account",
        authorizationId: accountCtx.session.id, detail: { sceneId, name }, requestId: ctx.requestId });
      return { spaceId, sceneId, name, spaceLifecycle: "active", collectionState: "paused", sharingState: "private",
        sceneReadiness: "unavailable", sceneMode: "rotation360", version: 1, destinationRoute: `/manage/${spaceId}?tab=setup` };
    });
  }

  // v3.1 "传到我的空间" (MaxNotes UNSEEN-UI规划v3, 3.1): lazily provisions the
  // caller's personal default space the first time they need it, instead of
  // at login/signup — an account that never uploads to itself never gets one.
  // Idempotent: a second/concurrent call for the same account returns the
  // existing space rather than creating another. Correctness comes from two
  // layers — this.core.mutation()'s BEGIN IMMEDIATE transaction serializes
  // same-process concurrent calls so the re-check inside always sees a prior
  // committed insert, and ux_spaces_owner_personal_default (migration 0012)
  // is the durable backstop if that were ever bypassed.
  ensurePersonal(ctx, accountCtx) {
    const existing = this.core.one("SELECT id,name,space_lifecycle,collection_state,version FROM spaces WHERE owner_account_id=? AND is_personal_default=1", accountCtx.accountId);
    if (existing) return { spaceId: existing.id, name: existing.name, created: false, spaceLifecycle: existing.space_lifecycle,
      collectionState: existing.collection_state, version: existing.version, destinationRoute: `/s/${existing.id}/upload` };
    return this.core.mutation(ctx, { endpoint: "/v1/me/personal-space", scope: accountCtx.session.id }, () => {
      const already = this.core.one("SELECT id,name,space_lifecycle,collection_state,version FROM spaces WHERE owner_account_id=? AND is_personal_default=1", accountCtx.accountId);
      if (already) return { spaceId: already.id, name: already.name, created: false, spaceLifecycle: already.space_lifecycle,
        collectionState: already.collection_state, version: already.version, destinationRoute: `/s/${already.id}/upload` };
      // No client-supplied notice acknowledgement here: this is a lazy, implicit
      // provisioning step triggered by the owner's own "传到我的空间" click, not
      // the explicit /spaces/new form, so there is no notice payload to relay.
      // We still record the same space_create notice_ack_events row create()
      // would, sourced from the server's own current notice instead of a
      // client-supplied one, so the audit trail stays consistent either way.
      const notice = this.core.one("SELECT * FROM consent_notices WHERE purpose='space_create' AND locale='zh-CN' AND retired_at IS NULL ORDER BY version DESC LIMIT 1");
      assert(notice, "notice_unavailable", 503);
      const { spaceId, sceneId } = this.#insertSpaceRow(accountCtx, "我的空间", notice, { collectionState: "open", personalDefault: true });
      this.core.audit({ spaceId, aggregateType: "space", aggregateId: spaceId, eventType: "personal_space_provisioned",
        actorKind: "account", authorizationId: accountCtx.session.id, detail: { sceneId }, requestId: ctx.requestId });
      return { spaceId, sceneId, name: "我的空间", spaceLifecycle: "active", collectionState: "open", sharingState: "private",
        version: 1, created: true, destinationRoute: `/s/${spaceId}/upload` };
    });
  }

  list(accountCtx, lifecycle = null) {
    const rows = this.core.all(`SELECT s.*,m.id membership_id,m.tasks_json,m.management_scopes_json,m.status membership_status,m.version membership_version
      FROM spaces s LEFT JOIN space_memberships m ON m.space_id=s.id AND m.account_id=? AND m.status='active'
      WHERE s.owner_account_id=? OR m.id IS NOT NULL ORDER BY s.created_at`, accountCtx.accountId, accountCtx.accountId);
    return {
      spaces: rows.filter((row) => {
        if (row.space_lifecycle === "archived" && row.owner_account_id !== accountCtx.accountId) return false;
        return !lifecycle || row.space_lifecycle === lifecycle;
      }).map((row) => {
        const owner = row.owner_account_id === accountCtx.accountId;
        const tasks = owner ? ["upload", "view"] : parseJson(row.tasks_json, []);
        const managementScopes = owner ? [...SCOPES].sort() : parseJson(row.management_scopes_json, []);
        return { spaceId: row.id, name: row.name, spaceLifecycle: row.space_lifecycle,
          collectionState: row.collection_state, sharingState: row.sharing_state, version: row.version,
          owner, tasks, managementScopes, effectiveCanView: tasks.includes("view"), effectiveCanUpload: tasks.includes("upload") };
      })
    };
  }

  // A v2 ("全自动链路", superseding the v1 "放行闸门 -> 事后下架工具" framing below):
  // Max's in-person correction was that a confidently auto-placed photo (CLIP
  // classification "same_scene_high" -> placement_state='confirmed', see
  // services/jobs/dispatch/index.mjs's placement()) must take zero manual touches —
  // it must not appear in *any* queue just because nobody has "acknowledged" it.
  // So this stays the plain, original pending/hidden/rejected query; a photo that
  // auto-approved straight to 'visible' but also auto-placed with high confidence
  // never shows up here at all. A photo auto-approved to 'visible' whose placement
  // *isn't* confident (needs_confirmation/failed — CLIP low-confidence, an
  // unrelated image, or a sidecar failure) still needs a human, but that need is
  // placement-shaped, not content-shaped — it surfaces via queues.placement below
  // ("疑似待复核"), not here. (An earlier version of this method widened this query
  // with an OR NOT EXISTS(photo_content_events) clause to also surface
  // already-fine auto-approved photos for optional post-hoc review; that was
  // superseded by this correction and removed — see git history if that capability
  // is wanted back later.)
  management(accountCtx, spaceId) {
    const access = this.core.anyManagement(accountCtx, spaceId);
    const scopes = access.owner ? [...SCOPES].sort() : parseJson(access.membership.management_scopes_json, []);
    const scene = this.core.one("SELECT * FROM scenes WHERE space_id=?", spaceId);
    return {
      spaceId, name: access.space.name, version: access.space.version, scopes,
      sceneVersion: scene.version,
      space: { spaceId, name: access.space.name, version: access.space.version, owner: access.owner,
        spaceLifecycle: access.space.space_lifecycle, collectionState: access.space.collection_state,
        sharingState: access.space.sharing_state, currentWorldResultId: access.space.current_world_result_id, currentPanoramaRevisionId: access.space.current_panorama_revision_id,
        sceneId: scene.id, sceneVersion: scene.version, sceneReadiness: scene.scene_readiness, sceneMode: scene.scene_mode },
      wishes: parseJson(access.space.wishes_json, []),
      autoApproveUploads: Boolean(access.space.auto_approve_uploads),
      queues: {
        review: scopes.includes("canReview") ? this.core.all("SELECT id,photo_content_state,version FROM photos WHERE space_id=? AND photo_content_state!='visible' AND deleted_at IS NULL", spaceId) : undefined,
        // A v2: needs_confirmation/failed is exactly "CLIP couldn't confidently place
        // this" ("疑似待复核") — see placementQueueLabel() in templates.js for the
        // owner-facing copy. Each row's primary action opens the placement editor
        // (placementEditorPage), which now also carries the content takedown actions
        // (hide/reject) so this one screen is the full "复核+定位" workflow — see
        // PlacementService#editView() below for the projection those actions need.
        placement: scopes.includes("canEditPlacement") ? this.core.all("SELECT id,placement_state,version FROM photos WHERE space_id=? AND placement_state IN ('needs_confirmation','failed','stale') AND deleted_at IS NULL", spaceId) : undefined,
        scene: scopes.includes("canManageScene") ? this.core.all("SELECT id,status,version FROM panorama_candidates WHERE space_id=? ORDER BY rowid DESC", spaceId) : undefined
      },
      // C ("待你确认"聚合视图 + "缺口"方向格, host-panel worktree): both additive,
      // canEditPlacement-gated like queues.placement above — confirmedPlacementCount
      // tells the "待你确认" spotlight whether the machine has auto-placed *anything*
      // yet (needsConfirmation-only spotlight text differs when it hasn't — see
      // needsConfirmationSection() in apps/web/src/ui/templates.js), and
      // missingDirections is the 12-bucket 30° coverage gap list.
      confirmedPlacementCount: scopes.includes("canEditPlacement")
        ? this.core.one("SELECT COUNT(*) c FROM photos WHERE space_id=? AND placement_state='confirmed' AND deleted_at IS NULL", spaceId).c
        : undefined,
      missingDirections: scopes.includes("canEditPlacement") ? this.#missingDirectionBuckets(spaceId) : undefined
    };
  }

  // 12 x 30° yaw coverage gaps: hand-verified against production data (see the
  // host-panel task brief) — `photos.current_placement_revision_id` joins
  // placement_revisions for `yaw` (the column is `yaw`, not `yaw_deg` — migration
  // 0001's placement_revisions table). `r.yaw IS NOT NULL` is an addition on top of
  // the hand-verified query: SQLite's `NOT IN` goes NULL (neither true nor false) the
  // instant the subquery contains one NULL, which would silently mark every bucket
  // "covered" the first time a confirmed placement ever has a null yaw. Every
  // confirmed placement carries a yaw in practice, but this keeps that an invariant
  // this query doesn't depend on.
  #missingDirectionBuckets(spaceId) {
    return this.core.all(`WITH RECURSIVE b(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM b WHERE i<11),
      covered AS (
        SELECT DISTINCT CAST(((r.yaw % 360) + 360) % 360 / 30 AS INT) AS bucket
        FROM photos p JOIN placement_revisions r ON r.id = p.current_placement_revision_id
        WHERE p.space_id = ? AND p.placement_state = 'confirmed' AND p.deleted_at IS NULL AND r.yaw IS NOT NULL
      )
      SELECT i FROM b WHERE i NOT IN (SELECT bucket FROM covered)`, spaceId).map((row) => row.i);
  }

  nextTarget(accountCtx, spaceId, query = {}) {
    const view = this.management(accountCtx, spaceId);
    const kind = query.queueKind ?? ["review", "placement", "scene"].find((key) => view.queues[key]);
    assert(["content", "review", "placement", "scene", undefined].includes(kind), "invalid_queue_kind", 400);
    const normalized = kind === "content" ? "review" : kind;
    const target = view.queues[normalized]?.find((item) => item.id !== query.afterTargetId);
    return target ? { outcome: "target", targetType: normalized, targetId: target.id,
      targetRoute: normalized === "scene" ? `/manage/${spaceId}/scene` : `/manage/${spaceId}/${normalized}/${target.id}`,
      serverVersions: { space: view.version, target: target.version } } : { outcome: "empty" };
  }

  transitionCollection(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["to"], ["to"]);
    enumValue(body.to, ["open", "paused"]);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/collection-transitions`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      this.core.requireIfMatch(ctx, access.space);
      assert(access.space.collection_state !== body.to, "transition_not_allowed", 409);
      this.db.prepare("UPDATE spaces SET collection_state=?,version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(body.to, this.core.now(), spaceId, access.space.version);
      this.core.audit({ spaceId, aggregateType: "space", aggregateId: spaceId, eventType: "collection_changed",
        actorKind: "space_owner", authorizationId: spaceId, detail: { from: access.space.collection_state, to: body.to }, requestId: ctx.requestId });
      return { spaceId, collectionState: body.to, version: access.space.version + 1 };
    });
  }

  // A: owner-only toggle for the space-level "上传自动通过" switch. Same
  // idempotent {to} transition shape as transitionCollection above (ownerOnly
  // rather than a management scope — this decides whether unmoderated
  // uploads go straight to public-visible, a higher-trust call than the
  // canPublish-gated sharing toggle). Flipping it only changes how *future*
  // commits land (upload-service.mjs reads the column fresh per commit); it
  // never touches already-existing photos either way.
  transitionAutoApproveUploads(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["to"], ["to"]);
    enumValue(body.to, ["on", "off"]);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/auto-approve-uploads-transitions`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      this.core.requireIfMatch(ctx, access.space);
      const to = body.to === "on" ? 1 : 0;
      assert(Boolean(access.space.auto_approve_uploads) !== Boolean(to), "transition_not_allowed", 409);
      this.db.prepare("UPDATE spaces SET auto_approve_uploads=?,version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(to, this.core.now(), spaceId, access.space.version);
      this.core.audit({ spaceId, aggregateType: "space", aggregateId: spaceId, eventType: "auto_approve_uploads_changed",
        actorKind: "space_owner", authorizationId: spaceId, detail: { from: Boolean(access.space.auto_approve_uploads), to: Boolean(to) }, requestId: ctx.requestId });
      return { spaceId, autoApproveUploads: Boolean(to), version: access.space.version + 1 };
    });
  }

  transitionSharing(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["to"], ["to"]);
    enumValue(body.to, ["private", "shared"]);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/sharing-transitions`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { scope: "canPublish" }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { scope: "canPublish" });
      this.core.requireIfMatch(ctx, access.space);
      assert(access.space.sharing_state !== body.to, "transition_not_allowed", 409);
      this.db.prepare("UPDATE spaces SET sharing_state=?,version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(body.to, this.core.now(), spaceId, access.space.version);
      if (body.to === "private") {
        this.db.prepare("UPDATE viewer_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=?")
          .run(this.core.now(), spaceId);
      }
      this.core.audit({ spaceId, aggregateType: "space", aggregateId: spaceId, eventType: "sharing_changed",
        actorKind: access.authKind, authorizationId: access.authorizationId, detail: { from: access.space.sharing_state, to: body.to }, requestId: ctx.requestId });
      return { spaceId, sharingState: body.to, version: access.space.version + 1 };
    });
  }

  // Wish wall: owner replaces the whole list in one call (add/edit/remove are
  // all just "submit the new full list"), capped at 6 short prompts. Guests
  // see the result via ReadService/UploadService projections; no per-wish id
  // is needed since there is nothing else to reference a single wish by.
  updateWishes(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["wishes"], ["wishes"]);
    assert(Array.isArray(body.wishes) && body.wishes.length <= 6, "validation_failed", 400);
    const wishes = body.wishes.map((wish) => string(wish, { max: 40 }));
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/wishes`, method: "PATCH", scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      this.core.requireIfMatch(ctx, access.space);
      this.db.prepare("UPDATE spaces SET wishes_json=?,version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(json(wishes), this.core.now(), spaceId, access.space.version);
      this.core.audit({ spaceId, aggregateType: "space", aggregateId: spaceId, eventType: "wishes_changed",
        actorKind: "space_owner", authorizationId: spaceId, detail: { count: wishes.length }, requestId: ctx.requestId });
      return { spaceId, wishes, version: access.space.version + 1 };
    });
  }

  createMemberInvitation(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["verifiedIdentifier", "tasks", "managementScopes", "expiresAt"],
      ["verifiedIdentifier", "tasks", "managementScopes", "expiresAt"]);
    const tasks = setValues(body.tasks, TASKS);
    const scopes = setValues(body.managementScopes, SCOPES);
    const expiresAt = new Date(body.expiresAt).toISOString();
    assert(Date.parse(expiresAt) > this.core.nowMs(), "target_identifier_invalid");
    return this.core.mutation(ctx, {
      endpoint: `/v1/spaces/${spaceId}/member-invitations`, scope: accountCtx.session.id, replayClass: "secret_once_envelope",
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true })
    }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      this.core.requireIfMatch(ctx, access.space);
      const identity = this.identity.ensureIdentity(body.verifiedIdentifier);
      const raw = secret();
      const credential = this.core.keyring.credential("member-invitation-v1", raw);
      const invitationId = id("mi");
      this.db.prepare(`INSERT INTO member_invitations(
        id,space_id,target_identifier_equivalence_id,tasks_json,management_scopes_json,credential_mac,credential_key_id,
        expires_at,created_by,version
      ) VALUES(?,?,?,?,?,?,?,?,?,1)`).run(invitationId, spaceId, identity.equivalenceId, json(tasks), json(scopes),
      credential.mac, credential.keyId, expiresAt, accountCtx.accountId);
      this.core.audit({ spaceId, aggregateType: "member_invitation", aggregateId: invitationId, eventType: "created",
        actorKind: "space_owner", authorizationId: spaceId, detail: { targetMask: identity.mask, tasks, scopes, expiresAt }, requestId: ctx.requestId });
      return { invitationId, invitationBootstrapUrlOnce: `/member-invitations/accept#invite=${raw}`,
        oneTimeSecret: raw, targetMask: identity.mask, expiresAt, version: 1 };
    });
  }

  acceptMemberInvitation(ctx, accountCtx) {
    const body = object(ctx.body, ["secretFromClearedInviteBootstrap", "clientNonce"], ["secretFromClearedInviteBootstrap"]);
    const presented = this.core.keyring.credential("member-invitation-v1", body.secretFromClearedInviteBootstrap);
    const scope = `member-invite:${presented.mac.toString("hex")}`;
    const result = this.core.mutation(ctx, { endpoint: "/v1/member-invitation-acceptances", scope, replayClass: "completed_state" }, () => {
      const invitation = this.core.one("SELECT * FROM member_invitations WHERE credential_key_id=? AND credential_mac=?", presented.keyId, presented.mac);
      const verified = this.core.one("SELECT * FROM account_verified_identifiers WHERE account_id=? AND status='active'", accountCtx.accountId);
      const space = invitation ? this.core.one("SELECT * FROM spaces WHERE id=?", invitation.space_id) : null;
      const valid = invitation && verified && space && verified.identifier_equivalence_id === invitation.target_identifier_equivalence_id &&
        space.space_lifecycle === "active" && !invitation.accepted_at && !invitation.revoked_at &&
        Date.parse(invitation.expires_at) > this.core.nowMs();
      if (!valid) return { _error: "member_invite_unavailable" };
      const existing = this.core.one("SELECT * FROM space_memberships WHERE space_id=? AND account_id=?", space.id, accountCtx.accountId);
      if (existing && existing.status === "active") return { _error: "member_invite_unavailable" };
      const membershipId = existing?.id ?? id("mem");
      if (existing) {
        this.db.prepare(`UPDATE space_memberships SET tasks_json=?,management_scopes_json=?,status='active',accepted_at=?,revoked_at=NULL,version=version+1 WHERE id=?`)
          .run(invitation.tasks_json, invitation.management_scopes_json, this.core.now(), membershipId);
      } else {
        this.db.prepare(`INSERT INTO space_memberships(
          id,space_id,account_id,tasks_json,management_scopes_json,status,version,created_by,accepted_at
        ) VALUES(?,?,?,?,?,'active',1,?,?)`).run(membershipId, space.id, accountCtx.accountId,
        invitation.tasks_json, invitation.management_scopes_json, invitation.created_by, this.core.now());
      }
      this.db.prepare("UPDATE member_invitations SET accepted_at=?,credential_mac=NULL,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), invitation.id, invitation.version);
      this.core.audit({ spaceId: space.id, aggregateType: "membership", aggregateId: membershipId, eventType: "accepted",
        actorKind: "account", authorizationId: accountCtx.session.id, detail: { invitationId: invitation.id }, requestId: ctx.requestId });
      return { membershipId, spaceId: space.id, accountId: accountCtx.accountId, tasks: parseJson(invitation.tasks_json),
        managementScopes: parseJson(invitation.management_scopes_json), version: existing ? existing.version + 1 : 1 };
    });
    if (result._error) throw new ApiError("member_invite_unavailable", 404);
    return result;
  }

  revokeMemberInvitation(ctx, accountCtx, invitationId) {
    return this.core.mutation(ctx, { endpoint: `/v1/member-invitations/${invitationId}/revocations`, scope: accountCtx.session.id,
      reauthorize: () => {
        const current = this.core.one("SELECT space_id FROM member_invitations WHERE id=?", invitationId);
        assert(current, "member_invitation_unavailable", 404);
        return this.core.accountSpace(this.core.account(ctx.accountSession), current.space_id, { ownerOnly: true });
      } }, () => {
      const invitation = this.core.one("SELECT * FROM member_invitations WHERE id=?", invitationId);
      assert(invitation, "member_invitation_unavailable", 404);
      this.core.accountSpace(accountCtx, invitation.space_id, { ownerOnly: true });
      this.core.requireIfMatch(ctx, invitation);
      assert(!invitation.revoked_at && !invitation.accepted_at, "member_invitation_unavailable", 404);
      this.db.prepare("UPDATE member_invitations SET revoked_at=?,credential_mac=NULL,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), invitation.id, invitation.version);
      return { invitationId, revokedAt: this.core.now(), version: invitation.version + 1 };
    });
  }

  updateMembership(ctx, accountCtx, spaceId, membershipId) {
    const body = object(ctx.body, ["tasks", "managementScopes"], ["tasks", "managementScopes"]);
    const tasks = setValues(body.tasks, TASKS);
    const scopes = setValues(body.managementScopes, SCOPES);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/memberships/${membershipId}`, method: "PATCH", scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true }) }, () => {
      this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      const membership = this.core.one("SELECT * FROM space_memberships WHERE id=? AND space_id=? AND status='active'", membershipId, spaceId);
      assert(membership, "membership_unavailable", 404);
      this.core.requireIfMatch(ctx, membership);
      this.db.prepare("UPDATE space_memberships SET tasks_json=?,management_scopes_json=?,version=version+1 WHERE id=? AND version=?")
        .run(json(tasks), json(scopes), membershipId, membership.version);
      return { membershipId, spaceId, tasks, managementScopes: scopes, version: membership.version + 1 };
    });
  }

  revokeMembership(ctx, accountCtx, spaceId, membershipId) {
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/memberships/${membershipId}`, method: "DELETE", scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      const membership = this.core.one("SELECT * FROM space_memberships WHERE id=? AND space_id=? AND status='active'", membershipId, spaceId);
      assert(membership, "membership_unavailable", 404);
      assert(membership.account_id !== access.space.owner_account_id, "owner_membership_immutable", 409);
      this.core.requireIfMatch(ctx, membership);
      this.db.prepare("UPDATE space_memberships SET status='revoked',revoked_at=?,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), membershipId, membership.version);
      return { membershipId, revokedAt: this.core.now(), version: membership.version + 1 };
    });
  }

  archive(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["reauthGrant", "reason"], ["reauthGrant"]);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/archive`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true, allowArchived: true }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      this.core.requireIfMatch(ctx, access.space);
      this.identity.consumeReauth(body.reauthGrant, accountCtx, { actionId: "SPACE.ARCHIVE", purpose: "space_archive", targetType: "space", targetId: spaceId });
      assert(access.space.space_lifecycle === "active", "transition_not_allowed", 409);
      const now = this.core.now();
      this.db.prepare("UPDATE spaces SET space_lifecycle='archived',collection_state='paused',sharing_state='private',version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(now, spaceId, access.space.version);
      this.db.prepare("UPDATE external_invitation_campaigns SET campaign_status='revoked',revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=? AND campaign_status IN ('active','paused','exhausted')")
        .run(now, spaceId);
      this.db.prepare("UPDATE member_invitations SET revoked_at=COALESCE(revoked_at,?),credential_mac=NULL,version=version+1 WHERE space_id=? AND revoked_at IS NULL AND accepted_at IS NULL")
        .run(now, spaceId);
      for (const table of ["viewer_sessions", "contributor_sessions", "receipt_sessions"]) {
        this.db.prepare(`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE space_id=?`).run(now, spaceId);
      }
      this.core.audit({ spaceId, aggregateType: "space", aggregateId: spaceId, eventType: "archived", actorKind: "space_owner",
        authorizationId: spaceId, detail: { reason: body.reason ?? null }, requestId: ctx.requestId });
      return { spaceId, spaceLifecycle: "archived", collectionState: "paused", sharingState: "private", version: access.space.version + 1 };
    });
  }

  unarchive(ctx, accountCtx, spaceId) {
    const body = object(ctx.body, ["reauthGrant", "sharingState", "collectionState"], ["reauthGrant", "sharingState", "collectionState"]);
    assert(body.sharingState === "private" && body.collectionState === "paused", "transition_not_allowed", 409);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/unarchive`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true, allowArchived: true }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true, allowArchived: true });
      this.core.requireIfMatch(ctx, access.space);
      this.identity.consumeReauth(body.reauthGrant, accountCtx, { actionId: "SPACE.RESTORE", purpose: "space_restore", targetType: "space", targetId: spaceId });
      assert(access.space.space_lifecycle === "archived", "transition_not_allowed", 409);
      this.db.prepare("UPDATE spaces SET space_lifecycle='active',collection_state='paused',sharing_state='private',version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(this.core.now(), spaceId, access.space.version);
      return { spaceId, spaceLifecycle: "active", collectionState: "paused", sharingState: "private", version: access.space.version + 1 };
    });
  }

  listOwnerTransfers(accountCtx) {
    this.sweepOwnerTransfers();
    return { transfers: this.core.all(`SELECT id transferId,space_id spaceId,status,expires_at expiresAt,version
      FROM owner_transfers WHERE target_account_id=? AND status IN ('pending','expired') ORDER BY created_at DESC`,
    accountCtx.accountId) };
  }

  sweepOwnerTransfers() {
    const now = this.core.now();
    const expired = this.db.prepare(`UPDATE owner_transfers SET status='expired',version=version+1
      WHERE status='pending' AND expires_at<=?`).run(now);
    return { expired: expired.changes, cutoffAt: now };
  }

  createOwnerTransfer(ctx, accountCtx, spaceId) {
    this.sweepOwnerTransfers();
    const body = object(ctx.body, ["targetMembershipId", "reauthGrant", "ifMatchVersion"], ["targetMembershipId", "reauthGrant", "ifMatchVersion"]);
    return this.core.mutation(ctx, { endpoint: `/v1/spaces/${spaceId}/owner-transfers`, scope: accountCtx.session.id,
      reauthorize: () => this.core.accountSpace(this.core.account(ctx.accountSession), spaceId, { ownerOnly: true }) }, () => {
      const access = this.core.accountSpace(accountCtx, spaceId, { ownerOnly: true });
      assert(Number(body.ifMatchVersion) === access.space.version, "version_conflict", 409);
      const membership = this.core.one("SELECT * FROM space_memberships WHERE id=? AND space_id=? AND status='active'", body.targetMembershipId, spaceId);
      assert(membership, "target_membership_invalid", 409);
      assert(!this.core.one("SELECT 1 FROM owner_transfers WHERE space_id=? AND status='pending'", spaceId), "transfer_conflict", 409);
      this.identity.consumeReauth(body.reauthGrant, accountCtx, { actionId: "OWNER_TRANSFER.CREATE", purpose: "owner_transfer_create", targetType: "space", targetId: spaceId });
      const transferId = id("ot");
      const expiresAt = new Date(this.core.nowMs() + 24 * 60 * 60_000).toISOString();
      this.db.prepare(`INSERT INTO owner_transfers(
        id,space_id,from_owner_account_id,target_account_id,target_membership_id,status,space_version_at_create,expires_at,created_at,version
      ) VALUES(?,?,?,?,?,'pending',?,?,?,1)`).run(transferId, spaceId, accountCtx.accountId, membership.account_id, membership.id,
      access.space.version, expiresAt, this.core.now());
      return { transferId, targetAccountId: membership.account_id, expiresAt, version: 1 };
    });
  }

  acceptOwnerTransfer(ctx, accountCtx) {
    this.sweepOwnerTransfers();
    const body = object(ctx.body, ["transferId", "reauthGrant", "ifMatchVersion"], ["transferId", "reauthGrant", "ifMatchVersion"]);
    return this.core.mutation(ctx, { endpoint: "/v1/owner-transfer-acceptances", scope: accountCtx.session.id,
      replayClass: "completed_state", reauthorize: () => {
        const currentAccount = this.core.account(ctx.accountSession);
        const current = this.core.one("SELECT * FROM owner_transfers WHERE id=?", body.transferId);
        assert(current && current.target_account_id === currentAccount.accountId, "owner_transfer_unavailable", 404);
        const access = this.core.accountSpace(currentAccount, current.space_id);
        assert(access.owner || access.membership?.id === current.target_membership_id,
          "owner_transfer_unavailable", 404);
        return access;
      } }, () => {
      const transfer = this.core.one("SELECT * FROM owner_transfers WHERE id=?", body.transferId);
      assert(transfer && transfer.target_account_id === accountCtx.accountId && transfer.status === "pending" &&
        Date.parse(transfer.expires_at) > this.core.nowMs() && transfer.version === Number(body.ifMatchVersion), "owner_transfer_unavailable", 404);
      const space = this.core.one("SELECT * FROM spaces WHERE id=?", transfer.space_id);
      const membership = this.core.one("SELECT * FROM space_memberships WHERE id=? AND status='active'", transfer.target_membership_id);
      assert(space && membership && membership.account_id === accountCtx.accountId && space.owner_account_id === transfer.from_owner_account_id &&
        space.version === transfer.space_version_at_create, "owner_transfer_unavailable", 404);
      this.identity.consumeReauth(body.reauthGrant, accountCtx, { actionId: "OWNER_TRANSFER.ACCEPT", purpose: "owner_transfer_accept", targetType: "space", targetId: space.id });
      this.db.prepare("UPDATE spaces SET owner_account_id=?,version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(accountCtx.accountId, this.core.now(), space.id, space.version);
      this.db.prepare("UPDATE owner_transfers SET status='accepted',accepted_at=?,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), transfer.id, transfer.version);
      return { spaceId: space.id, newOwnerAccountId: accountCtx.accountId, spaceVersion: space.version + 1, transferVersion: transfer.version + 1 };
    });
  }

  revokeOwnerTransfer(ctx, accountCtx, transferId) {
    this.sweepOwnerTransfers();
    const body = object(ctx.body, ["ifMatchVersion", "reason"], ["ifMatchVersion"]);
    return this.core.mutation(ctx, { endpoint: `/v1/owner-transfers/${transferId}/revocations`, scope: accountCtx.session.id,
      replayClass: "completed_state", reauthorize: () => {
        const current = this.core.one("SELECT space_id FROM owner_transfers WHERE id=?", transferId);
        assert(current, "owner_transfer_unavailable", 404);
        return this.core.accountSpace(this.core.account(ctx.accountSession), current.space_id, { ownerOnly: true });
      } }, () => {
      const transfer = this.core.one("SELECT * FROM owner_transfers WHERE id=?", transferId);
      assert(transfer && transfer.status === "pending" && transfer.version === Number(body.ifMatchVersion), "owner_transfer_unavailable", 404);
      this.core.accountSpace(accountCtx, transfer.space_id, { ownerOnly: true });
      this.db.prepare("UPDATE owner_transfers SET status='revoked',revoked_at=?,version=version+1 WHERE id=? AND version=?")
        .run(this.core.now(), transfer.id, transfer.version);
      return { transferId, revokedAt: this.core.now(), version: transfer.version + 1 };
    });
  }
}
