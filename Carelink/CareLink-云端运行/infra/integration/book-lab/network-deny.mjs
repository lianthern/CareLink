import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const dnsMethod = /^(?:lookup|resolve|reverse)/u;
const guarded = [];

export function networkDenied() {
  throw Object.assign(new Error("network_denied"), { code: "NETWORK_DENIED" });
}

function replace(target, key, label) {
  if (typeof target?.[key] !== "function") return;
  target[key] = networkDenied;
  if (target[key] !== networkDenied) throw new Error(`network_guard_unpatchable:${label}`);
  guarded.push(label);
}

for (const [target, key, label] of [
  [net.Socket.prototype, "connect", "net.Socket.connect"],
  [net, "connect", "net.connect"],
  [net, "createConnection", "net.createConnection"],
  [tls.TLSSocket.prototype, "connect", "tls.TLSSocket.connect"],
  [tls, "connect", "tls.connect"],
  [http, "request", "http.request"],
  [http, "get", "http.get"],
  [https, "request", "https.request"],
  [https, "get", "https.get"],
  [http2, "connect", "http2.connect"],
  [dgram.Socket.prototype, "connect", "dgram.Socket.connect"],
  [dgram.Socket.prototype, "send", "dgram.Socket.send"],
  [dgram.Socket.prototype, "sendto", "dgram.Socket.sendto"]
]) replace(target, key, label);

for (const key of Object.keys(dns).filter((name) => dnsMethod.test(name))) {
  replace(dns, key, `dns.${key}`);
}
for (const key of Object.getOwnPropertyNames(dns.Resolver.prototype).filter((name) => dnsMethod.test(name))) {
  replace(dns.Resolver.prototype, key, `dns.Resolver.${key}`);
}
if (dns.promises) {
  for (const key of Object.keys(dns.promises).filter((name) => dnsMethod.test(name))) {
    replace(dns.promises, key, `dns.promises.${key}`);
  }
  for (const key of Object.getOwnPropertyNames(dns.promises.Resolver.prototype).filter((name) => dnsMethod.test(name))) {
    replace(dns.promises.Resolver.prototype, key, `dns.promises.Resolver.${key}`);
  }
}

replace(globalThis, "fetch", "global.fetch");
const webSocket = typeof globalThis.WebSocket === "function" ? "guarded" : "unavailable";
replace(globalThis, "WebSocket", "global.WebSocket");

let undici = "unavailable";
try {
  const module = require("undici");
  const keys = ["request", "fetch", "stream", "pipeline", "connect", "upgrade", "dispatch",
    "Client", "Pool", "BalancedPool", "Agent", "ProxyAgent", "EnvHttpProxyAgent", "WebSocket"];
  for (const key of keys) replace(module, key, `undici.${key}`);
  undici = "guarded";
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
}

syncBuiltinESMExports();

export const networkGuardState = Object.freeze({ webSocket, undici, guarded: Object.freeze([...guarded]) });
