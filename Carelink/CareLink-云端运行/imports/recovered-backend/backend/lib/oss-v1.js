"use strict";

const crypto = require("node:crypto");
const { AppError, invariant } = require("./errors.js");

function encodeKey(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1]) : "";
}

function canonicalOssHeaders(headers) {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value).trim().replace(/\s+/g, " ")])
    .filter(([key]) => key.startsWith("x-oss-"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
}

class OssV1Adapter {
  constructor(options) {
    invariant(options && options.bucket && options.endpoint && options.accessKeyId && options.accessKeySecret,
      "OSS_CONFIG_INVALID", "对象存储配置不完整", 500);
    this.bucket = options.bucket;
    this.endpoint = String(options.endpoint).replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.protocol = String(options.protocol || "https").replace(/:$/, "");
    this.accessKeyId = options.accessKeyId;
    this.accessKeySecret = options.accessKeySecret;
    this.securityToken = options.securityToken || "";
    this.fetch = options.fetch || globalThis.fetch;
    invariant(typeof this.fetch === "function", "FETCH_UNAVAILABLE", "Node 运行时缺少 fetch", 500);
  }

  _url(key, query) {
    const path = key ? `/${encodeKey(key)}` : "/";
    const url = new URL(`${this.protocol}://${this.bucket}.${this.endpoint}${path}`);
    Object.entries(query || {}).forEach(([name, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    });
    return url;
  }

  _authorization(method, key, headers) {
    const contentMd5 = headers["Content-MD5"] || headers["content-md5"] || "";
    const contentType = headers["Content-Type"] || headers["content-type"] || "";
    const date = headers.Date || headers.date || "";
    const resource = `/${this.bucket}/${key || ""}`;
    const stringToSign = [method, contentMd5, contentType, date,
      `${canonicalOssHeaders(headers)}${resource}`].join("\n");
    const signature = crypto.createHmac("sha1", this.accessKeySecret)
      .update(stringToSign, "utf8").digest("base64");
    return `OSS ${this.accessKeyId}:${signature}`;
  }

  async _request(method, key, options = {}) {
    const headers = { ...(options.headers || {}), Date: new Date().toUTCString() };
    if (this.securityToken) headers["x-oss-security-token"] = this.securityToken;
    headers.Authorization = this._authorization(method, key, headers);
    let response;
    try {
      response = await this.fetch(this._url(key, options.query), {
        method,
        headers,
        body: options.body,
        signal: options.signal
      });
    } catch (_) {
      throw new AppError("OSS_UNAVAILABLE", "对象存储暂时不可用", 502);
    }
    if (!response.ok) {
      if (options.allow404 && response.status === 404) return null;
      let errorBody = "";
      try { errorBody = (await response.text()).slice(0, 16 * 1024); } catch (_) {}
      const details = {
        status: response.status,
        ossCode: xmlValue(errorBody, "Code") || undefined,
        requestId: xmlValue(errorBody, "RequestId") || response.headers.get("x-oss-request-id") || undefined
      };
      if (response.status === 409 || response.status === 412) {
        throw new AppError("OSS_PRECONDITION", "对象已存在或已发生并发更新", 409, details);
      }
      throw new AppError("OSS_ERROR", "对象存储操作失败", 502, details);
    }
    return response;
  }

  async head(key) {
    const response = await this._request("HEAD", key, { allow404: true });
    if (!response) return { exists: false };
    return {
      exists: true,
      size: Number(response.headers.get("content-length")) || 0,
      etag: String(response.headers.get("etag") || "").replace(/^\"|\"$/g, ""),
      contentType: response.headers.get("content-type") || "application/octet-stream",
      lastModified: response.headers.get("last-modified") || ""
    };
  }

  async get(key, options = {}) {
    const response = await this._request("GET", key, { allow404: options.allow404 });
    if (!response) return null;
    const announced = Number(response.headers.get("content-length")) || 0;
    if (options.maxBytes && announced > options.maxBytes) {
      throw new AppError("OBJECT_TOO_LARGE", "对象超过允许大小", 413);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (options.maxBytes && body.length > options.maxBytes) {
      throw new AppError("OBJECT_TOO_LARGE", "对象超过允许大小", 413);
    }
    return {
      body,
      etag: String(response.headers.get("etag") || "").replace(/^\"|\"$/g, ""),
      contentType: response.headers.get("content-type") || "application/octet-stream",
      lastModified: response.headers.get("last-modified") || ""
    };
  }

  async put(key, body, options = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const headers = {
      "Content-Type": options.contentType || "application/octet-stream",
      "Content-MD5": crypto.createHash("md5").update(payload).digest("base64")
    };
    if (options.acl) headers["x-oss-object-acl"] = options.acl;
    if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;
    if (options.ifNoneMatch) {
      headers["x-oss-forbid-overwrite"] = "true";
    }
    await this._request("PUT", key, { headers, body: payload });
    return this.head(key);
  }

  async copy(sourceKey, destinationKey, options = {}) {
    const headers = {
      "x-oss-copy-source": `/${this.bucket}/${encodeKey(sourceKey)}`,
      "x-oss-metadata-directive": "REPLACE",
      "Content-Type": options.contentType || "application/octet-stream"
    };
    if (options.sourceEtag) headers["x-oss-copy-source-if-match"] = options.sourceEtag;
    if (options.acl) headers["x-oss-object-acl"] = options.acl;
    if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;
    if (options.ifNoneMatch) headers["x-oss-forbid-overwrite"] = "true";
    await this._request("PUT", destinationKey, { headers });
    return this.head(destinationKey);
  }

  async delete(key) {
    await this._request("DELETE", key, { allow404: true });
  }

  async list(prefix, options = {}) {
    const maxKeys = Math.max(1, Math.min(1000, Number(options.maxKeys) || 1000));
    const response = await this._request("GET", "", {
      query: { prefix, marker: options.marker || "", "max-keys": maxKeys }
    });
    const xml = await response.text();
    const objects = [];
    const contentPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match;
    while ((match = contentPattern.exec(xml))) {
      objects.push({
        key: xmlValue(match[1], "Key"),
        size: Number(xmlValue(match[1], "Size")) || 0,
        etag: xmlValue(match[1], "ETag").replace(/^\"|\"$/g, ""),
        lastModified: xmlValue(match[1], "LastModified")
      });
    }
    const truncated = xmlValue(xml, "IsTruncated") === "true";
    const nextMarker = xmlValue(xml, "NextMarker") ||
      (truncated && objects.length ? objects[objects.length - 1].key : "");
    return { objects, truncated, nextMarker };
  }
}

module.exports = { OssV1Adapter, canonicalOssHeaders, decodeXml, encodeKey };
