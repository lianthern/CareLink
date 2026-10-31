import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LocalApi } from "../src/api.mjs";
import { loadLocalKeyring } from "../src/crypto.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";

const [database, keysetPath, mode, email, clientStatePath, mediaRoot = `${database}.media`] = process.argv.slice(2);

async function run() {
  const keyring = loadLocalKeyring(keysetPath, { allowCreate: !existsSync(database) });
  const messages = [];
  const api = new LocalApi({ autoApproveRegistrations: true, database, keyring, mediaStore: new FilesystemMediaStore(mediaRoot),
    otpSink: (message) => messages.push(message) });
  try {
    if (mode === "rotated") {
      api.identityRekey.run({ fromCollisionKeyEpoch: keyring.previous[0].keyId,
        toCollisionKeyEpoch: keyring.current.keyId, leaseId: "cross-process-rekey-lease-v1" });
    }
    let oldSessionStatus = null;
    if (existsSync(clientStatePath)) {
      const oldSession = readFileSync(clientStatePath, "utf8");
      oldSessionStatus = (await api.handle({ method: "GET", path: "/v1/me",
        headers: { authorization: `Bearer ${oldSession}` } })).status;
    }
    const challenge = await api.handle({ method: "POST", path: "/v1/auth/email-otp-challenges",
      headers: { "idempotency-key": `process-challenge-${mode}-abcdefgh` }, body: { email, purpose: "login" } });
    const otp = messages.find((entry) => entry.challengeId === challenge.body.challengeId).code;
    const verified = await api.handle({ method: "POST", path: "/v1/auth/email-otp-verifications",
      headers: { "idempotency-key": `process-verification-${mode}-abcdefgh` },
      body: { challengeId: challenge.body.challengeId, otp, purpose: "login" } });
    writeFileSync(clientStatePath, verified.body.accountSessionSecret, { mode: 0o600 });
    let spaceId = null;
    if (mode === "first") {
      const created = await api.handle({ method: "POST", path: "/v1/spaces", headers: {
        authorization: `Bearer ${verified.body.accountSessionSecret}`,
        "idempotency-key": "process-space-create-abcdefgh",
        "notice-acknowledgement": JSON.stringify({ purpose: "space_create", version: 1,
          contentHash: "local-space_create-v1" })
      }, body: { name: "Persistent identity space" } });
      spaceId = created.body.spaceId;
    }
    const spaces = await api.handle({ method: "GET", path: "/v1/me/spaces",
      headers: { authorization: `Bearer ${verified.body.accountSessionSecret}` } });
    const count = api.db.prepare("SELECT COUNT(*) count FROM accounts").get().count;
    process.stdout.write(`${JSON.stringify({ accountId: verified.body.accountId, accountsCount: count,
      spaceId: spaceId ?? spaces.body.spaces[0]?.spaceId ?? null, spacesCount: spaces.body.spaces.length,
      oldSessionStatus, keyId: keyring.keyId })}\n`);
  } finally { api.close(); }
}

try { await run(); }
catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error.code ?? "internal_error" })}\n`);
  process.exitCode = 2;
}
