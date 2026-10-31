function assertFixture(condition, message) {
  if (!condition) throw new Error(`invalid_core_fixture:${message}`);
}

function normalizeMap(value = {}) {
  return value instanceof Map ? new Map(value) : new Map(Object.entries(value));
}

function activeAccount(session) {
  return session?.active === true && session.revalidated === true &&
    Number.isSafeInteger(session.issuedSessionEpoch) && session.issuedSessionEpoch === session.accountSessionEpoch;
}

function activeAccountViewer(session, spaceId) {
  return session?.spaceId === spaceId && session.sessionActive === true && session.sessionRevalidated === true &&
    session.membershipActive === true && session.viewTaskActive === true &&
    Number.isSafeInteger(session.issuedSessionEpoch) && session.issuedSessionEpoch === session.accountSessionEpoch &&
    Number.isSafeInteger(session.version) && session.version > 0;
}

function activeExternalViewer(session, spaceId) {
  return session?.spaceId === spaceId && session.sessionActive === true && session.principalActive === true &&
    session.grantActive === true && session.campaignActive === true && session.campaignShared === true &&
    session.viewTaskActive === true && session.spaceLifecycle === "active" &&
    Number.isSafeInteger(session.version) && session.version > 0;
}

export class FixtureCorePort {
  constructor({ photos = {}, accountSessions = {}, receiptSessions = {}, eligibleBooks = [], accounts = {},
    sessionFamilies = {}, spaces = {}, events = {}, accountViewSessions = {}, externalViewSessions = {},
    beforeOwnerRevalidate = null, beforeViewerRevalidate = null } = {}) {
    this.photos = normalizeMap(photos);
    this.accountSessions = normalizeMap(accountSessions);
    this.receiptSessions = normalizeMap(receiptSessions);
    this.eligibleBooks = structuredClone(eligibleBooks);
    this.accounts = normalizeMap(accounts);
    this.sessionFamilies = normalizeMap(sessionFamilies);
    this.spaces = normalizeMap(spaces);
    this.events = normalizeMap(events);
    this.accountViewSessions = normalizeMap(accountViewSessions);
    this.externalViewSessions = normalizeMap(externalViewSessions);
    this.beforeOwnerRevalidate = beforeOwnerRevalidate;
    this.beforeViewerRevalidate = beforeViewerRevalidate;
    this.writeCount = 0;
    for (const [photoId, photo] of this.photos) {
      assertFixture(photo.photoId === photoId, `${photoId}:photoId`);
      assertFixture(photo.contributorId, `${photoId}:contributorId`);
      assertFixture(typeof photo.visibleAnchor === "string" && photo.visibleAnchor.length >= 2,
        `${photoId}:visibleAnchor`);
      assertFixture(photo.provenance?.photoId === photoId, `${photoId}:provenance.photoId`);
      for (const field of ["spaceId", "sceneId", "panoramaRevisionId", "placementRevisionId", "sourcePhotosVersion",
        "yawDegrees", "capturedAt", "authorId", "photoContentHash", "placementSnapshotHash"]) {
        assertFixture(photo.provenance[field] !== undefined && photo.provenance[field] !== null,
          `${photoId}:provenance.${field}`);
      }
      assertFixture(Object.hasOwn(photo.provenance, "nodeId"), `${photoId}:provenance.nodeId`);
    }
  }

  authenticate(headers = {}, now = Date.now()) {
    const authorization = headers.authorization;
    const accountSecret = authorization?.startsWith("Bearer ") ? authorization.slice(7) : headers["x-account-session"];
    const receiptSecret = headers["x-receipt-session"];
    if (Boolean(accountSecret) === Boolean(receiptSecret)) return null;
    if (accountSecret) {
      const session = this.accountSessions.get(accountSecret);
      if (!activeAccount(session)) return null;
      return Object.freeze({ kind: "account", authorizationId: session.sessionId,
        contributorId: session.contributorId, allowedPhotoIds: null });
    }
    const session = this.receiptSessions.get(receiptSecret);
    if (!session?.active || (session.expiresAt && Date.parse(session.expiresAt) <= now)) return null;
    return Object.freeze({ kind: "receipt", authorizationId: session.sessionId,
      contributorId: session.contributorId, allowedPhotoIds: new Set(session.photoIds) });
  }

  readOwnedPhoto(principal, photoId) {
    const photo = this.photos.get(photoId);
    if (!photo || !principal || photo.contributorId !== principal.contributorId ||
      (principal.allowedPhotoIds && !principal.allowedPhotoIds.has(photoId))) return null;
    return structuredClone(photo);
  }

  readQuestionSourceForWorker({ photoId, contributorId } = {}) {
    const photo = this.photos.get(photoId);
    if (!photo || photo.contributorId !== contributorId) return null;
    return structuredClone(photo);
  }

  listEligibleBooks(principal, spaceId) {
    if (!principal) return [];
    return this.eligibleBooks.filter((book) => book.spaceId === spaceId).map(({ spaceId: _, ...book }) => structuredClone(book));
  }

  readCurrentOwner(headers = {}, spaceId) {
    if (headers["x-receipt-session"]) return null;
    const authorization = headers.authorization;
    const secret = authorization?.startsWith("Bearer ") ? authorization.slice(7) : headers["x-account-session"];
    const session = this.accountSessions.get(secret);
    const account = this.accounts.get(session?.accountId);
    const family = this.sessionFamilies.get(session?.familyId);
    const space = this.spaces.get(spaceId);
    if (!session || !account || !family || !space || session.active !== true || session.revalidated !== true ||
      family.active !== true || family.revalidated !== true || session.issuedSessionEpoch !== account.sessionEpoch ||
      family.issuedSessionEpoch !== account.sessionEpoch || space.spaceLifecycle !== "active" ||
      space.ownerAccountId !== account.accountId) return null;
    return Object.freeze({ kind: "owner", authorizationId: session.sessionId, accountId: account.accountId,
      spaceId, accountSessionId: session.sessionId, familyId: session.familyId,
      guard: Object.freeze({ accountSessionVersion: session.version, familyVersion: family.version,
        spaceVersion: space.version, sessionEpoch: account.sessionEpoch }) });
  }

  revalidateCurrentOwner(owner) {
    if (typeof this.beforeOwnerRevalidate === "function") this.beforeOwnerRevalidate(this, owner);
    const account = this.accounts.get(owner?.accountId);
    const space = this.spaces.get(owner?.spaceId);
    if (owner?.accountSessionId == null && owner?.familyId == null) {
      return Boolean(account && space && space.spaceLifecycle === "active" &&
        space.ownerAccountId === account.accountId && (account.version ?? account.sessionEpoch) === owner.guard.accountVersion &&
        account.sessionEpoch === owner.guard.sessionEpoch && space.version === owner.guard.spaceVersion);
    }
    const session = [...this.accountSessions.values()].find((row) => row.sessionId === owner?.accountSessionId);
    const family = this.sessionFamilies.get(owner?.familyId);
    return Boolean(session && account && family && space && session.active === true && session.revalidated === true &&
      family.active === true && family.revalidated === true && session.issuedSessionEpoch === account.sessionEpoch &&
      family.issuedSessionEpoch === account.sessionEpoch && space.spaceLifecycle === "active" &&
      space.ownerAccountId === account.accountId && session.version === owner.guard.accountSessionVersion &&
      family.version === owner.guard.familyVersion && space.version === owner.guard.spaceVersion &&
      account.sessionEpoch === owner.guard.sessionEpoch);
  }

  readCurrentBookViewer(headers = {}, spaceId) {
    const authorization = headers.authorization;
    const accountSecret = authorization?.startsWith("Bearer ") ? authorization.slice(7) : headers["x-account-session"];
    const externalSecret = headers["x-external-view-session"];
    if (headers["x-receipt-session"] || Boolean(accountSecret) === Boolean(externalSecret) ||
      this.spaces.get(spaceId)?.spaceLifecycle !== "active") return null;
    const owner = this.readCurrentOwner(headers, spaceId);
    if (owner) return owner;
    const account = this.accountViewSessions.get(accountSecret);
    if (activeAccountViewer(account, spaceId)) {
      return Object.freeze({ kind: "account_viewer", authorizationId: account.sessionId, spaceId,
        guard: Object.freeze({ version: account.version }) });
    }
    const external = this.externalViewSessions.get(externalSecret);
    if (activeExternalViewer(external, spaceId)) {
      return Object.freeze({ kind: "external_viewer", authorizationId: external.sessionId, spaceId,
        guard: Object.freeze({ version: external.version }) });
    }
    return null;
  }

  revalidateCurrentBookViewer(viewer) {
    if (viewer?.kind === "owner") return this.revalidateCurrentOwner(viewer);
    if (typeof this.beforeViewerRevalidate === "function") this.beforeViewerRevalidate(this, viewer);
    const sessions = viewer?.kind === "account_viewer" ? this.accountViewSessions : this.externalViewSessions;
    const current = [...sessions.values()].find((row) => row.sessionId === viewer?.authorizationId);
    const active = viewer?.kind === "account_viewer"
      ? activeAccountViewer(current, viewer.spaceId)
      : viewer?.kind === "external_viewer" && activeExternalViewer(current, viewer.spaceId);
    return Boolean(active && current.version === viewer.guard.version &&
      this.spaces.get(viewer.spaceId)?.spaceLifecycle === "active");
  }

  readOwnerSnapshot(spaceId) {
    const space = this.spaces.get(spaceId);
    const account = this.accounts.get(space?.ownerAccountId);
    if (!space || !account || space.spaceLifecycle !== "active") return null;
    return Object.freeze({ kind: "owner", authorizationId: spaceId, accountId: account.accountId, spaceId,
      accountSessionId: null, familyId: null, guard: Object.freeze({
        accountVersion: account.version ?? account.sessionEpoch, accountSessionVersion: null, familyVersion: null,
        sessionEpoch: account.sessionEpoch, spaceVersion: space.version
      }) });
  }

  readEventForOwner(owner, eventId) {
    const event = this.events.get(eventId);
    if (!event || event.spaceId !== owner?.spaceId || event.active !== true) return null;
    return structuredClone(event);
  }

  async readDisplayPhotoForOwner(owner, photoId) {
    const photo = this.photos.get(photoId);
    if (!new Set(["owner", "account_viewer", "external_viewer"]).has(owner?.kind) || !photo ||
      photo.provenance?.spaceId !== owner.spaceId) return null;
    return structuredClone(photo);
  }

  snapshot() {
    return structuredClone({ photos: Object.fromEntries(this.photos), eligibleBooks: this.eligibleBooks,
      accounts: Object.fromEntries(this.accounts), sessionFamilies: Object.fromEntries(this.sessionFamilies),
      spaces: Object.fromEntries(this.spaces), events: Object.fromEntries(this.events),
      accountViewSessions: Object.fromEntries(this.accountViewSessions),
      externalViewSessions: Object.fromEntries(this.externalViewSessions), writeCount: this.writeCount });
  }
}
