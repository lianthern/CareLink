import { adminPermissions } from "./admin-permissions.mjs";
import { AdminOperationsService } from "./admin-operations-service.mjs";
import {
  IDENTITY_ENVELOPE_FORMAT,
  identityEnvelopeAad,
  normalizeEmail,
} from "./crypto.mjs";
import { assert } from "./errors.mjs";
import { id } from "./util.mjs";
import { PersonalMemoryService } from "./personal-memory-service.mjs";

export function requireAccountAdmission(core, accountId) {
  const state =
    core.one(
      "SELECT status FROM account_administration WHERE account_id=?",
      accountId,
    )?.status ?? "active";
  assert(state === "active", `account_${state}`, 403);
}
export class AdminService {
  constructor(core, passwords, moments) {
    this.core = core;
    this.passwords = passwords;
    this.moments = moments;
    this.snapshots = new PersonalMemoryService(core);
    this.operations = new AdminOperationsService(this);
  }
  admin(ctx) {
    const a = this.core.account(ctx.accountSession);
    assert(
      this.core.one(
        "SELECT is_admin FROM account_administration WHERE account_id=?",
        a.accountId,
      )?.is_admin === 1,
      "admin_required",
      403,
    );
    return a;
  }
  permissions(actor) {
    return adminPermissions(this.core, actor.accountId);
  }
  superAdmin(ctx) {
    const actor = this.admin(ctx);
    assert(
      this.permissions(actor).adminRole === "super_admin",
      "super_admin_required",
      403,
    );
    return actor;
  }
  canOperate(actor, target) {
    return (
      actor.accountId !== target.id &&
      target.adminRole !== "super_admin" &&
      (this.permissions(actor).adminRole === "super_admin" ||
        target.adminRole === "user")
    );
  }
  requireOperable(actor, target) {
    assert(this.canOperate(actor, target), "admin_target_protected", 403);
  }
  accountFor(actor, target) {
    const account = typeof target === "string" ? this.account(target) : target,
      highest = this.permissions(actor).adminRole === "super_admin";
    return {
      ...account,
      ...(!highest ? { momentCount: null, storageBytes: null } : {}),
      allowedActions: {
        canManageStatus: this.canOperate(actor, account),
        canManageRole: highest && this.canOperate(actor, account),
        canRevokeSessions: this.canOperate(actor, account),
        canInspectPrivateData: highest,
      },
    };
  }
  page(query) {
    const page = Number(query.page ?? 1),
      pageSize = Number(query.pageSize ?? 20);
    assert(
      Number.isSafeInteger(page) &&
        page > 0 &&
        Number.isSafeInteger(pageSize) &&
        pageSize > 0 &&
        pageSize <= 100,
      "pagination_invalid",
    );
    return { page, pageSize };
  }
  audit(
    actor,
    action,
    targetType,
    targetId,
    beforeStatus,
    afterStatus,
    reason,
  ) {
    this.core.db
      .prepare("INSERT INTO administration_audit VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id("audit"),
        actor.accountId,
        this.passwords.profile(actor).user.displayName,
        action,
        targetType,
        targetId,
        beforeStatus,
        afterStatus,
        reason,
        this.core.now(),
      );
  }
  accountEmails(accountId) {
    const rows = this.core.all(
      `SELECT e.*,v.verified_at,v.status verified_status FROM account_verified_identifiers v
      JOIN identifier_equivalences e ON e.id=v.identifier_equivalence_id
      WHERE v.account_id=? AND v.status='active' AND e.status='active' AND e.identity_type='email_v1' AND EXISTS(SELECT 1 FROM account_verified_identifier_aliases a WHERE a.identifier_equivalence_id=e.id AND a.status='current') ORDER BY v.verified_at,v.id`,
      accountId,
    );
    const emails = [];
    let emailUnavailable = false;
    for (const row of rows) {
      try {
        assert(
          row.normalized_identifier_ciphertext &&
            row.normalized_identifier_envelope_key_id &&
            row.normalized_identifier_envelope_format ===
              IDENTITY_ENVELOPE_FORMAT,
          "identity_envelope_unavailable",
        );
        const email = normalizeEmail(
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
          "identity_envelope_invalid",
        );
        emails.push({
          email,
          verifiedAt: row.verified_at,
          status: row.verified_status,
        });
      } catch {
        emailUnavailable = true;
      }
    }
    return { emails, emailUnavailable };
  }
  inspectionAudit(actor, action, targetType, targetId) {
    // Only stable IDs and a fixed reason: never persist decrypted identity or document text.
    this.core.db
      .prepare("INSERT INTO administration_audit VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id("audit"),
        actor.accountId,
        actor.accountId,
        action,
        targetType,
        targetId,
        null,
        null,
        "管理员授权查阅",
        this.core.now(),
      );
  }
  inspectAccount(ctx, accountId) {
    const actor = this.admin(ctx),
      account = this.accountFor(actor, accountId);
    this.inspectionAudit(actor, "admin_account_read", "account", accountId);
    return {
      account: {
        ...account,
        ...(this.permissions(actor).adminRole === "super_admin"
          ? { details: this.operations.details(accountId) }
          : {}),
      },
    };
  }
  inspectionTarget(accountId) {
    const row = this.core.one(
      "SELECT status FROM accounts WHERE id=?",
      accountId,
    );
    assert(row?.status === "active", "account_unavailable", 404);
    return { accountId };
  }
  privateMoments(ctx, accountId) {
    const actor = this.superAdmin(ctx),
      target = this.inspectionTarget(accountId),
      p = this.page(ctx.query);
    const total = this.core.one(
      "SELECT COUNT(*) n FROM personal_memories WHERE account_id=? AND record_kind='moment' AND deleted_at IS NULL",
      accountId,
    ).n;
    const rows = this.core.all(
      "SELECT id,version FROM personal_memories WHERE account_id=? AND record_kind='moment' AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
      accountId,
      p.pageSize,
      (p.page - 1) * p.pageSize,
    );
    const moments = rows.map((row) => {
      const m = this.moments.records.get(target, row.id).document;
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        photoCount: m.photos.length,
        messageCount: m.messages.length,
        hasAudio: m.messages.some((message) => Boolean(message.audio)),
        version: row.version,
      };
    });
    this.inspectionAudit(
      actor,
      "admin_private_moments_read",
      "account",
      accountId,
    );
    return { moments, total, ...p };
  }
  privateMoment(ctx, accountId, momentId) {
    const actor = this.superAdmin(ctx),
      target = this.inspectionTarget(accountId),
      result = this.moments.get(target, momentId);
    const base = `/v1/admin/accounts/${accountId}/moments/${momentId}/media`;
    for (const photo of result.moment.photos) {
      photo.url = `${base}/${photo.mediaId}${photo.url.endsWith("/preview") ? "/preview" : ""}`;
      if (photo.originalMediaId)
        photo.originalUrl = `${base}/${photo.originalMediaId}`;
    }
    for (const message of result.moment.messages)
      if (message.audio) message.audio.url = `${base}/${message.audio.mediaId}`;
    this.inspectionAudit(
      actor,
      "admin_private_moment_read",
      "account_moment",
      `${accountId}/${momentId}`,
    );
    return {
      targetAccountId: accountId,
      moment: result.moment,
      version: result.version,
    };
  }
  privateMedia(ctx, accountId, momentId, mediaId, preview) {
    const actor = this.superAdmin(ctx),
      target = this.inspectionTarget(accountId),
      { moment } = this.moments.get(target, momentId);
    const referenced =
      moment.photos.some(
        (photo) =>
          photo.mediaId === mediaId || photo.originalMediaId === mediaId,
      ) ||
      moment.messages.some((message) => message.audio?.mediaId === mediaId);
    assert(referenced, "moment_media_unavailable", 404);
    const result = this.moments.getMedia(
      target,
      mediaId,
      preview,
      ctx.headers.range,
    );
    this.inspectionAudit(
      actor,
      "admin_private_media_read",
      "account_moment_media",
      `${accountId}/${momentId}/${mediaId}${preview ? "/preview" : ""}`,
    );
    return result;
  }
  accountDto(row) {
    const a = { accountId: row.id },
      profile = this.passwords.profile(a).user;
    const usage = this.core.one(
      "SELECT COUNT(CASE WHEN record_kind='moment' AND deleted_at IS NULL THEN 1 END) count,COALESCE(SUM(byte_length),0) bytes FROM personal_memories WHERE account_id=?",
      row.id,
    );
    const state = this.core.one(
      "SELECT * FROM account_administration WHERE account_id=?",
      row.id,
    );
    const { emails, emailUnavailable } =
      row.status === "active"
        ? this.accountEmails(row.id)
        : { emails: [], emailUnavailable: false };
    const email =
      emails.find((entry) => entry.status === "active")?.email ?? null;
    const loginLabel = profile.username ?? email ?? row.id;
    return {
      id: row.id,
      username: profile.username,
      loginLabel,
      emails,
      email,
      emailUnavailable,
      displayName: profile.displayName,
      source: profile.username ? "password" : "email-otp",
      status:
        row.status === "active" ? (state?.status ?? "active") : row.status,
      ...adminPermissions(this.core, row.id),
      createdAt: row.created_at,
      lastLoginAt: state?.last_login_at ?? null,
      momentCount: usage.count,
      storageBytes: usage.bytes,
      version: row.version,
    };
  }
  account(id) {
    const row = this.core.one("SELECT * FROM accounts WHERE id=?", id);
    assert(row, "account_unavailable", 404);
    return this.accountDto(row);
  }
  accounts(ctx) {
    const actor = this.admin(ctx);
    const p = this.page(ctx.query),
      q = String(ctx.query.q ?? "")
        .trim()
        .toLowerCase();
    assert(
      q.length <= 200 &&
        (!ctx.query.role ||
          ["admin", "user", "super_admin", "administrators"].includes(ctx.query.role)) &&
        (!ctx.query.source ||
          ["password", "email-otp"].includes(ctx.query.source)),
      "query_invalid",
    );
    const all = this.core
      .all("SELECT * FROM accounts ORDER BY created_at DESC,id")
      .map((r) => this.accountFor(actor, this.accountDto(r)))
      .filter(
        (a) =>
          (!ctx.query.status || a.status === ctx.query.status) &&
          (!ctx.query.role ||
            (ctx.query.role === "administrators"
              ? ["admin", "super_admin"].includes(a.adminRole)
              : a.adminRole === ctx.query.role)) &&
          (!ctx.query.source || a.source === ctx.query.source) &&
          (!q ||
            [
              a.id,
              a.username,
              a.displayName,
              a.loginLabel,
              ...a.emails.map((entry) => entry.email),
            ].some((v) => v?.toLowerCase().includes(q))),
      );
    this.inspectionAudit(actor, "admin_accounts_read", "accounts", "all");
    return {
      accounts: all.slice((p.page - 1) * p.pageSize, p.page * p.pageSize),
      total: all.length,
      ...p,
    };
  }
  actions(ctx) {
    const actor = this.admin(ctx),
      highest = this.permissions(actor).adminRole === "super_admin";
    const p = this.page(ctx.query),
      clauses = [],
      params = [];
    if (!highest)
      clauses.push(
        "action IN ('account_status','account_sessions_revoked','submission_created','submission_status','submission_presentation','community_space_approve','community_space_reject','community_space_unpublish','community_space_restore','community_space_presentation','community_space_preview','community_space_media','community_case_presentation') AND target_type IN ('account','submission','community_space_submission','community_case')",
      );
    for (const [key, column] of [
      ["actorId", "actor_id"],
      ["targetId", "target_id"],
      ["action", "action"],
    ])
      if (ctx.query[key]) {
        assert(ctx.query[key].length <= 200, "query_invalid");
        clauses.push(`${column}=?`);
        params.push(ctx.query[key]);
      }
    for (const [key, op] of [
      ["dateFrom", ">="],
      ["dateTo", "<="],
    ])
      if (ctx.query[key]) {
        assert(Number.isFinite(Date.parse(ctx.query[key])), "query_invalid");
        clauses.push(`created_at${op}?`);
        params.push(
          new Date(
            Date.parse(ctx.query[key]) +
              (key === "dateTo" && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query[key])
                ? 86400000 - 1
                : 0),
          ).toISOString(),
        );
      }
    if (ctx.query.category) {
      assert(
        ["read", "mutation"].includes(ctx.query.category),
        "query_invalid",
      );
      clauses.push(
        ctx.query.category === "read"
          ? "action LIKE 'admin_%_read'"
          : "action NOT LIKE 'admin_%_read'",
      );
    }
    if (ctx.query.accountId) {
      const target = ctx.query.accountId;
      assert(target.length <= 128, "query_invalid");
      clauses.push(
        "(actor_id=? OR target_id=? OR (target_type IN ('account_moment','account_moment_media','account_space','account_space_media','account_space_photo') AND substr(target_id,1,length(?)+1)=?||'/') OR (target_type='submission' AND target_id IN (SELECT id FROM moment_submissions WHERE account_id=?)))",
      );
      params.push(target, target, target, target, target);
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    return {
      actions: this.core
        .all(
          "SELECT id,actor_id actorId,actor_name actorName,action,target_type targetType,target_id targetId,before_status beforeStatus,after_status afterStatus,reason,created_at createdAt FROM administration_audit" +
            where +
            " ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?",
          ...params,
          p.pageSize,
          (p.page - 1) * p.pageSize,
        )
        .map((row) =>
          highest ? row : { ...row, actorName: row.actorId, reason: null },
        ),
      total: this.core.one(
        "SELECT COUNT(*) n FROM administration_audit" + where,
        ...params,
      ).n,
      ...p,
    };
  }
  overview(ctx) {
    const actor = this.admin(ctx);
    return {
      counts: {
        ...this.operations.metrics(
          this.permissions(actor).adminRole === "super_admin",
        ),
        accounts: this.core.one("SELECT COUNT(*) n FROM accounts").n,
        pendingRegistrations: this.core.one(
          "SELECT COUNT(*) n FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE m.status='pending' AND a.status='active'",
        ).n,
        pendingSubmissions: this.core.one(
          "SELECT COUNT(*) n FROM moment_submissions WHERE status='pending'",
        ).n,
        published: this.core.one(
          "SELECT COUNT(*) n FROM moment_submissions WHERE status='published'",
        ).n,
      },
      recentActions: this.actions({ ...ctx, query: { pageSize: 10 } }).actions,
    };
  }
  reason(value) {
    assert(
      typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 1000,
      "reason_required",
    );
    return value.trim();
  }
  write(ctx, actor, endpoint, fn) {
    this.moments.records.requireExpectedAccount(ctx, actor);
    return this.core.mutation(
      ctx,
      { endpoint, scope: actor.accountId, reauthorize: () => this.admin(ctx) },
      fn,
    );
  }
  status(ctx, target) {
    const actor = this.admin(ctx),
      reason = this.reason(ctx.body.reason);
    const result = this.write(
      ctx,
      actor,
      `/v1/admin/accounts/${target}/status`,
      () => {
        const old = this.account(target),
          status = ctx.body.status;
        if (target === actor.accountId && status === "disabled")
          assert(false, "cannot_disable_self", 409);
        this.requireOperable(actor, old);
        assert(
          ctx.body.expectedVersion === old.version,
          "version_conflict",
          409,
        );
        assert(
          (
            {
              pending: ["active", "rejected"],
              active: ["disabled"],
              disabled: ["active"],
              rejected: ["active"],
            }[old.status] ?? []
          ).includes(status),
          "account_transition_invalid",
          409,
        );
        if (status === "disabled") {
          assert(target !== actor.accountId, "cannot_disable_self", 409);
          if (old.isAdmin)
            assert(
              this.core.one(
                "SELECT COUNT(*) n FROM account_administration m JOIN accounts a ON a.id=m.account_id WHERE m.is_admin=1 AND m.status='active' AND a.status='active'",
              ).n > 1,
              "last_admin_required",
              409,
            );
        }
        this.core.db
          .prepare(
            "INSERT INTO account_administration(account_id,status) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET status=excluded.status",
          )
          .run(target, status);
        this.core.db
          .prepare(
            "UPDATE accounts SET version=version+1,session_epoch=session_epoch+1 WHERE id=?",
          )
          .run(target);
        this.core.db
          .prepare(
            "UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE account_id=?",
          )
          .run(this.core.now(), target);
        this.audit(
          actor,
          "account_status",
          "account",
          target,
          old.status,
          status,
          reason,
        );
        return { accountId: target };
      },
    );
    return {
      account: this.accountFor(actor, target),
      ...(result.replayed ? { replayed: true } : {}),
    };
  }
  submission(id) {
    const r = this.core.one("SELECT * FROM moment_submissions WHERE id=?", id);
    assert(r, "submission_unavailable", 404);
    return r;
  }
  dto(r) {
    return {
      id: r.id,
      authorId: r.account_id,
      authorName: r.author_name,
      featured: !!r.featured,
      sortRank: r.sort_rank,
      momentId: r.moment_id,
      accountId: r.account_id,
      username:
        this.core.one(
          "SELECT username FROM account_password_credentials WHERE account_id=?",
          r.account_id,
        )?.username ?? null,
      title: r.title,
      status: r.status,
      reason: r.reason,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
      version: r.version,
      publicUrl: r.status === "published" ? `/app#public/${r.id}` : null,
    };
  }
  submit(ctx, account, momentId) {
    this.moments.records.requireExpectedAccount(ctx, account);
    assert(ctx.body.consent === true, "publication_consent_required");
    return this.core.mutation(
      ctx,
      {
        endpoint: `/v1/moments/${momentId}/submissions`,
        scope: account.accountId,
      },
      () => {
        const current = this.moments.get(account, momentId);
        assert(
          ctx.body.expectedVersion === current.version,
          "version_conflict",
          409,
        );
        assert(
          !this.core.one(
            "SELECT 1 FROM moment_submissions WHERE account_id=? AND moment_id=? AND status IN ('pending','published')",
            account.accountId,
            momentId,
          ),
          "submission_already_active",
          409,
        );
        const sid = id("sub"),
          snapshotId = `submission:${sid}`,
          media = Object.create(null);
        for (const p of current.moment.photos)
          for (const key of ["mediaId", "originalMediaId"])
            if (p[key])
              media[p[key]] = this.moments.mediaDocument(account, p[key]);
        for (const m of current.moment.messages)
          if (m.audio)
            media[m.audio.mediaId] = this.moments.mediaDocument(
              account,
              m.audio.mediaId,
            );
        const mediaRefs = Object.fromEntries(
          Object.keys(media).map((mid, index) => [
            mid,
            `${snapshotId}:media:${index}`,
          ]),
        );
        const records = [
          {
            id: snapshotId,
            document: JSON.stringify({
              moment: current.moment,
              media: mediaRefs,
            }),
          },
          ...Object.entries(media).map(([mid, value]) => ({
            id: mediaRefs[mid],
            document: JSON.stringify(value),
          })),
        ];
        const usage = this.core.one(
          "SELECT COALESCE(SUM(byte_length),0) bytes,COUNT(*) count FROM personal_memories WHERE account_id=?",
          account.accountId,
        );
        assert(
          records.every(
            (r) => Buffer.byteLength(r.document) <= 24 * 1024 * 1024,
          ) &&
            records.reduce((n, r) => n + Buffer.byteLength(r.document), 0) +
              usage.bytes <=
              128 * 1024 * 1024 &&
            usage.count + records.length <= 1000,
          "memory_storage_limit",
          413,
        );
        for (const record of records)
          this.core.db
            .prepare(
              "INSERT INTO personal_memories(account_id,id,document_ciphertext,envelope_key_id,byte_length,version,created_at,updated_at,record_kind) VALUES(?,?,?,?,?,1,?,?,'snapshot')",
            )
            .run(
              account.accountId,
              record.id,
              this.core.keyring.seal(
                record.document,
                `personal-memory-v1:${account.accountId}:${record.id}`,
              ),
              this.core.keyring.keyId,
              Buffer.byteLength(record.document),
              this.core.now(),
              this.core.now(),
            );
        this.core.db
          .prepare(
            "INSERT INTO moment_submissions(id,account_id,moment_id,snapshot_id,title,author_name,cover_media_id,cover_preview,status,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)",
          )
          .run(
            sid,
            account.accountId,
            momentId,
            snapshotId,
            current.moment.title,
            this.passwords.profile(account).user.displayName,
            current.moment.photos[0]?.mediaId ?? null,
            current.moment.photos[0]?.url?.endsWith("/preview") ? 1 : 0,
            this.core.now(),
          );
        this.audit(
          account,
          "submission_created",
          "submission",
          sid,
          null,
          "pending",
          "用户明确同意公开投稿",
        );
        return { submission: this.dto(this.submission(sid)) };
      },
    );
  }
  mine(account) {
    return {
      submissions: this.core
        .all(
          "SELECT * FROM moment_submissions WHERE account_id=? ORDER BY created_at DESC,rowid DESC",
          account.accountId,
        )
        .map((r) => this.dto(r)),
    };
  }
  submissionFilters(query, alias = "s") {
    const clauses = [], values = [];
    if (query.authorId) { clauses.push(`${alias}.account_id=?`); values.push(query.authorId); }
    if (query.q) {
      assert(typeof query.q === "string" && query.q.length <= 200, "query_invalid");
      clauses.push(`(instr(lower(${alias}.title),lower(?))>0 OR instr(lower(${alias}.author_name),lower(?))>0)`);
      values.push(query.q, query.q);
    }
    if (query.featured !== undefined) {
      assert(["true", "false"].includes(query.featured), "featured_invalid");
      clauses.push(`${alias}.featured=?`); values.push(query.featured === "true" ? 1 : 0);
    }
    return { clauses, values };
  }
  submissions(ctx) {
    this.admin(ctx);
    const p = this.page(ctx.query), status = ctx.query.status ?? "pending";
    const {clauses, values} = this.submissionFilters(ctx.query);
    if (status) { clauses.push("s.status=?"); values.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return {
      submissions: this.core.all(`SELECT s.* FROM moment_submissions s ${where} ORDER BY s.featured DESC,s.sort_rank,s.created_at DESC,s.id LIMIT ? OFFSET ?`, ...values, p.pageSize, (p.page-1)*p.pageSize).map(r=>this.dto(r)),
      total: this.core.one(`SELECT COUNT(*) n FROM moment_submissions s ${where}`, ...values).n,
      ...p,
    };
  }
  snapshot(r) {
    const row = this.snapshots.row({ accountId: r.account_id }, r.snapshot_id);
    assert(row && !row.deleted_at, "submission_unavailable", 404);
    return this.snapshots.get({ accountId: r.account_id }, r.snapshot_id)
      .document;
  }
  readable(ctx, sid, publicRead) {
    if (!publicRead) this.admin(ctx);
    const r = this.submission(sid);
    const account = this.core.one(
      "SELECT status FROM accounts WHERE id=?",
      r.account_id,
    );
    assert(account?.status === "active", "submission_unavailable", 404);
    if (publicRead)
      assert(
        r.status === "published" &&
          (this.core.one(
            "SELECT status FROM account_administration WHERE account_id=?",
            r.account_id,
          )?.status ?? "active") === "active",
        "submission_unavailable",
        404,
      );
    return r;
  }
  detail(ctx, sid, publicRead = false) {
    const r = this.readable(ctx, sid, publicRead),
      { moment } = this.snapshot(r),
      base = publicRead
        ? `/v1/public/moments/${sid}/media`
        : `/v1/admin/submissions/${sid}/media`;
    for (const p of moment.photos) {
      p.url = `${base}/${p.mediaId}${p.url.endsWith("/preview") ? "/preview" : ""}`;
      if (p.originalMediaId) p.originalUrl = `${base}/${p.originalMediaId}`;
    }
    for (const m of moment.messages)
      if (m.audio) m.audio.url = `${base}/${m.audio.mediaId}`;
    return {
      submission: publicRead ? this.publicDto(r) : this.dto(r),
      moment,
    };
  }
  media(ctx, sid, mid, preview, publicRead) {
    const r = this.readable(ctx, sid, publicRead),
      frozen = this.snapshot(r).media;
    assert(Object.hasOwn(frozen, mid), "moment_media_unavailable", 404);
    return this.moments.getMedia.call(
      {
        mediaDocument: () =>
          this.snapshots.get({ accountId: r.account_id }, frozen[mid]).document,
      },
      null,
      mid,
      preview,
      ctx.headers.range,
    );
  }
  review(ctx, sid) {
    const actor = this.admin(ctx),
      reason = this.reason(ctx.body.reason);
    return this.write(ctx, actor, `/v1/admin/submissions/${sid}/review`, () => {
      const r = this.submission(sid),
        decision = ctx.body.decision;
      assert(ctx.body.expectedVersion === r.version, "version_conflict", 409);
      assert(
        (r.status === "pending" && ["approve", "reject"].includes(decision)) ||
          (r.status === "published" && decision === "unpublish") ||
          (r.status === "unpublished" && decision === "restore"),
        "submission_transition_invalid",
        409,
      );
      const status = {
        approve: "published",
        reject: "rejected",
        unpublish: "unpublished",
        restore: "published",
      }[decision];
      if (status === "published") {
        requireAccountAdmission(this.core, r.account_id);
        assert(
          this.core.one("SELECT status FROM accounts WHERE id=?", r.account_id)
            ?.status === "active",
          "account_unavailable",
          409,
        );
        this.snapshot(r);
        assert(!this.core.one("SELECT 1 FROM moment_submissions WHERE account_id=? AND moment_id=? AND id<>? AND status IN ('pending','published')", r.account_id, r.moment_id, sid), "submission_already_active", 409);
      }
      this.transition(actor, r, status, reason);
      return { submission: this.dto(this.submission(sid)) };
    });
  }
  transition(actor, r, status, reason) {
    this.core.db
      .prepare(
        "UPDATE moment_submissions SET status=?,reason=?,reviewed_at=?,version=version+1 WHERE id=?",
      )
      .run(status, reason, this.core.now(), r.id);
    this.audit(
      actor,
      "submission_status",
      "submission",
      r.id,
      r.status,
      status,
      reason,
    );
  }
  withdraw(ctx, account, sid) {
    this.moments.records.requireExpectedAccount(ctx, account);
    return this.core.mutation(
      ctx,
      {
        endpoint: `/v1/me/submissions/${sid}/withdraw`,
        scope: account.accountId,
      },
      () => {
        const r = this.submission(sid);
        assert(
          r.account_id === account.accountId,
          "submission_unavailable",
          404,
        );
        assert(ctx.body.expectedVersion === r.version, "version_conflict", 409);
        assert(
          ["pending", "published", "rejected", "unpublished"].includes(
            r.status,
          ),
          "submission_transition_invalid",
          409,
        );
        this.transition(account, r, "withdrawn", "作者撤回");
        return { submission: this.dto(this.submission(sid)) };
      },
    );
  }
  presentation(ctx, sid) {
    const actor=this.admin(ctx), reason=this.reason(ctx.body.reason);
    const {featured,sortRank}=ctx.body;
    assert(typeof featured === "boolean" && Number.isSafeInteger(sortRank) && Math.abs(sortRank)<=1000000,"presentation_invalid");
    return this.write(ctx,actor,`/v1/admin/submissions/${sid}/presentation`,()=>{
      const r=this.submission(sid);
      assert(ctx.body.expectedVersion===r.version,"version_conflict",409);
      assert(r.status==="published","submission_transition_invalid",409);
      if (!!r.featured!==featured || r.sort_rank!==sortRank) {
        this.core.db.prepare("UPDATE moment_submissions SET featured=?,sort_rank=?,version=version+1 WHERE id=?").run(featured?1:0,sortRank,sid);
        this.audit(actor,"submission_presentation","submission",sid,JSON.stringify({featured:!!r.featured,sortRank:r.sort_rank}),JSON.stringify({featured,sortRank}),reason);
      }
      return {submission:this.dto(this.submission(sid))};
    });
  }
  publicDto(r) {
    return {
      id:r.id,title:r.title,authorId:r.account_id,authorName:r.author_name,
      status:r.status,version:r.version,featured:!!r.featured,sortRank:r.sort_rank,
      coverPhotoUrl:r.cover_media_id ? `/v1/public/moments/${r.id}/media/${r.cover_media_id}${r.cover_preview ? "/preview" : ""}` : null,
      createdAt:r.created_at,publishedAt:r.reviewed_at,publicUrl:`/app#public/${r.id}`,
    };
  }
  publicList(ctx = {query:{}}) {
    const query=ctx.query ?? {}, p=this.page({...query,pageSize:query.pageSize??100});
    const {clauses,values}=this.submissionFilters(query);
    const from="FROM moment_submissions s JOIN accounts a ON a.id=s.account_id LEFT JOIN account_administration m ON m.account_id=a.id JOIN personal_memories p ON p.account_id=s.account_id AND p.id=s.snapshot_id";
    const where="WHERE s.status='published' AND a.status='active' AND COALESCE(m.status,'active')='active' AND p.deleted_at IS NULL"+(clauses.length ? " AND "+clauses.join(" AND ") : "");
    return {
      moments:this.core.all(`SELECT s.* ${from} ${where} ORDER BY s.featured DESC,s.sort_rank,s.created_at DESC,s.id LIMIT ? OFFSET ?`,...values,p.pageSize,(p.page-1)*p.pageSize).map(r=>this.publicDto(r)),
      total:this.core.one(`SELECT COUNT(*) n ${from} ${where}`,...values).n,...p,
    };
  }
}
