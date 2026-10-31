import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiError, assert } from "../../errors.mjs";

const HEADER_LIMIT = 4096;

function safeKey(key) {
  assert(typeof key === "string" && key.length > 0 && key.length <= 1024 &&
    key.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".."),
  "media_object_key_invalid", 500);
  return key;
}

function parseObject(file, maxBytes) {
  let descriptor;
  let bytes;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    assert(stat.isFile() && (stat.mode & 0o077) === 0 && stat.nlink === 1,
      "media_store_permissions_invalid", 503);
    bytes = readFileSync(descriptor);
  } catch (error) {
    if (error?.code === "ELOOP") throw new ApiError("media_store_permissions_invalid", 503);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const newline = bytes.indexOf(10);
  assert(newline > 0 && newline <= HEADER_LIMIT, "media_object_corrupt", 503);
  let header;
  try { header = JSON.parse(bytes.subarray(0, newline).toString("utf8")); }
  catch { throw new ApiError("media_object_corrupt", 503); }
  const body = bytes.subarray(newline + 1);
  const digest = createHash("sha256").update(body).digest("hex");
  assert(header?.schema === "unseen-media-v1" && header.bytes === body.length && header.etag === digest &&
    typeof header.contentType === "string" && (!maxBytes || body.length <= maxBytes),
  !maxBytes || body.length <= maxBytes ? "media_object_corrupt" : "object_too_large",
  !maxBytes || body.length <= maxBytes ? 503 : 413);
  return { body, contentType: header.contentType, etag: digest, updatedAt: header.updatedAt };
}

export class FilesystemMediaStore {
  constructor(rootPath) {
    assert(typeof rootPath === "string" && rootPath.length > 0, "media_store_unavailable", 503);
    this.root = path.resolve(rootPath);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
      "media_store_permissions_invalid", 503);
    this.rootIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    this.durable = true;
    this.networkRequests = 0;
    for (const name of readdirSync(this.root)) {
      if (/^\.tmp-[A-Za-z0-9.-]+$/.test(name)) unlinkSync(path.join(this.root, name));
    }
  }

  assertRoot() {
    const stat = lstatSync(this.root);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
      stat.dev === this.rootIdentity.dev && stat.ino === this.rootIdentity.ino && stat.uid === this.rootIdentity.uid,
    "media_store_permissions_invalid", 503);
  }

  syncRoot() {
    this.assertRoot();
    const descriptor = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }

  fileFor(key) {
    this.assertRoot();
    const digest = createHash("sha256").update(safeKey(key)).digest("hex");
    return path.join(this.root, `${digest}.media`);
  }

  async putIfAbsent(key, bytes, { contentType = "application/octet-stream", maxBytes } = {}) {
    const body = Buffer.from(bytes);
    assert(!maxBytes || body.length <= maxBytes, "object_too_large", 413);
    const etag = createHash("sha256").update(body).digest("hex");
    const updatedAt = new Date().toISOString();
    const header = Buffer.from(`${JSON.stringify({ schema: "unseen-media-v1", contentType, bytes: body.length,
      etag, updatedAt })}\n`);
    const file = this.fileFor(key);
    if (existsSync(file)) return { created: false, ...(await this.head(key)) };
    const temp = path.join(this.root, `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
    let descriptor;
    let created = false;
    try {
      descriptor = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, Buffer.concat([header, body]));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try { linkSync(temp, file); created = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      this.syncRoot();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temp)) unlinkSync(temp);
    }
    const result = await this.head(key);
    return { created, ...result };
  }

  async head(key) {
    const file = this.fileFor(key);
    if (!existsSync(file)) return { exists: false };
    let object;
    try { object = parseObject(file); }
    catch (error) { if (error?.code === "ENOENT") return { exists: false }; else throw error; }
    return { exists: true, bytes: object.body.length, contentType: object.contentType, etag: object.etag };
  }

  async get(key, { maxBytes } = {}) {
    const file = this.fileFor(key);
    assert(existsSync(file), "object_missing", 409);
    try { return parseObject(file, maxBytes); }
    catch (error) { if (error?.code === "ENOENT") throw new ApiError("object_missing", 409); else throw error; }
  }

  async delete(key) {
    const file = this.fileFor(key);
    if (existsSync(file)) {
      unlinkSync(file);
      this.syncRoot();
    }
  }
}
