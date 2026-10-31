import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { normalizeEmail } from "../../crypto.mjs";

const MAX_REPLY_BYTES = 64 * 1024;
const PROVIDER = "smtp_tls";
export const SMTP_DELIVERY_LEASE_GRACE_MS = 5_000;
export const MAX_SMTP_DELIVERY_TIMEOUT_MS = 50_000;

export class SmtpOtpDeliveryError extends Error {
  constructor(code) {
    super(code);
    this.name = "SmtpOtpDeliveryError";
    this.code = code;
  }
}

function fail(code) { throw new SmtpOtpDeliveryError(code); }

function integer(value, fallback, minimum, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("smtp_delivery_configuration_invalid");
  }
  return parsed;
}

function ascii(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum &&
    /^[\x21-\x7e]+$/u.test(value) && !/[\r\n\0]/u.test(value);
}

function secret(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && !/[\r\n\0]/u.test(value);
}

function phaseTimeout(deadlineAt, configuredTimeoutMs) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) fail("smtp_delivery_timeout");
  return Math.max(1, Math.min(remaining, configuredTimeoutMs));
}

function email(value) {
  try { return ascii(value, 320) && normalizeEmail(value) === value; }
  catch { return false; }
}

function loadPassword(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) fail("smtp_secret_unavailable");
  let descriptor;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const effectiveUid = process.geteuid?.();
    if (!before.isFile() || before.isSymbolicLink() || ![0o400, 0o600].includes(before.mode & 0o777) ||
      ![0, effectiveUid].includes(before.uid) || before.size < 1 || before.size > 4096) {
      fail("smtp_secret_unavailable");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs) fail("smtp_secret_unavailable");
    const password = bytes.toString("utf8").replace(/\n$/u, "");
    if (!password || password.length > 1024 || /[\r\n\0]/u.test(password)) fail("smtp_secret_unavailable");
    return password;
  } catch (error) {
    if (error instanceof SmtpOtpDeliveryError) throw error;
    fail("smtp_secret_unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function reply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let code = null;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
    };
    const done = (action, value) => { cleanup(); action(value); };
    const onError = () => done(reject, new SmtpOtpDeliveryError("smtp_delivery_connection_failed"));
    const onEnd = () => done(reject, new SmtpOtpDeliveryError("smtp_delivery_connection_failed"));
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REPLY_BYTES) {
        done(reject, new SmtpOtpDeliveryError("smtp_delivery_response_invalid"));
        return;
      }
      const lines = buffer.split("\r\n");
      if (lines.at(-1) !== "") return;
      lines.pop();
      for (const line of lines) {
        const match = /^(\d{3})([ -])(.*)$/u.exec(line);
        if (!match || (code !== null && match[1] !== code)) {
          done(reject, new SmtpOtpDeliveryError("smtp_delivery_response_invalid"));
          return;
        }
        code ??= match[1];
        if (match[2] === " ") {
          done(resolve, Object.freeze({ code: Number(code), lines: Object.freeze([...lines]) }));
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      socket.destroy();
      done(reject, new SmtpOtpDeliveryError("smtp_delivery_timeout"));
    }, timeoutMs);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
  });
}

function connected(socket, event, timeoutMs, failureCode) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onReady);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onReady = () => { cleanup(); resolve(socket); };
    const onError = () => { cleanup(); reject(new SmtpOtpDeliveryError(failureCode)); };
    const onClose = () => { cleanup(); reject(new SmtpOtpDeliveryError("smtp_delivery_connection_failed")); };
    const timer = setTimeout(() => {
      socket.destroy();
      cleanup();
      reject(new SmtpOtpDeliveryError("smtp_delivery_timeout"));
    }, timeoutMs);
    socket.once(event, onReady);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function command(socket, value, expected, timeoutMs, failureCode = "smtp_delivery_rejected") {
  socket.write(`${value}\r\n`);
  const response = await reply(socket, timeoutMs);
  if (!expected.includes(response.code)) fail(failureCode);
  return response;
}

async function authenticate(socket, ehlo, config, deadlineAt) {
  const capabilities = ehlo.lines.join("\n").toUpperCase();
  if (/\bAUTH(?:=|\s)[^\r\n]*\bPLAIN\b/u.test(capabilities)) {
    const credential = Buffer.from(`\0${config.username}\0${config.password}`, "utf8").toString("base64");
    socket.write(`AUTH PLAIN ${credential}\r\n`);
    const response = await reply(socket, phaseTimeout(deadlineAt, config.sendTimeoutMs));
    if (response.code === 334) {
      await command(socket, credential, [235], phaseTimeout(deadlineAt, config.sendTimeoutMs),
        "smtp_delivery_auth_failed");
    } else if (response.code !== 235) {
      fail("smtp_delivery_auth_failed");
    }
    return;
  }
  if (/\bAUTH(?:=|\s)[^\r\n]*\bLOGIN\b/u.test(capabilities)) {
    await command(socket, "AUTH LOGIN", [334], phaseTimeout(deadlineAt, config.sendTimeoutMs),
      "smtp_delivery_auth_failed");
    await command(socket, Buffer.from(config.username, "utf8").toString("base64"), [334],
      phaseTimeout(deadlineAt, config.sendTimeoutMs), "smtp_delivery_auth_failed");
    await command(socket, Buffer.from(config.password, "utf8").toString("base64"), [235],
      phaseTimeout(deadlineAt, config.sendTimeoutMs), "smtp_delivery_auth_failed");
    return;
  }
  fail("smtp_delivery_auth_unavailable");
}

function body(message, config) {
  if (!message || !ascii(message.deliveryId, 200) || !ascii(message.challengeId, 200) ||
    !email(message.normalizedEmail) || !/^\d{6}$/u.test(message.code) ||
    typeof message.purpose !== "string" || Number.isNaN(Date.parse(message.expiresAt))) {
    fail("smtp_delivery_message_invalid");
  }
  const messageId = createHash("sha256").update(message.deliveryId).digest("hex");
  const senderDomain = config.from.slice(config.from.lastIndexOf("@") + 1);
  const text = `你的 UNSEEN 验证码是：${message.code}\n\n验证码将在 10 分钟后失效。若非本人操作，请忽略本邮件。`;
  const encoded = Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/gu).join("\r\n");
  return [
    `From: UNSEEN <${config.from}>`,
    `To: ${message.normalizedEmail}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}@${senderDomain}>`,
    "Subject: =?UTF-8?B?VU5TRUVOIOmqjOivgeeggQ==?=",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
    "",
    encoded,
    "."
  ].join("\r\n");
}

async function openSession(config, ca, deadlineAt) {
  const tlsOptions = { host: config.host, port: config.port, minVersion: "TLSv1.2",
    rejectUnauthorized: true, ...(net.isIP(config.host) ? {} : { servername: config.host }), ...(ca ? { ca } : {}) };
  if (config.security === "implicit_tls") {
    const socket = tls.connect(tlsOptions);
    socket.on("error", () => {});
    return connected(socket, "secureConnect", phaseTimeout(deadlineAt, config.connectTimeoutMs),
      "smtp_delivery_tls_failed");
  }
  const plain = net.connect({ host: config.host, port: config.port });
  plain.on("error", () => {});
  await connected(plain, "connect", phaseTimeout(deadlineAt, config.connectTimeoutMs),
    "smtp_delivery_connection_failed");
  const greeting = await reply(plain, phaseTimeout(deadlineAt, config.connectTimeoutMs));
  if (greeting.code !== 220) fail("smtp_delivery_rejected");
  const ehlo = await command(plain, `EHLO ${config.clientName}`, [250],
    phaseTimeout(deadlineAt, config.sendTimeoutMs));
  if (!ehlo.lines.some((line) => /STARTTLS/iu.test(line))) fail("smtp_delivery_tls_unavailable");
  await command(plain, "STARTTLS", [220], phaseTimeout(deadlineAt, config.sendTimeoutMs),
    "smtp_delivery_tls_unavailable");
  const socket = tls.connect({ ...tlsOptions, socket: plain });
  socket.on("error", () => {});
  await connected(socket, "secureConnect", phaseTimeout(deadlineAt, config.connectTimeoutMs),
    "smtp_delivery_tls_failed");
  return socket;
}

function validateConfiguration(config, { password = true } = {}) {
  if (!config || !ascii(config.host, 253) || !ascii(config.username, 320) || !email(config.from) ||
    !["implicit_tls", "starttls"].includes(config.security) || !Number.isSafeInteger(config.port) ||
    config.port < 1 || config.port > 65_535 || password && !secret(config.password, 1024) ||
    !Number.isSafeInteger(config.connectTimeoutMs) || config.connectTimeoutMs < 50 ||
    !Number.isSafeInteger(config.sendTimeoutMs) || config.sendTimeoutMs < 50 ||
    !Number.isSafeInteger(config.totalTimeoutMs) || config.totalTimeoutMs < 50 ||
    config.totalTimeoutMs > MAX_SMTP_DELIVERY_TIMEOUT_MS) fail("smtp_delivery_configuration_invalid");
}

export function createSmtpOtpDeliveryPort(config, { ca = undefined } = {}) {
  validateConfiguration(config);
  const normalized = Object.freeze({ ...config,
    clientName: config.from.slice(config.from.lastIndexOf("@") + 1) });
  let active = false;
  return Object.freeze({
    name: PROVIDER,
    deliveryTimeoutMs: normalized.totalTimeoutMs,
    async deliver(message) {
      if (active) fail("smtp_delivery_busy");
      active = true;
      let socket;
      try {
        const deadlineAt = Date.now() + normalized.totalTimeoutMs;
        const wireMessage = body(message, normalized);
        socket = await openSession(normalized, ca, deadlineAt);
        if (normalized.security === "implicit_tls") {
          const greeting = await reply(socket, phaseTimeout(deadlineAt, normalized.connectTimeoutMs));
          if (greeting.code !== 220) fail("smtp_delivery_rejected");
        }
        const ehlo = await command(socket, `EHLO ${normalized.clientName}`, [250],
          phaseTimeout(deadlineAt, normalized.sendTimeoutMs));
        await authenticate(socket, ehlo, normalized, deadlineAt);
        await command(socket, `MAIL FROM:<${normalized.from}>`, [250],
          phaseTimeout(deadlineAt, normalized.sendTimeoutMs));
        await command(socket, `RCPT TO:<${message.normalizedEmail}>`, [250, 251],
          phaseTimeout(deadlineAt, normalized.sendTimeoutMs));
        await command(socket, "DATA", [354], phaseTimeout(deadlineAt, normalized.sendTimeoutMs));
        socket.write(`${wireMessage}\r\n`);
        const accepted = await reply(socket, phaseTimeout(deadlineAt, normalized.sendTimeoutMs));
        if (accepted.code !== 250) fail("smtp_delivery_rejected");
        socket.end("QUIT\r\n");
      } catch (error) {
        socket?.destroy();
        if (error instanceof SmtpOtpDeliveryError) throw error;
        fail(error?.code?.startsWith("ERR_TLS") ? "smtp_delivery_tls_failed" : "smtp_delivery_connection_failed");
      } finally {
        active = false;
      }
    }
  });
}

export function smtpOtpDeliveryFromEnv(env = process.env, options = {}) {
  const selected = env.UNSEEN_OTP_DELIVERY_PROVIDER ?? "disabled";
  if (selected === "disabled") return null;
  if (selected !== "smtp") fail("smtp_delivery_configuration_invalid");
  const config = {
    host: env.UNSEEN_SMTP_HOST,
    port: integer(env.UNSEEN_SMTP_PORT, undefined, 1, 65_535),
    security: env.UNSEEN_SMTP_SECURITY,
    username: env.UNSEEN_SMTP_USERNAME,
    from: env.UNSEEN_SMTP_FROM,
    connectTimeoutMs: integer(env.UNSEEN_SMTP_CONNECT_TIMEOUT_MS, 5_000, 50, 60_000),
    sendTimeoutMs: integer(env.UNSEEN_SMTP_SEND_TIMEOUT_MS, 10_000, 50, 120_000),
    totalTimeoutMs: integer(env.UNSEEN_SMTP_TOTAL_TIMEOUT_MS, 30_000, 50, MAX_SMTP_DELIVERY_TIMEOUT_MS)
  };
  validateConfiguration(config, { password: false });
  return createSmtpOtpDeliveryPort({ ...config, password: loadPassword(env.UNSEEN_OTP_PROVIDER_SECRET_FILE) }, options);
}
