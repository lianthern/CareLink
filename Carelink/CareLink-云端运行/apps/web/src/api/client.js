export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export class UnseenApiClient {
  constructor(adapter) {
    this.adapter = adapter;
  }

  read(resource, params = {}) {
    return this.adapter.read(resource, params);
  }

  act(actionId, payload = {}) {
    return this.adapter.act(actionId, payload);
  }

  // Wish wall: a small purpose-built call outside the generic action-registry
  // system, the same way upload-workflow.js's ticket clients are -- the
  // action registry is generated from contracts/source and this feature
  // deliberately doesn't add to that pipeline (see wishWallCopy in
  // ui/templates.js for the matching front-end-only-copy rationale).
  updateSpaceWishes(spaceId, wishes, ifMatch) {
    return this.adapter.updateSpaceWishes(spaceId, wishes, ifMatch);
  }

  admitCampaign(publicCampaignId) {
    return this.adapter.admitCampaign(publicCampaignId);
  }

  requestPublicListing(spaceId) {
    return this.adapter.requestPublicListing(spaceId);
  }

  // Human-verification front door for AUTH.REQUEST_CODE (see app.js's requestLoginCode()) --
  // outside the frozen action registry for the same reason as the other bespoke calls on this
  // class: contracts/source doesn't know about it, and it isn't a canonical create/update of any
  // domain resource, just a short-lived proof-of-work (or, per server config, a different
  // provider entirely -- see the {mode,...} shape documented on
  // services/api/src/ports/captcha/*-captcha-port.mjs) ticket.
  requestOtpVerificationChallenge() {
    return this.adapter.requestOtpVerificationChallenge();
  }

  // v3.1 "传到我的空间": lazily finds-or-creates the caller's personal default
  // space. Not a generic action() — mirrors admitCampaign() above in going
  // straight to the adapter, since it isn't part of the frozen action
  // registry (see http-adapter.js ensurePersonalSpace()).
  ensurePersonalSpace() {
    return this.adapter.ensurePersonalSpace();
  }

  selectSpace(spaceId) {
    return this.adapter.selectSpace?.(spaceId);
  }

  reset() {
    return this.adapter.reset?.();
  }
}
