"use strict";

const deny = () => {
  throw new Error("TRACK0L_NETWORK_DENIED");
};
const denyAsync = async () => {
  throw new Error("TRACK0L_NETWORK_DENIED");
};

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const dgram = require("node:dgram");
const dns = require("node:dns");
const childProcess = require("node:child_process");

http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
tls.connect = deny;
dgram.createSocket = deny;
dns.lookup = deny;
dns.resolve = deny;
childProcess.spawn = deny;
childProcess.spawnSync = deny;
childProcess.exec = deny;
childProcess.execSync = deny;
childProcess.execFile = deny;
childProcess.execFileSync = deny;
childProcess.fork = deny;
globalThis.fetch = denyAsync;

