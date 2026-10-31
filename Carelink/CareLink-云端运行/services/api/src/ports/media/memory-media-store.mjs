import { createHash } from "node:crypto";
import { assert } from "../../errors.mjs";

export class MemoryMediaStore {
  constructor() {
    this.objects = new Map();
    this.networkRequests = 0;
    this.durable = false;
  }

  async putIfAbsent(key, bytes, { contentType = "application/octet-stream", maxBytes } = {}) {
    const body = Buffer.from(bytes);
    assert(!maxBytes || body.length <= maxBytes, "object_too_large", 413);
    const existing = this.objects.get(key);
    if (existing) return { created: false, ...(await this.head(key)) };
    this.objects.set(key, {
      body,
      contentType,
      etag: createHash("sha256").update(body).digest("hex"),
      updatedAt: new Date().toISOString()
    });
    return { created: true, ...(await this.head(key)) };
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? {
      exists: true,
      bytes: object.body.length,
      contentType: object.contentType,
      etag: object.etag
    } : { exists: false };
  }

  async get(key, { maxBytes } = {}) {
    const object = this.objects.get(key);
    assert(object, "object_missing", 409);
    assert(!maxBytes || object.body.length <= maxBytes, "object_too_large", 413);
    return { ...object, body: Buffer.from(object.body) };
  }

  async delete(key) {
    this.objects.delete(key);
  }
}
