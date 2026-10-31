import { sha256 } from "./util.mjs";
import { assert } from "./errors.mjs";
import {
  IDENTITY_ENVELOPE_FORMAT,
  identityEnvelopeAad,
  normalizeEmail,
} from "./crypto.mjs";
export class AdminOperationsService {
  constructor(admin) {
    this.admin = admin;
    this.core = admin.core;
  }
  ownedSpace(target, spaceId) {
    this.admin.inspectionTarget(target);
    const space = this.core.one(
      "SELECT * FROM spaces WHERE id=? AND owner_account_id=?",
      spaceId,
      target,
    );
    assert(space, "space_unavailable", 404);
    return space;
  }
  spaceAsset(target, space, kind) {
    const anyImport = this.core.one(
      "SELECT account_id FROM app_spatial_imports WHERE space_id=?",
      space.id,
    );
    if (anyImport && anyImport.account_id !== target)
      return { asset: null, current: false };
    const imported = this.core.one(
      "SELECT * FROM app_spatial_imports WHERE account_id=? AND space_id=? ORDER BY panorama_revision_id=(SELECT current_panorama_revision_id FROM spaces WHERE id=app_spatial_imports.space_id) DESC,rowid DESC LIMIT 1",
      target,
      space.id,
    );
    const revision = this.core.one(
      "SELECT * FROM panorama_revisions WHERE id=? AND space_id=?",
      space.current_panorama_revision_id,
      space.id,
    );
    if (!revision) return { asset: null, current: false };
    let assetId = revision.asset_id,
      current = true;
    if (kind === "depth") {
      if (imported) {
        assetId = imported.depth_asset_id;
        try {
          current =
            JSON.parse(imported.depth_metadata_json ?? "null")
              ?.sourcePanoramaRevisionId === revision.id;
        } catch {
          current = false;
        }
      } else {
        const artifact = this.core.one(
          "SELECT depth_asset_id FROM scene_depth_artifacts WHERE space_id=? AND scene_id=? AND panorama_revision_id=?",
          space.id,
          space.scene_id,
          revision.id,
        );
        assetId = artifact?.depth_asset_id ?? null;
      }
    }
    const asset = assetId
      ? this.core.one(
          "SELECT * FROM assets WHERE id=? AND space_id=? AND kind=? AND validation_state='valid'",
          assetId,
          space.id,
          kind === "panorama" ? "panorama" : "depth_map",
        )
      : null;
    return { asset, current };
  }
  spaceDto(target, space) {
    const imported = this.core.one(
      "SELECT * FROM app_spatial_imports WHERE account_id=? AND space_id=? ORDER BY panorama_revision_id=(SELECT current_panorama_revision_id FROM spaces WHERE id=app_spatial_imports.space_id) DESC,rowid DESC LIMIT 1",
      target,
      space.id,
    );
    const media = (kind) => {
      const { asset, current } = this.spaceAsset(target, space, kind),
        available = Boolean(
          asset && current && space.space_lifecycle === "active",
        );
      return {
        exists: Boolean(asset),
        available,
        url: available
          ? `/v1/admin/accounts/${target}/spaces/${space.id}/media/${kind}`
          : null,
        unavailableReason: available
          ? null
          : !asset
            ? "asset_unavailable"
            : space.space_lifecycle !== "active"
              ? "space_archived"
              : "depth_revision_changed",
      };
    };
    return {
      id: space.id,
      name: space.name,
      lifecycle: space.space_lifecycle,
      sharingState: space.sharing_state,
      collectionState: space.collection_state,
      createdAt: space.created_at,
      updatedAt: space.updated_at,
      version: space.version,
      source:
        imported ||
        this.core.one(
          "SELECT 1 FROM app_spatial_imports WHERE space_id=?",
          space.id,
        )
          ? "app-import"
          : "canonical",
      clientId: imported?.client_id ?? null,
      photoCount: this.core.one(
        "SELECT COUNT(*) n FROM photos WHERE space_id=? AND deleted_at IS NULL",
        space.id,
      ).n,
      jobCount: this.core.one(
        "SELECT COUNT(*) n FROM jobs WHERE space_id=?",
        space.id,
      ).n,
      panorama: media("panorama"),
      depth: media("depth"),
    };
  }
  spaces(ctx, target) {
    const actor = this.admin.superAdmin(ctx);
    this.admin.inspectionTarget(target);
    const p = this.admin.page(ctx.query),
      rows = this.core.all(
        "SELECT * FROM spaces WHERE owner_account_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
        target,
        p.pageSize,
        (p.page - 1) * p.pageSize,
      );
    this.admin.inspectionAudit(actor, "admin_spaces_read", "account", target);
    return {
      spaces: rows.map((row) => this.spaceDto(target, row)),
      total: this.core.one(
        "SELECT COUNT(*) n FROM spaces WHERE owner_account_id=?",
        target,
      ).n,
      ...p,
    };
  }
  space(ctx, target, spaceId) {
    const actor = this.admin.superAdmin(ctx),
      space = this.ownedSpace(target, spaceId),
      dto = this.spaceDto(target, space);
    const jobs = this.core
      .all(
        "SELECT id,type,status,attempts,created_at createdAt,updated_at updatedAt,stable_error errorCode FROM jobs WHERE space_id=? ORDER BY created_at DESC,id LIMIT 100",
        space.id,
      )
      .map((job) => ({
        ...job,
        errorCode:
          job.errorCode && !/^[a-z][a-z0-9_]{0,79}$/.test(job.errorCode)
            ? "unclassified_error"
            : job.errorCode,
      }));
    this.admin.inspectionAudit(
      actor,
      "admin_space_read",
      "account_space",
      `${target}/${spaceId}`,
    );
    return {
      space: dto,
      jobs,
      jobsTotal: dto.jobCount,
      jobsTruncated: dto.jobCount > jobs.length,
    };
  }
  async spaceMedia(ctx, target, spaceId, kind) {
    const actor = this.admin.superAdmin(ctx),
      space = this.ownedSpace(target, spaceId);
    assert(
      ["panorama", "depth"].includes(kind) &&
        space.space_lifecycle === "active",
      "spatial_unavailable",
      404,
    );
    const { asset, current } = this.spaceAsset(target, space, kind);
    assert(asset && current, "spatial_unavailable", 404);
    const stored = await this.appSpatial.api.mediaStore.get(
      asset.private_object_key,
      { maxBytes: 32 * 1024 * 1024 },
    );
    assert(
      sha256(stored.body) === asset.raw_sha256,
      "spatial_integrity_failed",
      503,
    );
    this.admin.superAdmin(ctx);
    const updated = this.ownedSpace(target, spaceId),
      selection = this.spaceAsset(target, updated, kind);
    assert(
      updated.space_lifecycle === "active" &&
        updated.current_panorama_revision_id ===
          space.current_panorama_revision_id &&
        selection.current &&
        selection.asset?.id === asset.id &&
        selection.asset?.raw_sha256 === asset.raw_sha256 &&
        selection.asset?.private_object_key === asset.private_object_key,
      "spatial_unavailable",
      404,
    );
    this.admin.inspectionAudit(
      actor,
      "admin_space_media_read",
      "account_space_media",
      `${target}/${spaceId}/${kind}`,
    );
    return {
      _raw: stored.body,
      headers: {
        "content-type": asset.observed_mime,
        "cache-control": "no-store, private",
        "content-length": String(stored.body.length),
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
      },
    };
  }
  avatarInfo(target) {
    const account = this.core.one(
      "SELECT status FROM accounts WHERE id=?",
      target,
    );
    if (account?.status !== "active")
      return { hasAvatar: false, avatarAvailable: false, avatarUrl: null };
    const value = this.admin.passwords.profile({ accountId: target }).user
      .avatar;
    const match = value?.match(
      /^\/v1\/moment-media\/([A-Za-z0-9_-]{1,96})(\/preview)?$/,
    );
    let available = false;
    try {
      if (match) {
        const doc = this.admin.moments.mediaDocument(
          { accountId: target },
          match[1],
        );
        available = doc.kind === "photo" && (!match[2] || Boolean(doc.preview));
      }
    } catch {}
    return {
      hasAvatar: Boolean(value),
      avatarAvailable: available,
      avatarUrl: available
        ? `/v1/admin/accounts/${target}/avatar${match[2] ?? ""}`
        : null,
    };
  }
  avatar(ctx, target, preview) {
    const actor = this.admin.superAdmin(ctx);
    this.admin.inspectionTarget(target);
    const info = this.avatarInfo(target),
      expected = `/v1/admin/accounts/${target}/avatar${preview ? "/preview" : ""}`;
    assert(
      info.avatarAvailable && info.avatarUrl === expected,
      "avatar_unavailable",
      404,
    );
    const path = this.admin.passwords.profile({ accountId: target }).user
        .avatar,
      mid = path.split("/")[3];
    const result = this.admin.moments.getMedia(
      { accountId: target },
      mid,
      preview,
      ctx.headers.range,
    );
    this.admin.inspectionAudit(actor, "admin_avatar_read", "account", target);
    return result;
  }
  spacePhoto(target, spaceId, photoId) {
    const space = this.ownedSpace(target, spaceId);
    const photo = this.core.one(
      "SELECT * FROM photos WHERE id=? AND space_id=? AND deleted_at IS NULL",
      photoId,
      spaceId,
    );
    assert(photo, "photo_unavailable", 404);
    return { space, photo };
  }
  photoAsset(spaceId, photo, kind) {
    if (kind === "video" && photo.media_type !== "video") return null;
    return this.core.one(
      "SELECT * FROM assets WHERE id=? AND space_id=? AND kind=? AND validation_state='valid' AND metadata_policy_result='exif_gps_stripped'",
      kind === "video" ? photo.video_asset_id : photo.viewer_safe_asset_id,
      spaceId,
      kind === "video" ? "video_viewer_safe" : "photo_viewer_safe",
    );
  }
  photos(ctx, target, spaceId) {
    const actor = this.admin.superAdmin(ctx),
      space = this.ownedSpace(target, spaceId),
      p = this.admin.page(ctx.query);
    const rows = this.core.all(
      "SELECT * FROM photos WHERE space_id=? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT ? OFFSET ?",
      spaceId,
      p.pageSize,
      (p.page - 1) * p.pageSize,
    );
    const photos = rows.map((photo) => {
      const media = (kind) => {
        const asset = this.photoAsset(spaceId, photo, kind),
          available = Boolean(asset && space.space_lifecycle === "active");
        return {
          available,
          url: available
            ? `/v1/admin/accounts/${target}/spaces/${spaceId}/photos/${photo.id}/${kind === "video" ? "video" : "media"}`
            : null,
          unavailableReason: available
            ? null
            : !asset
              ? "safe_asset_unavailable"
              : "space_archived",
        };
      };
      return {
        id: photo.id,
        mediaType: photo.media_type,
        contentState: photo.photo_content_state,
        placementState: photo.placement_state,
        version: photo.version,
        capturedAt: photo.captured_at,
        createdAt: null,
        preview: media("preview"),
        video: media("video"),
      };
    });
    this.admin.inspectionAudit(
      actor,
      "admin_space_photos_read",
      "account_space",
      `${target}/${spaceId}`,
    );
    return {
      photos,
      total: this.core.one(
        "SELECT COUNT(*) n FROM photos WHERE space_id=? AND deleted_at IS NULL",
        spaceId,
      ).n,
      ...p,
    };
  }
  async photoMedia(ctx, target, spaceId, photoId, kind) {
    const actor = this.admin.superAdmin(ctx),
      { space, photo } = this.spacePhoto(target, spaceId, photoId);
    assert(space.space_lifecycle === "active", "photo_unavailable", 404);
    const asset = this.photoAsset(spaceId, photo, kind);
    assert(asset, "photo_unavailable", 404);
    const result = await this.appSpatial.api.viewerMedia.serve(
      { range: ctx.headers.range },
      {},
      asset,
    );
    this.admin.superAdmin(ctx);
    const updated = this.spacePhoto(target, spaceId, photoId),
      current = this.photoAsset(spaceId, updated.photo, kind);
    assert(
      updated.space.space_lifecycle === "active" &&
        current?.id === asset.id &&
        current?.raw_sha256 === asset.raw_sha256 &&
        current?.private_object_key === asset.private_object_key,
      "photo_unavailable",
      404,
    );
    this.admin.inspectionAudit(
      actor,
      "admin_space_photo_media_read",
      "account_space_photo",
      `${target}/${spaceId}/${photoId}/${kind}`,
    );
    result.headers["cache-control"] = "no-store, private";
    return result;
  }
  activeAdminCount() {
    return this.core.one(
      "SELECT COUNT(*) n FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE m.is_admin=1 AND m.status='active' AND a.status='active'",
    ).n;
  }
  revoke(target) {
    const now = this.core.now();
    this.core.db
      .prepare(
        "UPDATE accounts SET session_epoch=session_epoch+1,version=version+1 WHERE id=?",
      )
      .run(target);
    this.core.db
      .prepare(
        "UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=? AND revoked_at IS NULL",
      )
      .run(now, target);
    this.core.db
      .prepare(
        "UPDATE account_session_families SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=? AND revoked_at IS NULL",
      )
      .run(now, target);
  }
  role(ctx, target) {
    const actor = this.admin.superAdmin(ctx),
      reason = this.admin.reason(ctx.body.reason);
    assert(actor.accountId !== target, "cannot_change_own_role", 409);
    const role =
      ctx.body.adminRole ??
      (typeof ctx.body.isAdmin === "boolean"
        ? ctx.body.isAdmin
          ? "admin"
          : "user"
        : null);
    assert(["user", "admin"].includes(role), "role_not_assignable", 400);
    if (ctx.body.isAdmin !== undefined)
      assert(ctx.body.isAdmin === (role === "admin"), "role_invalid", 400);
    const result = this.admin.write(
      ctx,
      actor,
      `/v1/admin/accounts/${target}/role`,
      () => {
        this.admin.superAdmin(ctx);
        const old = this.admin.account(target);
        this.admin.requireOperable(actor, old);
        assert(
          ctx.body.expectedVersion === old.version,
          "version_conflict",
          409,
        );
        if (role === "admin")
          assert(old.status === "active", "account_not_active", 409);
        if (old.adminRole === role) return { accountId: target };
        this.core.db
          .prepare(
            "INSERT INTO account_administration(account_id,is_admin,admin_role) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET is_admin=excluded.is_admin,admin_role=excluded.admin_role",
          )
          .run(target, role === "admin" ? 1 : 0, role);
        this.revoke(target);
        this.admin.audit(
          actor,
          "account_role",
          "account",
          target,
          old.adminRole,
          role,
          reason,
        );
        return { accountId: target };
      },
    );
    return {
      account: this.admin.accountFor(actor, target),
      ...(result.replayed ? { replayed: true } : {}),
    };
  }
  sessionRows(target) {
    const a = this.admin.account(target),
      row = this.core.one(
        "SELECT session_epoch FROM accounts WHERE id=?",
        target,
      );
    return this.core
      .all(
        `SELECT s.id,f.created_at createdAt,s.expires_at expiresAt,s.revoked_at revokedAt,f.revoked_at familyRevokedAt,f.last_reauthenticated_at lastReauthenticatedAt,s.version,s.issued_session_epoch sessionEpoch,f.issued_session_epoch familyEpoch FROM account_sessions s JOIN account_session_families f ON f.id=s.family_id WHERE s.account_id=? ORDER BY f.created_at DESC,s.id`,
        target,
      )
      .map((s) => {
        const { sessionEpoch, familyEpoch, ...dto } = s;
        return {
          ...dto,
          active:
            a.status === "active" &&
            !s.revokedAt &&
            !s.familyRevokedAt &&
            Date.parse(s.expiresAt) > this.core.nowMs() &&
            sessionEpoch === row.session_epoch &&
            familyEpoch === row.session_epoch,
        };
      });
  }
  sessions(ctx, target) {
    const actor = this.admin.superAdmin(ctx),
      p = this.admin.page(ctx.query),
      rows = this.sessionRows(target);
    this.admin.inspectionAudit(actor, "admin_sessions_read", "account", target);
    return {
      sessions: rows.slice((p.page - 1) * p.pageSize, p.page * p.pageSize),
      total: rows.length,
      ...p,
    };
  }
  revokeSessions(ctx, target) {
    const actor = this.admin.admin(ctx),
      reason = this.admin.reason(ctx.body.reason);
    assert(actor.accountId !== target, "cannot_revoke_own_sessions", 409);
    const result = this.admin.write(
      ctx,
      actor,
      `/v1/admin/accounts/${target}/sessions/revoke`,
      () => {
        const old = this.admin.account(target);
        this.admin.requireOperable(actor, old);
        assert(
          ctx.body.expectedVersion === old.version,
          "version_conflict",
          409,
        );
        assert(
          this.sessionRows(target).some((s) => s.active),
          "active_session_required",
          409,
        );
        this.revoke(target);
        this.admin.audit(
          actor,
          "account_sessions_revoked",
          "account",
          target,
          "active",
          "revoked",
          reason,
        );
        return { accountId: target };
      },
    );
    return {
      account: this.admin.accountFor(actor, target),
      ...(result.replayed ? { replayed: true } : {}),
    };
  }
  submissions(ctx, target) {
    const actor = this.admin.admin(ctx);
    this.admin.account(target);
    const p = this.admin.page(ctx.query);
    const rows = this.core.all(
      "SELECT * FROM moment_submissions WHERE account_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
      target,
      p.pageSize,
      (p.page - 1) * p.pageSize,
    );
    this.admin.inspectionAudit(
      actor,
      "admin_account_submissions_read",
      "account",
      target,
    );
    return {
      submissions: rows.map((r) => this.admin.dto(r)),
      total: this.core.one(
        "SELECT COUNT(*) n FROM moment_submissions WHERE account_id=?",
        target,
      ).n,
      ...p,
    };
  }
  details(target) {
    const account = this.core.one(
      "SELECT status FROM accounts WHERE id=?",
      target,
    );
    const profile = this.admin.passwords.profile({ accountId: target });
    const password = this.core.one(
      "SELECT created_at,updated_at FROM account_password_credentials WHERE account_id=?",
      target,
    );
    const groups = this.core.all(
      "SELECT record_kind recordKind,CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'trash' END state,COUNT(*) count,COALESCE(SUM(byte_length),0) bytes FROM personal_memories WHERE account_id=? GROUP BY record_kind,state ORDER BY record_kind,state",
      target,
    );
    const emailRelationships = [];
    if (account.status === "active")
      for (const row of this.core.all(
        `SELECT e.*,v.status relation_status,v.verified_at,v.revoked_at FROM account_verified_identifiers v JOIN identifier_equivalences e ON e.id=v.identifier_equivalence_id WHERE v.account_id=? ORDER BY v.verified_at,v.id`,
        target,
      )) {
        let email = null,
          emailUnavailable = false;
        try {
          assert(
            row.normalized_identifier_ciphertext &&
              row.normalized_identifier_envelope_format ===
                IDENTITY_ENVELOPE_FORMAT,
            "identity_unavailable",
          );
          email = normalizeEmail(
            this.core.keyring.openIdentity(
              row.normalized_identifier_ciphertext,
              identityEnvelopeAad(
                row.id,
                row.identity_type,
                row.normalized_identifier_envelope_format,
              ),
              row.normalized_identifier_envelope_key_id,
            ),
          );
          assert(
            this.core.keyring.equal(
              this.core.keyring.equivalentEmailForKey(
                email,
                row.collision_key_epoch,
              ),
              row.normalized_collision_key,
            ),
            "identity_invalid",
          );
        } catch {
          email = null;
          emailUnavailable = true;
        }
        emailRelationships.push({
          email,
          emailUnavailable,
          verifiedAt: row.verified_at,
          revokedAt: row.revoked_at,
          status: row.relation_status,
          identityStatus: row.status,
          aliases: this.core.all(
            "SELECT display_mask displayMask,status,created_at createdAt,grace_expires_at graceExpiresAt FROM account_verified_identifier_aliases WHERE identifier_equivalence_id=? ORDER BY created_at,id",
            row.id,
          ),
        });
      }
    return {
      profile: {
        displayName: profile.user.displayName,
        preferences: profile.user.preferences,
        ...this.avatarInfo(target),
        hasStoredProfile: profile.version > 0,
        version: profile.version,
      },
      password: {
        isSet: Boolean(password),
        createdAt: password?.created_at ?? null,
        credentialUpdatedAt: password?.updated_at ?? null,
      },
      emailRelationships,
      storage: {
        scope: "personal_memories",
        groups,
        recordCount: groups.reduce((n, g) => n + g.count, 0),
        bytes: groups.reduce((n, g) => n + g.bytes, 0),
        limits: {
          recordBytes: 24 * 1024 * 1024,
          accountBytes: 128 * 1024 * 1024,
          records: 1000,
        },
      },
    };
  }
  metrics(privateData = true) {
    const since = new Date(this.core.nowMs() - 7 * 86400000).toISOString();
    if (!privateData)
      return {
        admins: this.activeAdminCount(),
        registrationsLast7Days: this.core.one(
          "SELECT COUNT(*) n FROM accounts WHERE created_at>=?",
          since,
        ).n,
        lastLoginLast7Days: this.core.one(
          "SELECT COUNT(*) n FROM account_administration WHERE last_login_at>=?",
          since,
        ).n,
        lastLoginCollected: this.core.one(
          "SELECT COUNT(*) n FROM account_administration WHERE last_login_at IS NOT NULL",
        ).n,
        privateMoments: null,
        photos: null,
        audio: null,
        mediaRecords: null,
        storageBytes: null,
        pendingRegistrationsOver7Days: this.core.one(
          "SELECT COUNT(*) n FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE m.status='pending' AND a.status='active' AND a.created_at<?",
          since,
        ).n,
        pendingSubmissionsOver7Days: this.core.one(
          "SELECT COUNT(*) n FROM moment_submissions WHERE status='pending' AND created_at<?",
          since,
        ).n,
      };
    const photos = new Set(),
      audio = new Set();
    const available = new Set(
      this.core
        .all(
          "SELECT p.account_id,p.id FROM personal_memories p JOIN accounts a ON a.id=p.account_id WHERE p.record_kind='moment-media' AND p.deleted_at IS NULL AND a.status='active'",
        )
        .map((r) => `${r.account_id}/${r.id.slice("moment-media:".length)}`),
    );
    for (const row of this.core.db
      .prepare(
        "SELECT p.account_id,p.id FROM personal_memories p JOIN accounts a ON a.id=p.account_id WHERE p.record_kind='moment' AND p.deleted_at IS NULL AND a.status='active'",
      )
      .iterate()) {
      const moment = this.admin.moments.records.get(
        { accountId: row.account_id },
        row.id,
      ).document;
      for (const photo of moment.photos)
        for (const mid of [photo.mediaId, photo.originalMediaId])
          if (mid && available.has(`${row.account_id}/${mid}`))
            photos.add(`${row.account_id}/${mid}`);
      for (const message of moment.messages)
        if (
          message.audio?.mediaId &&
          available.has(`${row.account_id}/${message.audio.mediaId}`)
        )
          audio.add(`${row.account_id}/${message.audio.mediaId}`);
    }
    return {
      admins: this.activeAdminCount(),
      registrationsLast7Days: this.core.one(
        "SELECT COUNT(*) n FROM accounts WHERE created_at>=?",
        since,
      ).n,
      lastLoginLast7Days: this.core.one(
        "SELECT COUNT(*) n FROM account_administration WHERE last_login_at>=?",
        since,
      ).n,
      lastLoginCollected: this.core.one(
        "SELECT COUNT(*) n FROM account_administration WHERE last_login_at IS NOT NULL",
      ).n,
      privateMoments: this.core.one(
        "SELECT COUNT(*) n FROM personal_memories p JOIN accounts a ON a.id=p.account_id WHERE p.record_kind='moment' AND p.deleted_at IS NULL AND a.status='active'",
      ).n,
      photos: photos.size,
      audio: audio.size,
      mediaRecords: available.size,
      storageBytes: this.core.one(
        "SELECT COALESCE(SUM(byte_length),0) n FROM personal_memories",
      ).n,
      pendingRegistrationsOver7Days: this.core.one(
        "SELECT COUNT(*) n FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE m.status='pending' AND a.status='active' AND a.created_at<?",
        since,
      ).n,
      pendingSubmissionsOver7Days: this.core.one(
        "SELECT COUNT(*) n FROM moment_submissions WHERE status='pending' AND created_at<?",
        since,
      ).n,
    };
  }
}
