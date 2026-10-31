"use strict";

const crypto = require("node:crypto");
const { AppError } = require("../lib/errors.js");

class FakeOss {
  constructor(now = () => Date.now()) {
    this.objects = new Map();
    this.now = now;
  }

  _etag(body) { return crypto.createHash("md5").update(body).digest("hex"); }

  async head(key) {
    const object = this.objects.get(key);
    return object ? { exists: true, size: object.body.length, etag: object.etag,
      contentType: object.contentType, lastModified: object.lastModified } : { exists: false };
  }

  async get(key, options = {}) {
    const object = this.objects.get(key);
    if (!object) {
      if (options.allow404) return null;
      throw new AppError("OSS_ERROR", "not found", 502);
    }
    if (options.maxBytes && object.body.length > options.maxBytes) {
      throw new AppError("OBJECT_TOO_LARGE", "too large", 413);
    }
    return { body: Buffer.from(object.body), etag: object.etag,
      contentType: object.contentType, lastModified: object.lastModified };
  }

  async put(key, body, options = {}) {
    if (options.ifNoneMatch && this.objects.has(key)) {
      throw new AppError("OSS_PRECONDITION", "exists", 409);
    }
    const payload = Buffer.from(body);
    this.objects.set(key, { body: payload, etag: this._etag(payload),
      contentType: options.contentType || "application/octet-stream",
      acl: options.acl || "private", cacheControl: options.cacheControl || "",
      lastModified: new Date(this.now()).toISOString() });
    return this.head(key);
  }

  async copy(sourceKey, destinationKey, options = {}) {
    const source = this.objects.get(sourceKey);
    if (!source || options.sourceEtag && options.sourceEtag !== source.etag) {
      throw new AppError("OSS_PRECONDITION", "source changed", 409);
    }
    if (options.ifNoneMatch && this.objects.has(destinationKey)) {
      throw new AppError("OSS_PRECONDITION", "destination exists", 409);
    }
    return this.put(destinationKey, source.body, options);
  }

  async delete(key) { this.objects.delete(key); }

  async list(prefix, options = {}) {
    const maxKeys = options.maxKeys || 1000;
    const keys = Array.from(this.objects.keys()).filter((key) => key.startsWith(prefix) &&
      (!options.marker || key > options.marker)).sort();
    const selected = keys.slice(0, maxKeys);
    return {
      objects: selected.map((key) => {
        const object = this.objects.get(key);
        return { key, size: object.body.length, etag: object.etag,
          lastModified: object.lastModified };
      }),
      truncated: keys.length > selected.length,
      nextMarker: keys.length > selected.length ? selected[selected.length - 1] : ""
    };
  }

  json(key) {
    const object = this.objects.get(key);
    return object ? JSON.parse(object.body.toString("utf8")) : null;
  }
}

module.exports = { FakeOss };
