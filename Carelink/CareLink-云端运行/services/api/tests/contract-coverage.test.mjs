import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture-factory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const coverage = JSON.parse(fs.readFileSync(path.join(root, "contracts/source/technical/ACTION-API-COVERAGE.json")));

function normalized(method, endpoint) {
  return `${method} ${endpoint.replace(/\{[^}]+\}/g, ":param").replace(/\?.*$/, "")}`;
}

test("every frozen Track 1A API action has a concrete route", () => {
  const f = fixture();
  try {
    const actual = new Set(f.api.routes.map((route) => normalized(route.method, route.template)));
    const expected = [...new Set(coverage.actions.filter((action) => action.transport === "API")
      .map((action) => normalized(action.method, action.endpoint)))];
    const missing = expected.filter((endpoint) => !actual.has(endpoint));
    assert.deepEqual(missing, []);
    assert.ok(expected.length >= 60);
  } finally { f.close(); }
});

test("MediaStore port exists only under the frozen services/api/src/ports/media path", () => {
  const sourceRoot = path.join(root, "services/api/src");
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
  const sourceFiles = walk(sourceRoot).filter((file) => file.endsWith(".mjs"));
  const mediaStoreFiles = sourceFiles.filter((file) => /(?:class|function)\s+\w*MediaStore|MEDIA_STORE_METHODS/
    .test(fs.readFileSync(file, "utf8")));
  assert.ok(mediaStoreFiles.length >= 2);
  assert.equal(fs.existsSync(path.join(sourceRoot, "media-store.mjs")), false);
  assert.ok(mediaStoreFiles.every((file) => file.startsWith(path.join(sourceRoot, "ports/media/") )),
    mediaStoreFiles.join("\n"));
  const orchestration = fs.readFileSync(path.join(root, "contracts/source/IMPLEMENTATION-ORCHESTRATION.md"), "utf8");
  assert.match(orchestration, /MediaStore port 只能位于 `services\/api\/src\/ports\/media\/\*\*`/);
  const apiSource = fs.readFileSync(path.join(sourceRoot, "api.mjs"), "utf8");
  assert.doesNotMatch(apiSource, /["']\.\/media-store\.mjs["']/);
});

test("credential tables expose only keyed MAC columns, never raw secrets", () => {
  const f = fixture();
  try {
    const credentialTables = ["account_sessions", "reauth_grants", "member_invitations",
      "external_campaign_admission_challenges", "external_invitation_grants", "viewer_sessions",
      "contributor_sessions", "upload_sessions", "panorama_upload_sessions", "batch_receipts",
      "receipt_sessions", "case_access_sessions", "export_download_authorizations"];
    for (const table of credentialTables) {
      const columns = f.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      assert.ok(columns.includes("credential_mac") || columns.includes("ticket_mac"), table);
      assert.ok(columns.includes("credential_key_id") || columns.includes("ticket_key_id"), table);
      assert.equal(columns.some((name) => /raw_secret|plain_secret|raw_url|raw_ip|full_ua/i.test(name)), false, table);
    }
  } finally { f.close(); }
});

test("case schema enforces exact actor branch XOR", () => {
  const f = fixture();
  try {
    assert.throws(() => f.db.prepare(`INSERT INTO content_cases(
      id,case_type,target_type,actor_relation_kind,actor_account_id,category,status,created_at,version
    ) VALUES('bad','support','none','viewer','acct_missing','safety','open','2026-01-01T00:00:00Z',1)`).run(),
    /CHECK constraint failed|FOREIGN KEY constraint failed/);
  } finally { f.close(); }
});

test("L2 experimental mutations are explicitly unavailable", async () => {
  const f = fixture();
  try {
    const result = await f.call("POST", "/v2-experiments/batch-receipt/items/item_x/scene-note-jobs", {});
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "experiment_unavailable");
  } finally { f.close(); }
});

test("route principal projection is deterministic and never combines branches", async () => {
  const f = fixture();
  try {
    const result = await f.call("GET", "/v1/me", {}, { authorization: "Bearer a", "x-receipt-session": "b" });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, "session_unavailable");
  } finally { f.close(); }
});
