import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const BASE_HEADERS = Object.freeze({ "content-type": "application/json", "cache-control": "no-store, private" });
const MEMORY_STATES = new Set(["eligible", "question_queued", "question_ready", "question_failed", "draft",
  "followup_queued", "followup_ready", "confirmed", "skipped", "withdrawal_pending", "withdrawn"]);
const JOB_TERMINAL = new Set(["ready", "failed", "cancelled"]);
const PRIVATE_FACT_STATES = new Set(["pending", "draft_ready", "question_ready", "answered", "confirmed", "withdrawn"]);
const PHOTO_QUESTION_INTENT = "photo_context";
const PRIVATE_AI_AUTHORIZATION_SCHEMA = "unseen-private-ai-l3-authorization/1";
const QUESTION_INTENT = Object.freeze({
  initial_question: PHOTO_QUESTION_INTENT,
  followup_question: PHOTO_QUESTION_INTENT
});
const SOURCE_PROVENANCE_FIELDS = Object.freeze(["spaceId", "photoId", "sceneId", "panoramaRevisionId",
  "placementRevisionId", "nodeId", "sourcePhotosVersion", "yawDegrees", "capturedAt", "authorId",
  "photoContentHash", "placementSnapshotHash"]);
const BOOK_PAGE_FIELDS = Object.freeze(["pageId", "index", "kind", "sourcePhotoId", "displayPhotoId",
  "personalMemoryId", "memoryRevisionId", "confirmedSubmissionId", "confirmedSubmissionHash", "grantId",
  "authorizedMemoryTextId", "sourceProvenance"]);
const BOOK_PAGE_KINDS = new Set(["cover", "memory", "multi_view", "closing"]);
const EDITABLE_DRAFT_STATES = new Set(["editing", "preview_ready", "preview_failed", "stale"]);
const PREVIEW_LAYOUTS = new Set(["book-lab-v0", "book-lab-v1"]);
const PREVIEW_TERMINAL = new Set(["ready", "failed", "cancelled"]);
const START_NEW_VERSION_SOURCE_STATES = new Set(["rendering", "available", "render_failed",
  "withdrawal_affected"]);
const START_NEW_VERSION_ACCESS_STATES = new Set(["active", "affected", "revoked"]);
const MAX_RENDER_ASSET_BYTES = 256 * 1024;
const MAX_RENDER_ASSET_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_HTML_BYTES = 8 * 1024 * 1024;
const MAX_FROZEN_PDF_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UNSAFE_MODEL_TEXT = /(?:\p{Cc}|\r|\n|忽略(?:之前|以上|系统)|系统提示|开发者消息|提示词|调用工具|执行命令|读取文件|访问文件|联网|打开终端|输出(?:密码|凭据)|prompt\s*injection|system\s*(?:message|prompt)|ignore\s+(?:all\s+)?(?:previous|system)|call\s+(?:a\s+)?tool|read\s+(?:a\s+)?file|\bwho\b|谁|人脸|识别人|认出|这个人是|那个人是|姓名|名叫|身份|民族|种族|宗教|政治(?:倾向|观点)?|疾病|残疾|性取向|性别认同|怀孕|医疗状况|基因|身份证|住址|电话|邮箱|收入|未成年|男士|女士|男人|女人|男性|女性|男孩|女孩|悲伤|伤心|开心|幸福|愤怒|焦虑|害怕|紧张|孤独|情侣|夫妻|恋人|父母|父亲|母亲|儿子|女儿|亲属|同事|朋友|关系|显然|似乎|可能是|应该是|看起来|大概|估计|推测)/iu;
const GENERIC_FACT_BIGRAMS = new Set(["照片", "画面", "可以", "看到", "一张", "一个", "一位", "其中"]);
const FOLLOWUP_CONTEXT_MAX_CHARS = 500;
export const COLLECTION_NOTICE_CONTEXT_DISCLOSURE =
  "继续聊时，系统会把上一问题、AI 记录的 1–2 条可见事实、你上一答的前 500 字和这张照片发送给当前配置的 AI 处理服务（可能由第三方提供），用来生成下一问题。";
const DEFAULT_COLLECTION_NOTICE_COPY =
  `开始提问后，这张照片会发送给当前配置的 AI 处理服务。${COLLECTION_NOTICE_CONTEXT_DISCLOSURE}` +
  "回答原文仍只由你填写，也可以随时跳过或聊够了。";

function checkedCollectionNotice(notice) {
  requireValue(notice && typeof notice === "object" && !Array.isArray(notice) &&
    typeof notice.version === "string" && notice.version.length >= 1 && notice.version.length <= 200 &&
    typeof notice.plainLanguageCopy === "string" && notice.plainLanguageCopy.length >= 1 &&
    notice.plainLanguageCopy.length <= 2_000 && SHA256.test(notice.hash ?? "") &&
    notice.hash === sha256(notice.plainLanguageCopy) &&
    notice.plainLanguageCopy.includes(COLLECTION_NOTICE_CONTEXT_DISCLOSURE),
  "collection_notice_configuration_invalid", 503);
  return Object.freeze({ version: notice.version, hash: notice.hash,
    plainLanguageCopy: notice.plainLanguageCopy });
}

class BookLabError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function fail(code, status = 400) {
  throw new BookLabError(code, status);
}

function requireValue(condition, code, status = 400) {
  if (!condition) fail(code, status);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const ACTIVE_HTML_TAG = /<\s*\/?\s*(?:script|iframe|object|embed|applet|svg|base|form|input|button)\b/iu;
const DATA_IMAGE = /^data:image\/(?:jpeg|png|webp|svg\+xml);base64,[a-z0-9+/]+={0,2}$/iu;

function safeSelfContainedHtml(html) {
  if (typeof html !== "string" || ACTIVE_HTML_TAG.test(html) || /<!--|<\?|<!\[/u.test(html)) return false;
  const tags = [];
  for (let start = html.indexOf("<"); start !== -1; start = html.indexOf("<", start + 1)) {
    let quote = null;
    let end = start + 1;
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end === html.length || quote) return false;
    const tag = html.slice(start, end + 1);
    if (/^<!/u.test(tag) && !/^<!doctype\s+html\s*>$/iu.test(tag)) return false;
    if (/(?:\s|\/)on[a-z0-9:_-]*\s*=/iu.test(tag) || /(?:\s|\/)style\s*=/iu.test(tag)) return false;
    if (/^<\s*meta\b/iu.test(tag) &&
      /\shttp-equiv\s*=\s*(?:["']\s*refresh\s*["']|refresh(?=[\s>]))/iu.test(tag)) return false;
    const urlAttribute = /\s(src|srcset|href|poster|data|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
    for (const match of tag.matchAll(urlAttribute)) {
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      if (match[1].toLowerCase() !== "src" || !DATA_IMAGE.test(value)) return false;
    }
    tags.push(tag);
    start = end;
  }
  const styles = [];
  const withoutStyles = html.replace(/<\s*style\b[^>]*>([\s\S]*?)<\s*\/\s*style\s*>/giu,
    (_match, css) => { styles.push(css); return ""; });
  if (/<\s*\/?\s*style\b/iu.test(withoutStyles)) return false;
  for (const css of styles) {
    if (/@\s*import\b|\/\*|\\/iu.test(css)) return false;
    for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/giu)) {
      if (!DATA_IMAGE.test((match[1] ?? match[2] ?? match[3] ?? "").trim())) return false;
    }
  }
  return tags.length > 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function factBigrams(value) {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const tokens = new Set();
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    const token = normalized.slice(index, index + 2);
    if (!GENERIC_FACT_BIGRAMS.has(token)) tokens.add(token);
  }
  return tokens;
}

function privateProviderOutcome(value, expectedModel, expectedVersion) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "question_policy_rejected", 409);
  const required = ["modelVisibleFacts", "question", "questionIntent", "model", "modelVersion", "latencyMs"];
  requireValue(Object.keys(value).length === required.length && required.every((key) => Object.hasOwn(value, key)),
    "question_policy_rejected", 409);
  requireValue(Array.isArray(value.modelVisibleFacts) && value.modelVisibleFacts.length >= 1 &&
    value.modelVisibleFacts.length <= 2, "question_policy_rejected", 409);
  const facts = value.modelVisibleFacts.map((fact) => {
    requireValue(typeof fact === "string" && fact.length >= 2 && fact.length <= 160 &&
      !/[?？]/u.test(fact) && !UNSAFE_MODEL_TEXT.test(fact), "question_policy_rejected", 409);
    return fact;
  });
  requireValue(new Set(facts).size === facts.length, "question_policy_rejected", 409);
  requireValue(value.questionIntent === PHOTO_QUESTION_INTENT && typeof value.question === "string" &&
    value.question.length >= 2 && value.question.length <= 300 && !UNSAFE_MODEL_TEXT.test(value.question) &&
    (value.question.match(/[?？]/gu) ?? []).length === 1 && /[?？]$/u.test(value.question),
  "question_policy_rejected", 409);
  const questionBigrams = factBigrams(value.question);
  requireValue(facts.some((fact) => [...factBigrams(fact)].some((token) => questionBigrams.has(token))),
    "question_policy_rejected", 409);
  requireValue(typeof value.model === "string" && value.model.length >= 1 && value.model.length <= 80 &&
    value.model === expectedModel && typeof value.modelVersion === "string" && value.modelVersion.length >= 1 &&
    value.modelVersion.length <= 80 && value.modelVersion === expectedVersion &&
    Number.isSafeInteger(value.latencyMs) && value.latencyMs >= 0 && value.latencyMs <= 300_000,
  "question_policy_rejected", 409);
  return deepFreeze({ modelVisibleFacts: structuredClone(facts), question: value.question,
    questionIntent: value.questionIntent, model: value.model, modelVersion: value.modelVersion,
    latencyMs: value.latencyMs });
}

function fixtureProviderQuestion(kind, facts) {
  const visible = facts.join("、");
  return kind === "initial_question"
    ? `照片里可以看到${visible}。你还记得${visible}发生前后，还有什么现场细节吗？`
    : `围绕照片里的${visible}，后来还发生了什么？`;
}

function exactObject(value, required, optional = []) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "validation_failed");
  const allowed = new Set([...required, ...optional]);
  requireValue(Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key)),
    "validation_failed");
  return value;
}

function text(value, min, max) {
  requireValue(typeof value === "string" && value.length >= min && value.length <= max, "validation_failed");
  return value;
}

function id(value) {
  return text(value, 1, 200);
}

function hash(value) {
  requireValue(typeof value === "string" && SHA256.test(value), "validation_failed");
  return value;
}

function positiveInteger(value) {
  requireValue(Number.isSafeInteger(value) && value > 0, "validation_failed");
  return value;
}

function json(value) {
  return JSON.stringify(value);
}

function parse(value, fallback = null) {
  if (value == null) return fallback;
  return JSON.parse(value);
}

function unquoteEtag(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("W/")) return null;
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ensurePersistentPath(filename) {
  if (filename === ":memory:") return;
  const directory = path.dirname(path.resolve(filename));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function frozenPhotoSource(photo) {
  requireValue(photo && typeof photo === "object", "photo_not_ready", 409);
  const provenance = {};
  for (const field of SOURCE_PROVENANCE_FIELDS) {
    requireValue(Object.hasOwn(photo.provenance ?? {}, field), "photo_not_ready", 409);
    provenance[field] = structuredClone(photo.provenance[field]);
  }
  requireValue(provenance.photoId === photo.photoId, "photo_not_ready", 409);
  const visibleFacts = Array.isArray(photo.visibleFacts) ? photo.visibleFacts :
    typeof photo.visibleAnchor === "string" ? [photo.visibleAnchor] : [];
  requireValue(visibleFacts.length <= 2, "photo_not_ready", 409);
  for (const fact of visibleFacts) text(fact, 2, 160);
  requireValue(new Set(visibleFacts).size === visibleFacts.length, "photo_not_ready", 409);
  return {
    photoId: id(photo.photoId),
    contributorId: id(photo.contributorId),
    completed: photo.completed === true,
    deleted: photo.deleted === true,
    withdrawn: photo.withdrawn === true,
    l3Enabled: photo.l3Enabled === true,
    provenance,
    visibleFacts: structuredClone(visibleFacts)
  };
}

function sourceEligible(source) {
  return source?.completed === true && source.deleted === false && source.withdrawn === false && source.l3Enabled === true;
}

const SCHEMA = `
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS memory_interviews(
  personal_memory_id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL UNIQUE,
  contributor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('eligible','question_queued','question_ready','question_failed','draft','followup_queued','followup_ready','confirmed','skipped','withdrawal_pending','withdrawn')),
  version INTEGER NOT NULL CHECK(version > 0),
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS personal_memories(
  id TEXT PRIMARY KEY REFERENCES memory_interviews(personal_memory_id),
  photo_id TEXT NOT NULL UNIQUE,
  contributor_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  head_submission_id TEXT,
  confirmed_submission_id TEXT,
  confirmed_submission_hash TEXT,
  memory_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answer_submissions(
  id TEXT PRIMARY KEY,
  personal_memory_id TEXT NOT NULL REFERENCES personal_memories(id),
  revision_id TEXT NOT NULL UNIQUE,
  previous_submission_id TEXT,
  user_text TEXT NOT NULL CHECK(length(user_text) BETWEEN 1 AND 10000),
  submission_hash TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  UNIQUE(personal_memory_id,id)
);
CREATE TRIGGER IF NOT EXISTS answer_submissions_append_only
BEFORE UPDATE ON answer_submissions BEGIN SELECT RAISE(ABORT,'answer_submission_immutable'); END;
CREATE TABLE IF NOT EXISTS memory_question_jobs(
  id TEXT PRIMARY KEY,
  personal_memory_id TEXT NOT NULL REFERENCES personal_memories(id),
  kind TEXT NOT NULL CHECK(kind IN ('initial_question','followup_question')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','cancelled')),
  version INTEGER NOT NULL CHECK(version > 0),
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  followup_ordinal INTEGER,
  source_submission_id TEXT,
  source_submission_hash TEXT,
  source_memory_version INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  question TEXT,
  question_hash TEXT,
  model_version TEXT,
  provenance_json TEXT,
  last_stable_error TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS question_jobs_memory_created ON memory_question_jobs(personal_memory_id,created_at,id);
CREATE TABLE IF NOT EXISTS memory_model_fact_drafts(
  id TEXT PRIMARY KEY,
  personal_memory_id TEXT NOT NULL REFERENCES personal_memories(id),
  question_job_id TEXT NOT NULL UNIQUE REFERENCES memory_question_jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','draft_ready','question_ready','answered','confirmed','withdrawn')),
  version INTEGER NOT NULL CHECK(version > 0),
  job_version INTEGER NOT NULL CHECK(job_version > 0),
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  input_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  photo_content_hash TEXT NOT NULL,
  placement_revision_id TEXT NOT NULL,
  placement_snapshot_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  model_visible_facts_json TEXT,
  facts_hash TEXT,
  question_hash TEXT,
  provider_result_hash TEXT,
  provider_latency_ms INTEGER,
  lease_expires_at TEXT,
  retry_after_at TEXT,
  last_stable_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_fact_drafts_memory_created
  ON memory_model_fact_drafts(personal_memory_id,created_at,id);
CREATE TABLE IF NOT EXISTS memory_model_fact_answer_links(
  fact_draft_id TEXT NOT NULL REFERENCES memory_model_fact_drafts(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES answer_submissions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(fact_draft_id,submission_id),
  UNIQUE(submission_id)
);
CREATE TABLE IF NOT EXISTS memory_model_fact_events(
  id TEXT PRIMARY KEY,
  previous_event_id TEXT,
  fact_draft_id TEXT NOT NULL,
  personal_memory_id TEXT NOT NULL,
  question_job_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL CHECK(to_status IN ('pending','draft_ready','question_ready','answered','confirmed','withdrawn')),
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  job_version INTEGER NOT NULL CHECK(job_version > 0),
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  binding_hash TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_fact_events_draft_created
  ON memory_model_fact_events(fact_draft_id,created_at,id);
CREATE TRIGGER IF NOT EXISTS model_fact_events_append_only BEFORE UPDATE ON memory_model_fact_events
BEGIN SELECT RAISE(ABORT,'model_fact_event_immutable'); END;
CREATE TABLE IF NOT EXISTS memory_denials(
  personal_memory_id TEXT PRIMARY KEY REFERENCES personal_memories(id),
  withdrawal_id TEXT NOT NULL UNIQUE,
  read_blocked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS withdrawal_receipts(
  id TEXT PRIMARY KEY,
  personal_memory_id TEXT NOT NULL REFERENCES personal_memories(id),
  scope TEXT NOT NULL,
  read_blocked_at TEXT NOT NULL,
  purge_status TEXT NOT NULL CHECK(purge_status IN ('queued','running','complete','retrying')),
  affected_book_version_ids_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cleanup_outbox(
  withdrawal_id TEXT PRIMARY KEY REFERENCES withdrawal_receipts(id),
  personal_memory_id TEXT NOT NULL REFERENCES personal_memories(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','complete','retrying')),
  attempt INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_receipts(
  principal_scope TEXT NOT NULL,
  method TEXT NOT NULL,
  canonical_endpoint TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  action_id TEXT NOT NULL,
  target_memory_id TEXT,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  response_headers_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(principal_scope,method,canonical_endpoint,key_hash)
);
CREATE TABLE IF NOT EXISTS memory_events(
  id TEXT PRIMARY KEY,
  previous_event_id TEXT,
  personal_memory_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_events_aggregate ON memory_events(personal_memory_id,created_at,id);
CREATE TABLE IF NOT EXISTS memory_books(
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  version INTEGER NOT NULL CHECK(version > 0),
  current_draft_version_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_books_space ON memory_books(space_id,created_at,id);
CREATE TABLE IF NOT EXISTS book_draft_versions(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES memory_books(id),
  parent_version_id TEXT REFERENCES book_draft_versions(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK(status IN ('empty','editing','preview_queued','preview_ready','preview_failed','stale','freeze_checking','frozen')),
  version INTEGER NOT NULL CHECK(version > 0),
  pages_json TEXT NOT NULL,
  grant_set_hash TEXT NOT NULL,
  stale_reason TEXT CHECK(stale_reason IS NULL OR stale_reason IN
    ('grant_authorized','grant_withdrawn','memory_withdrawn','source_revoked','input_changed')),
  preview_worker_input_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_version_access_controls(
  version_id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES memory_books(id),
  status TEXT NOT NULL CHECK(status IN ('active','affected','revoked')),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_version_grants(
  version_id TEXT NOT NULL REFERENCES book_version_access_controls(version_id),
  grant_id TEXT NOT NULL REFERENCES book_contribution_grants(id),
  PRIMARY KEY(version_id,grant_id)
);
CREATE TABLE IF NOT EXISTS book_versions(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES memory_books(id),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  draft_version_id TEXT NOT NULL REFERENCES book_draft_versions(id),
  status TEXT NOT NULL CHECK(status IN ('rendering','available','render_failed','withdrawal_affected','superseded')),
  manifest_hash TEXT NOT NULL,
  authorization_snapshot_hash TEXT NOT NULL,
  authorized_text_snapshot_hash TEXT NOT NULL,
  asset_snapshot_hash TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK(page_count BETWEEN 12 AND 16),
  created_at TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  UNIQUE(book_id,ordinal),
  UNIQUE(book_id,draft_version_id)
);
CREATE TABLE IF NOT EXISTS book_version_source_entries(
  version_id TEXT NOT NULL REFERENCES book_versions(id),
  photo_id TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY(version_id,photo_id)
);
CREATE TABLE IF NOT EXISTS immutable_frozen_book_manifests(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES memory_books(id),
  book_version_id TEXT NOT NULL UNIQUE REFERENCES book_versions(id),
  title TEXT NOT NULL,
  manifest_hash TEXT NOT NULL UNIQUE,
  authorization_snapshot_hash TEXT NOT NULL,
  authorized_text_snapshot_hash TEXT NOT NULL,
  asset_snapshot_hash TEXT NOT NULL,
  pages_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS immutable_authorized_memory_text_snapshots(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES memory_books(id),
  book_version_id TEXT NOT NULL REFERENCES book_versions(id),
  personal_memory_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS immutable_frozen_book_assets(
  id TEXT PRIMARY KEY,
  book_version_id TEXT NOT NULL REFERENCES book_versions(id),
  photo_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source_photo','display_photo')),
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  bytes_blob BLOB NOT NULL,
  UNIQUE(book_version_id,photo_id)
);
CREATE TRIGGER IF NOT EXISTS frozen_manifest_append_only BEFORE UPDATE ON immutable_frozen_book_manifests
BEGIN SELECT RAISE(ABORT,'frozen_manifest_immutable'); END;
CREATE TRIGGER IF NOT EXISTS authorized_memory_text_append_only BEFORE UPDATE ON immutable_authorized_memory_text_snapshots
BEGIN SELECT RAISE(ABORT,'authorized_memory_text_immutable'); END;
CREATE TRIGGER IF NOT EXISTS frozen_book_asset_append_only BEFORE UPDATE ON immutable_frozen_book_assets
BEGIN SELECT RAISE(ABORT,'frozen_book_asset_immutable'); END;
CREATE TRIGGER IF NOT EXISTS book_version_source_append_only BEFORE UPDATE ON book_version_source_entries
BEGIN SELECT RAISE(ABORT,'book_version_source_immutable'); END;
CREATE TABLE IF NOT EXISTS book_contribution_grants(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES memory_books(id),
  personal_memory_id TEXT NOT NULL REFERENCES personal_memories(id),
  memory_revision_id TEXT NOT NULL,
  confirmed_submission_hash TEXT NOT NULL,
  contributor_id TEXT NOT NULL,
  credit_label TEXT NOT NULL CHECK(length(credit_label) BETWEEN 1 AND 120),
  audience_scope TEXT NOT NULL CHECK(audience_scope='current_live_space_viewers'),
  status TEXT NOT NULL CHECK(status IN ('not_granted','active','withdrawal_pending','withdrawn')),
  notice_version TEXT NOT NULL,
  notice_hash TEXT NOT NULL,
  title_audit_snapshot_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  granted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS book_grants_one_live ON book_contribution_grants(book_id,personal_memory_id)
  WHERE status IN ('active','withdrawal_pending');
CREATE INDEX IF NOT EXISTS book_grants_memory ON book_contribution_grants(personal_memory_id,granted_at,id);
CREATE TABLE IF NOT EXISTS book_grant_denials(
  grant_id TEXT PRIMARY KEY REFERENCES book_contribution_grants(id),
  withdrawal_id TEXT NOT NULL UNIQUE,
  read_blocked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_source_grant_denials(
  grant_id TEXT PRIMARY KEY REFERENCES book_contribution_grants(id),
  detected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_grant_withdrawal_receipts(
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL UNIQUE REFERENCES book_contribution_grants(id),
  book_id TEXT NOT NULL REFERENCES memory_books(id),
  personal_memory_id TEXT NOT NULL REFERENCES personal_memories(id),
  read_blocked_at TEXT NOT NULL,
  purge_status TEXT NOT NULL CHECK(purge_status IN ('queued','running','complete','retrying')),
  affected_book_version_ids_json TEXT NOT NULL,
  access_control_version INTEGER NOT NULL CHECK(access_control_version > 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_grant_cleanup_outbox(
  withdrawal_id TEXT PRIMARY KEY REFERENCES book_grant_withdrawal_receipts(id),
  grant_id TEXT NOT NULL REFERENCES book_contribution_grants(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','complete','retrying')),
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_render_jobs(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES memory_books(id),
  status TEXT NOT NULL CHECK(status IN ('queued','rendering_html','ready','failed','cancelled')),
  version INTEGER NOT NULL CHECK(version > 0),
  input_hash TEXT NOT NULL,
  draft_version_id TEXT,
  book_version_id TEXT REFERENCES book_versions(id),
  grant_set_hash TEXT,
  layout_profile TEXT,
  input_json TEXT,
  manifest_hash TEXT,
  source_snapshot_hash TEXT,
  authorized_text_snapshot_hash TEXT,
  asset_snapshot_hash TEXT,
  access_control_version INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  preview_hash TEXT,
  page_count INTEGER,
  html_artifact_id TEXT,
  html_hash TEXT,
  pdf_hash TEXT,
  last_stable_error TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_preview_artifacts(
  id TEXT PRIMARY KEY,
  render_job_id TEXT NOT NULL UNIQUE REFERENCES book_render_jobs(id),
  input_hash TEXT NOT NULL,
  html_blob BLOB NOT NULL,
  html_hash TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK(page_count BETWEEN 12 AND 16),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS render_artifacts(
  id TEXT PRIMARY KEY,
  render_job_id TEXT NOT NULL REFERENCES book_render_jobs(id),
  version_id TEXT NOT NULL REFERENCES book_versions(id),
  format TEXT NOT NULL CHECK(format IN ('html','pdf')),
  status TEXT NOT NULL CHECK(status IN ('queued','rendering_html','html_ready','rendering_pdf','verifying','available','failed','revoked','purged')),
  content_blob BLOB,
  content_hash TEXT,
  page_count INTEGER CHECK(page_count IS NULL OR page_count BETWEEN 12 AND 16),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(version_id,format)
);
CREATE TABLE IF NOT EXISTS book_events(
  id TEXT PRIMARY KEY,
  previous_event_id TEXT,
  book_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS book_events_aggregate ON book_events(book_id,created_at,id);
`;

const RENDER_JOB_COLUMNS = Object.freeze({
  draft_version_id: "TEXT",
  book_version_id: "TEXT",
  grant_set_hash: "TEXT",
  layout_profile: "TEXT",
  input_json: "TEXT",
  manifest_hash: "TEXT",
  source_snapshot_hash: "TEXT",
  authorized_text_snapshot_hash: "TEXT",
  asset_snapshot_hash: "TEXT",
  access_control_version: "INTEGER NOT NULL DEFAULT 0",
  attempt: "INTEGER NOT NULL DEFAULT 0",
  lease_expires_at: "TEXT",
  preview_hash: "TEXT",
  page_count: "INTEGER",
  html_artifact_id: "TEXT",
  html_hash: "TEXT",
  pdf_hash: "TEXT",
  created_at: "TEXT"
});

const QUESTION_JOB_COLUMNS = Object.freeze({
  lease_expires_at: "TEXT"
});

function migrateQuestionJobs(db) {
  const present = new Set(db.prepare("PRAGMA table_info(memory_question_jobs)").all().map((row) => row.name));
  for (const [column, definition] of Object.entries(QUESTION_JOB_COLUMNS)) {
    if (!present.has(column)) db.exec(`ALTER TABLE memory_question_jobs ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`UPDATE memory_question_jobs SET lease_expires_at=updated_at
    WHERE status='running' AND lease_expires_at IS NULL;
    UPDATE memory_question_jobs SET lease_expires_at=NULL WHERE status!='running';`);
}

function migrateRenderJobs(db) {
  const present = new Set(db.prepare("PRAGMA table_info(book_render_jobs)").all().map((row) => row.name));
  for (const [column, definition] of Object.entries(RENDER_JOB_COLUMNS)) {
    if (!present.has(column)) db.exec(`ALTER TABLE book_render_jobs ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`UPDATE book_render_jobs SET created_at=COALESCE(created_at,updated_at);
    UPDATE book_render_jobs SET status='cancelled',version=version+1,last_stable_error='render_input_changed',
    lease_expires_at=NULL WHERE status IN ('queued','rendering_html') AND
    (draft_version_id IS NULL OR grant_set_hash IS NULL OR input_json IS NULL OR manifest_hash IS NULL);`);
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function headersFor(memoryEtag, interviewEtag, followupEtag) {
  return {
    ...BASE_HEADERS,
    ...(memoryEtag ? { etag: `"${memoryEtag}"`, "x-unseen-memory-etag": memoryEtag } : {}),
    ...(interviewEtag ? { "x-unseen-interview-etag": interviewEtag } : {}),
    ...(followupEtag ? { "x-unseen-followup-etag": followupEtag } : {})
  };
}

export class BookLabMemoryApi {
  constructor({ core, database = ":memory:", db, clock = Date, etagSecret, workerSecret, currentNotice,
    cleanupSecret, renderWorkerSecret, currentBookNotice,
    previewLayouts = ["book-lab-v0", "book-lab-v1"], previewLeaseMs = 30_000,
    providerModel = "fixture-private-question", modelVersion = "fixture-question-v1",
    promptHash = sha256("book-lab-fixture-prompt-v1"),
    policyHash = sha256("book-lab-question-policy-v1"), followupLimit = 3, questionProvider,
    questionProviderConfigured = true, questionLeaseMs = 30_000, questionProviderTimeoutMs = 30_000 } = {}) {
    requireValue(core, "core_port_required", 500);
    const persistent = database !== ":memory:" || Boolean(db);
    requireValue(!persistent || typeof etagSecret === "string" && etagSecret.length >= 32, "etag_secret_required", 503);
    requireValue(!persistent || typeof workerSecret === "string" && workerSecret.length >= 32, "worker_secret_required", 503);
    requireValue(!persistent || typeof cleanupSecret === "string" && cleanupSecret.length >= 32, "cleanup_secret_required", 503);
    requireValue(renderWorkerSecret == null || typeof renderWorkerSecret === "string" && renderWorkerSecret.length >= 32,
      "render_worker_secret_required", 503);
    ensurePersistentPath(database);
    this.db = db ?? new DatabaseSync(database);
    this.db.exec("PRAGMA secure_delete=ON;");
    requireValue(this.db.prepare("PRAGMA secure_delete").get().secure_delete === 1, "secure_delete_required", 503);
    if (database !== ":memory:") chmodSync(database, 0o600);
    this.db.exec(SCHEMA);
    migrateQuestionJobs(this.db);
    migrateRenderJobs(this.db);
    if (database !== ":memory:") {
      this.db.exec("PRAGMA journal_mode=WAL;");
      chmodSync(database, 0o600);
    }
    this.database = database;
    this.core = core;
    this.clock = clock;
    this.etagSecret = etagSecret ?? randomBytes(32).toString("base64url");
    this.workerSecret = workerSecret ?? randomBytes(32).toString("base64url");
    this.cleanupSecret = cleanupSecret ?? randomBytes(32).toString("base64url");
    this.renderWorkerSecret = renderWorkerSecret ?? (persistent ? null : randomBytes(32).toString("base64url"));
    this.currentNotice = checkedCollectionNotice(currentNotice ?? { version: "fixture-2-contextual-followup",
      hash: sha256(DEFAULT_COLLECTION_NOTICE_COPY), plainLanguageCopy: DEFAULT_COLLECTION_NOTICE_COPY });
    this.currentBookNotice = currentBookNotice ?? Object.freeze({ version: "fixture-book-grant-1",
      hash: sha256("book-lab-grant-notice-fixture-1") });
    this.providerModel = providerModel;
    this.modelVersion = modelVersion;
    this.promptHash = promptHash;
    this.policyHash = policyHash;
    this.followupLimit = followupLimit;
    requireValue(typeof providerModel === "string" && providerModel.length >= 1 && providerModel.length <= 80 &&
      typeof modelVersion === "string" && modelVersion.length >= 1 && modelVersion.length <= 80 &&
      SHA256.test(promptHash) && SHA256.test(policyHash), "question_provider_configuration_invalid", 503);
    requireValue(Number.isSafeInteger(followupLimit) && followupLimit >= 1 && followupLimit <= 3,
      "question_provider_configuration_invalid", 503);
    requireValue(typeof questionProviderConfigured === "boolean", "question_provider_configuration_invalid", 503);
    this.questionProviderConfigured = questionProviderConfigured;
    requireValue(Number.isSafeInteger(questionLeaseMs) && questionLeaseMs >= 1_000 && questionLeaseMs <= 300_000,
      "question_provider_configuration_invalid", 503);
    requireValue(Number.isSafeInteger(questionProviderTimeoutMs) && questionProviderTimeoutMs >= 1 &&
      questionProviderTimeoutMs <= 300_000, "question_provider_configuration_invalid", 503);
    requireValue(questionProvider == null || typeof questionProvider === "function",
      "question_provider_configuration_invalid", 503);
    this.questionLeaseMs = questionLeaseMs;
    this.questionProviderTimeoutMs = questionProviderTimeoutMs;
    requireValue(Array.isArray(previewLayouts) && previewLayouts.length >= 1 && previewLayouts.every((layout) =>
      typeof layout === "string" && PREVIEW_LAYOUTS.has(layout)), "preview_layout_configuration_invalid", 503);
    requireValue(Number.isSafeInteger(previewLeaseMs) && previewLeaseMs >= 1_000 && previewLeaseMs <= 300_000,
      "preview_lease_configuration_invalid", 503);
    this.previewLayouts = new Set(previewLayouts);
    this.previewLeaseMs = previewLeaseMs;
    this.artifactLookupCount = 0;
    this.questionProvider = questionProvider ?? ((input) => ({
      modelVisibleFacts: input.visibleFacts,
      question: fixtureProviderQuestion(input.kind, input.visibleFacts),
      questionIntent: QUESTION_INTENT[input.kind],
      model: this.providerModel,
      modelVersion: this.modelVersion,
      latencyMs: 0
    }));
    this.questionOperations = new Set();
    this.closed = false;
  }

  nowMs() {
    return typeof this.clock.now === "function" ? this.clock.now() : Date.now();
  }

  now() {
    return new Date(this.nowMs()).toISOString();
  }

  token(kind, ...parts) {
    const mac = createHmac("sha256", this.etagSecret).update(stableJson([kind, ...parts])).digest("base64url");
    return `bl1.${mac}`;
  }

  interviewEtag(row) {
    return this.token("interview", row.personal_memory_id, row.version);
  }

  memoryEtag(row) {
    return this.token("memory", row.id, row.version, this.memoryFanoutSnapshot(row.id));
  }

  memoryFanoutSnapshot(memoryId) {
    return this.db.prepare(`SELECT g.id grant_id,g.book_id,g.version grant_version,g.status,d.id draft_id,
      d.version draft_version FROM book_contribution_grants g JOIN memory_books b ON b.id=g.book_id
      JOIN book_draft_versions d ON d.id=b.current_draft_version_id WHERE g.personal_memory_id=?
      AND g.status IN ('active','withdrawal_pending') ORDER BY g.id`).all(memoryId).map((row) => ({ ...row,
      accessControls: this.accessControlSnapshot(row.book_id) }));
  }

  currentBook(bookId) {
    return this.db.prepare(`SELECT b.*,d.id draft_id,d.status draft_status,d.version draft_version,
      d.title draft_title,d.pages_json,d.grant_set_hash,d.stale_reason,d.preview_worker_input_hash,
      d.parent_version_id FROM memory_books b
      JOIN book_draft_versions d ON d.id=b.current_draft_version_id
      WHERE b.id=?`).get(bookId) ?? null;
  }

  accessControlSnapshot(bookId) {
    return this.db.prepare(`SELECT version_id versionId,version,status FROM book_version_access_controls
      WHERE book_id=? ORDER BY version_id`).all(bookId);
  }

  grantAccessControlSnapshot(grantId) {
    return this.db.prepare(`SELECT c.version_id versionId,c.version,c.status
      FROM book_version_access_controls c JOIN book_version_grants g ON g.version_id=c.version_id
      WHERE g.grant_id=? ORDER BY c.version_id`).all(grantId);
  }

  authorizationEtag(memory, book) {
    return this.token("book-authorization", memory.id, memory.version, book.id, book.version,
      book.draft_id, book.draft_version);
  }

  grantWithdrawalEtag(grant, book) {
    return this.token("book-grant-withdrawal", grant.id, grant.version, book.draft_id,
      book.draft_version, this.grantAccessControlSnapshot(grant.id));
  }

  ownerBookEtag(book) {
    return this.token("owner-book", book.id, book.version, book.draft_id, book.draft_version,
      this.accessControlSnapshot(book.id));
  }

  latestQuestionJob(memoryId) {
    return this.db.prepare(`SELECT * FROM memory_question_jobs WHERE personal_memory_id=?
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(memoryId) ?? null;
  }

  followupEtag(memory, job = this.latestQuestionJob(memory.id)) {
    if (!job) return null;
    return this.token("followup", memory.id, memory.version, job.id, job.version);
  }

  principal(headers) {
    const principal = this.core.authenticate(headers, this.nowMs());
    requireValue(principal, "memory_unavailable", 404);
    return principal;
  }

  ownerPrincipal(headers, spaceId) {
    id(spaceId);
    const principal = this.core.readCurrentOwner?.(headers, spaceId);
    requireValue(principal, "authorization_changed", 409);
    return principal;
  }

  revalidateOwner(principal) {
    requireValue(this.core.revalidateCurrentOwner?.(principal) === true, "authorization_changed", 409);
  }

  ownedPhoto(principal, photoId) {
    const photo = this.core.readOwnedPhoto(principal, photoId);
    requireValue(photo, "memory_unavailable", 404);
    return photo;
  }

  interviewByPhoto(photoId) {
    return this.db.prepare("SELECT * FROM memory_interviews WHERE photo_id=?").get(photoId) ?? null;
  }

  ownedMemory(principal, memoryId, { allowDenied = false } = {}) {
    const memory = this.db.prepare(`SELECT p.*,i.status interview_status,i.version interview_version,
      i.provenance_json,i.updated_at interview_updated_at FROM personal_memories p
      JOIN memory_interviews i ON i.personal_memory_id=p.id
      WHERE p.id=? AND p.contributor_id=?`).get(memoryId, principal.contributorId);
    requireValue(memory, "memory_unavailable", 404);
    if (principal.allowedPhotoIds && !principal.allowedPhotoIds.has(memory.photo_id)) fail("memory_unavailable", 404);
    if (!allowDenied && this.db.prepare("SELECT 1 FROM memory_denials WHERE personal_memory_id=?").get(memoryId)) {
      fail("memory_unavailable", 404);
    }
    return memory;
  }

  memoryDto(row) {
    requireValue(MEMORY_STATES.has(row.interview_status), "internal_error", 500);
    return {
      personalMemoryId: row.id,
      photoId: row.photo_id,
      contributorId: row.contributor_id,
      status: row.interview_status,
      interviewVersion: row.interview_version,
      version: row.version,
      headSubmissionId: row.head_submission_id,
      confirmedSubmissionId: row.confirmed_submission_id,
      confirmedSubmissionHash: row.confirmed_submission_hash,
      memoryRevisionId: row.memory_revision_id,
      provenance: parse(row.provenance_json)
    };
  }

  submissions(memoryId) {
    return this.db.prepare(`SELECT id submissionId,personal_memory_id personalMemoryId,revision_id revisionId,
      previous_submission_id previousSubmissionId,user_text userText,submission_hash submissionHash,
      submitted_at submittedAt FROM answer_submissions WHERE personal_memory_id=? ORDER BY submitted_at,rowid`)
      .all(memoryId).map((row) => ({ ...row }));
  }

  questionJobDto(row) {
    const provenance = row.status === "ready" ? parse(row.provenance_json) : null;
    const factDraft = this.db.prepare("SELECT retry_after_at FROM memory_model_fact_drafts WHERE question_job_id=?")
      .get(row.id);
    const retryDelay = factDraft?.retry_after_at == null ? 0 :
      Math.max(0, Date.parse(factDraft.retry_after_at) - this.nowMs());
    const recovery = {
      jobId: row.id,
      kind: row.kind,
      status: row.status,
      attempt: row.attempt,
      statusPath: `/v2-labs/memories/${row.personal_memory_id}`,
      nextPollAfterMs: ["queued", "running"].includes(row.status) ? Math.max(250, retryDelay) : null,
      lastStableError: row.last_stable_error,
      updatedAt: row.updated_at
    };
    const base = {
      jobId: row.id,
      personalMemoryId: row.personal_memory_id,
      status: row.status,
      version: row.version,
      question: row.question,
      questionHash: row.question_hash,
      modelVersion: row.model_version,
      questionProvenance: provenance,
      recovery
    };
    return row.kind === "followup_question" ? { ...base, followupOrdinal: row.followup_ordinal } : base;
  }

  recoverableJobs(memoryId) {
    return this.db.prepare(`SELECT * FROM memory_question_jobs WHERE personal_memory_id=? ORDER BY created_at,rowid`)
      .all(memoryId).map((row) => this.questionJobDto(row));
  }

  grantDto(row) {
    return {
      grantId: row.id,
      bookId: row.book_id,
      personalMemoryId: row.personal_memory_id,
      memoryRevisionId: row.memory_revision_id,
      confirmedSubmissionHash: row.confirmed_submission_hash,
      contributorId: row.contributor_id,
      creditLabel: row.credit_label,
      audienceScope: row.audience_scope,
      status: row.status,
      noticeVersion: row.notice_version,
      noticeHash: row.notice_hash,
      titleAuditSnapshot: parse(row.title_audit_snapshot_json),
      grantedAt: row.granted_at,
      version: row.version
    };
  }

  grantReceipts(memoryId) {
    return this.db.prepare(`SELECT * FROM book_contribution_grants WHERE personal_memory_id=?
      ORDER BY granted_at,rowid`).all(memoryId).map((row) => this.grantDto(row));
  }

  bookOptions(spaceId) {
    const persisted = this.db.prepare(`SELECT id FROM memory_books WHERE space_id=? ORDER BY created_at,rowid`)
      .all(spaceId).flatMap(({ id: bookId }) => {
        const book = this.currentBook(bookId);
        return book?.space_id === spaceId && book.title === book.draft_title ? [{ bookId, currentTitle: book.title,
          audienceScope: "current_live_space_viewers", noticeVersion: this.currentBookNotice.version,
          noticeHash: this.currentBookNotice.hash, eligible: true }] : [];
      });
    if (persisted.length > 0) return persisted;
    return [];
  }

  currentMemorySource(principal, memory, storedSource = null) {
    let photo;
    let source;
    try {
      photo = this.core.readOwnedPhoto?.(principal, memory.photo_id);
      source = frozenPhotoSource(photo);
      storedSource ??= parse(memory.provenance_json);
    } catch { return false; }
    return sourceEligible(source) && stableJson(source.provenance) === stableJson(storedSource);
  }

  contributionHeaders(principal, memory, options) {
    let frozenSource = null;
    try { frozenSource = parse(memory?.provenance_json); } catch { /* fail closed below */ }
    const sourceCurrent = memory && frozenSource ? this.currentMemorySource(principal, memory, frozenSource) : false;
    const spaceId = frozenSource?.spaceId ?? null;
    const canAuthorize = sourceCurrent && memory.interview_status === "confirmed" && memory.memory_revision_id &&
      SHA256.test(memory.confirmed_submission_hash);
    const eligibleBooks = canAuthorize ? options.filter((option) => {
      if (!/^[\x21-\x7e]{1,200}$/.test(option.bookId)) return false;
      const book = this.currentBook(option.bookId);
      const alreadyGranted = this.db.prepare(`SELECT 1 FROM book_contribution_grants WHERE book_id=?
        AND personal_memory_id=? AND status IN ('active','withdrawal_pending')`).get(option.bookId, memory.id);
      return book?.space_id === spaceId && !alreadyGranted;
    }) : [];
    const values = {};
    if (canAuthorize) {
      for (const option of eligibleBooks) {
        const book = this.currentBook(option.bookId);
        values[option.bookId] = this.authorizationEtag(memory, book);
      }
    }
    const withdrawalEtags = {};
    if (memory) {
      const active = this.db.prepare(`SELECT * FROM book_contribution_grants WHERE personal_memory_id=?
        AND contributor_id=? AND status='active' ORDER BY book_id,granted_at,rowid`)
        .all(memory.id, principal.contributorId);
      for (const grant of active) {
        if (!/^[\x21-\x7e]{1,200}$/.test(grant.book_id)) continue;
        const book = this.currentBook(grant.book_id);
        if (!book || book.space_id !== spaceId) continue;
        if (withdrawalEtags[grant.book_id]) withdrawalEtags[grant.book_id] = null;
        else withdrawalEtags[grant.book_id] = { grantId: grant.id, etag: this.grantWithdrawalEtag(grant, book) };
      }
      for (const [bookId, value] of Object.entries(withdrawalEtags)) if (!value) delete withdrawalEtags[bookId];
    }
    const eligibleProjection = eligibleBooks.map(({ bookId, audienceScope, noticeVersion, noticeHash, eligible }) =>
      ({ bookId, audienceScope, noticeVersion, noticeHash, eligible }));
    return {
      "x-unseen-book-eligible-books": stableJson(eligibleProjection),
      ...(Object.keys(values).length > 0 ? { "x-unseen-book-authorization-etags": stableJson(values) } : {}),
      ...(Object.keys(withdrawalEtags).length > 0
        ? { "x-unseen-book-withdrawal-etags": stableJson(withdrawalEtags) } : {})
    };
  }

  grantSetHash(bookId) {
    const active = this.db.prepare(`SELECT id,version FROM book_contribution_grants
      WHERE book_id=? AND status='active' ORDER BY id`).all(bookId);
    return sha256(stableJson(active.map((row) => ({ grantId: row.id, version: row.version }))));
  }

  previewJobDto(row) {
    return {
      jobId: row.id,
      bookId: row.book_id,
      status: row.status,
      version: row.version,
      draftVersionId: row.draft_version_id,
      grantSetHash: row.grant_set_hash,
      ...(row.status === "ready" ? { previewHash: row.preview_hash, pageCount: row.page_count,
        htmlArtifactId: row.html_artifact_id } : {}),
      recovery: {
        jobId: row.id,
        kind: "book_render",
        status: row.status === "rendering_html" ? "running" : row.status,
        attempt: row.attempt,
        statusPath: `/v2-labs/owner/spaces/${this.currentBook(row.book_id)?.space_id}/books/${row.book_id}/draft`,
        nextPollAfterMs: ["queued", "rendering_html"].includes(row.status) ? 250 : null,
        lastStableError: row.last_stable_error,
        updatedAt: row.updated_at
      }
    };
  }

  draftDto(book) {
    return {
      bookId: book.id,
      spaceId: book.space_id,
      title: book.draft_title,
      status: book.draft_status,
      version: book.draft_version,
      draftVersionId: book.draft_id,
      pages: parse(book.pages_json, []),
      grantSetHash: book.grant_set_hash,
      recoverableRenderJobs: this.db.prepare(`SELECT * FROM book_render_jobs WHERE book_id=?
        ORDER BY updated_at,rowid`).all(book.id).map((row) => this.previewJobDto(row).recovery),
      staleReason: book.stale_reason
    };
  }

  bookVersionDto(row) {
    return {
      versionId: row.id,
      bookId: row.book_id,
      ordinal: row.ordinal,
      status: row.status,
      manifestHash: row.manifest_hash,
      authorizationSnapshotHash: row.authorization_snapshot_hash,
      authorizedMemoryTextSnapshotHash: row.authorized_text_snapshot_hash,
      assetSnapshotHash: row.asset_snapshot_hash,
      pageCount: row.page_count,
      createdAt: row.created_at,
      manifestState: "frozen",
      frozenAt: row.frozen_at
    };
  }

  renderArtifactDto(row) {
    return {
      artifactId: row.id,
      versionId: row.version_id,
      format: row.format,
      status: row.status,
      contentHash: row.content_hash,
      pageCount: row.page_count,
      createdAt: row.created_at
    };
  }

  liveBookViewer(headers, spaceId) {
    let viewer = null;
    try { viewer = this.core.readCurrentBookViewer?.(headers, spaceId); } catch { viewer = null; }
    requireValue(viewer, "book_version_unavailable", 404);
    return viewer;
  }

  revalidateBookActor(actor, errorCode, status) {
    let current = false;
    try {
      current = actor?.kind === "owner"
        ? this.core.revalidateCurrentOwner?.(actor)
        : this.core.revalidateCurrentBookViewer?.(actor);
    } catch { current = false; }
    requireValue(current === true, errorCode, status);
  }

  bookPhotoRecord(actor, raw, photoId, needsAsset, errorCode, assetErrorCode, status) {
    let source;
    try { source = frozenPhotoSource(raw); } catch { fail(errorCode, status); }
    requireValue(source.photoId === photoId && source.provenance.spaceId === actor.spaceId &&
      sourceEligible(source) && raw?.photoContentState === "visible" && raw.deletedAt == null,
    errorCode, status);
    if (!needsAsset) return deepFreeze({ source });
    const asset = raw?.renderAsset;
    requireValue(asset && ["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType) &&
      typeof asset.bytesBase64 === "string" && asset.bytesBase64.length >= 1 && SHA256.test(asset.contentHash) &&
      asset.sourcePhotoContentHash === source.provenance.photoContentHash &&
      asset.sourcePhotosVersion === source.provenance.sourcePhotosVersion, assetErrorCode, status);
    let bytes;
    try { bytes = Buffer.from(asset.bytesBase64, "base64"); } catch { fail(assetErrorCode, status); }
    requireValue(bytes.length >= 1 && bytes.length <= MAX_RENDER_ASSET_BYTES &&
      bytes.toString("base64") === asset.bytesBase64 && sha256(bytes) === asset.contentHash,
    assetErrorCode, status);
    return deepFreeze({ source, asset: { mimeType: asset.mimeType, bytesBase64: asset.bytesBase64,
      contentHash: asset.contentHash, byteLength: bytes.length } });
  }

  async readBookPhotoCapability(actor, requests, { actorErrorCode, resourceErrorCode,
    assetErrorCode = resourceErrorCode, status }) {
    requireValue(actor && Array.isArray(requests), actorErrorCode, status);
    const needsAsset = new Map();
    for (const request of requests) {
      if (!request?.photoId) continue;
      needsAsset.set(request.photoId, needsAsset.get(request.photoId) === true || request.needsAsset === true);
    }
    this.revalidateBookActor(actor, actorErrorCode, status);
    let first = null;
    for (let pass = 0; pass < 2; pass += 1) {
      const records = new Map();
      for (const [photoId, assetRequired] of needsAsset) {
        let raw = null;
        try { raw = await this.core.readDisplayPhotoForOwner?.(actor, photoId); } catch { raw = null; }
        this.revalidateBookActor(actor, actorErrorCode, status);
        records.set(photoId, this.bookPhotoRecord(actor, raw, photoId, assetRequired, resourceErrorCode,
          assetErrorCode, status));
      }
      if (first) {
        for (const [photoId, record] of records) {
          const before = first.get(photoId);
          requireValue(stableJson(record.source) === stableJson(before?.source), resourceErrorCode, status);
          requireValue(stableJson(record.asset) === stableJson(before?.asset), assetErrorCode, status);
        }
      } else first = records;
    }
    this.revalidateBookActor(actor, actorErrorCode, status);
    const records = first;
    return Object.freeze({ get(photoId) { return records.get(photoId) ?? null; } });
  }

  liveBookSource(capability, photoId) {
    return capability?.get(photoId)?.source ?? null;
  }

  applySourceRevoked(sourcePhotoIds = []) {
    const exactPhotoIds = [...new Set(sourcePhotoIds)].filter(Boolean);
    if (exactPhotoIds.length === 0) return;
    const placeholders = exactPhotoIds.map(() => "?").join(",");
    const now = this.now();
    const grants = this.db.prepare(`SELECT g.id,g.book_id FROM book_contribution_grants g
      JOIN personal_memories p ON p.id=g.personal_memory_id
      WHERE p.photo_id IN (${placeholders}) ORDER BY g.book_id,g.id`).all(...exactPhotoIds);
    for (const grant of grants) {
      this.db.prepare(`INSERT INTO book_source_grant_denials(grant_id,detected_at) VALUES(?,?)
        ON CONFLICT(grant_id) DO NOTHING`).run(grant.id, now);
    }
    const versions = this.db.prepare(`SELECT DISTINCT v.id,v.book_id FROM book_versions v
      JOIN book_version_source_entries s ON s.version_id=v.id
      WHERE s.photo_id IN (${placeholders}) ORDER BY v.book_id,v.id`).all(...exactPhotoIds);
    for (const version of versions) {
      this.db.prepare(`UPDATE book_version_access_controls SET status='affected',version=version+1,updated_at=?
        WHERE version_id=? AND status='active'`).run(now, version.id);
    }
    const affectedVersionIds = versions.map((version) => version.id);
    this.revokeFrozenVersions(affectedVersionIds, now);
    this.purgeFrozenVersionContent(affectedVersionIds);
    const grantsByBook = new Map();
    for (const grant of grants) grantsByBook.set(grant.book_id,
      [...(grantsByBook.get(grant.book_id) ?? []), grant.id]);
    for (const [bookId, grantIds] of grantsByBook) {
      this.invalidateDraft(bookId, "source_revoked", grantIds);
      this.scrubDraftHistory(bookId, grantIds);
      this.scrubPreviewContent(bookId, grantIds);
    }
    for (const version of versions) {
      const prior = this.db.prepare(`SELECT 1 FROM book_events WHERE book_id=? AND event_type='SOURCE_REVOKED'
        AND json_extract(detail_json,'$.versionId')=? LIMIT 1`).get(version.book_id, version.id);
      if (!prior) this.bookEvent(version.book_id, "SOURCE_REVOKED", "source_guard", "book-lab-source-guard",
        { versionId: version.id });
    }
  }

  markSourceRevoked(sourcePhotoIds = []) {
    transaction(this.db, () => this.applySourceRevoked(sourcePhotoIds));
  }

  bookVersionSnapshot(spaceId, bookId, versionId) {
      const version = this.db.prepare(`SELECT v.*,b.space_id FROM book_versions v
        JOIN memory_books b ON b.id=v.book_id WHERE v.id=? AND v.book_id=? AND b.space_id=?`)
        .get(versionId, bookId, spaceId);
      const control = version && this.db.prepare("SELECT * FROM book_version_access_controls WHERE version_id=?")
        .get(versionId);
      const manifest = version && this.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
        WHERE book_version_id=? AND book_id=?`).get(versionId, bookId);
      requireValue(version && control?.status === "active" && version.status === "available" && manifest &&
        manifest.manifest_hash === version.manifest_hash &&
        manifest.authorization_snapshot_hash === version.authorization_snapshot_hash &&
        manifest.authorized_text_snapshot_hash === version.authorized_text_snapshot_hash &&
        manifest.asset_snapshot_hash === version.asset_snapshot_hash,
      "book_version_unavailable", 404);
      let pages;
      try { pages = parse(manifest.pages_json); } catch { pages = null; }
      requireValue(Array.isArray(pages) && pages.length === version.page_count,
        "book_version_unavailable", 404);
      const pageGrantIds = [...new Set(pages.map((page) => page?.grantId).filter(Boolean))].sort();
      const frozenGrantIds = this.db.prepare(`SELECT grant_id FROM book_version_grants WHERE version_id=?
        ORDER BY grant_id`).all(versionId).map((row) => row.grant_id);
      requireValue(stableJson(pageGrantIds) === stableJson(frozenGrantIds), "book_version_unavailable", 404);
      const pageSources = new Map();
      const sourcePhotoIdsByGrant = new Map();
      for (const page of pages) {
        if (!page?.sourcePhotoId) continue;
        if (pageSources.has(page.sourcePhotoId) &&
          stableJson(pageSources.get(page.sourcePhotoId)) !== stableJson(page.sourceProvenance)) {
          return { sourceRevoked: true, revokedSourcePhotoIds: [page.sourcePhotoId] };
        }
        pageSources.set(page.sourcePhotoId, page.sourceProvenance);
        if (page.grantId) sourcePhotoIdsByGrant.set(page.grantId,
          [...(sourcePhotoIdsByGrant.get(page.grantId) ?? []), page.sourcePhotoId]);
      }
      if (frozenGrantIds.length > 0) {
        const placeholders = frozenGrantIds.map(() => "?").join(",");
        const grants = this.db.prepare(`SELECT g.*,d.grant_id denied,m.personal_memory_id memory_denied,
          sd.grant_id source_denied
          FROM book_contribution_grants g LEFT JOIN book_grant_denials d ON d.grant_id=g.id
          LEFT JOIN memory_denials m ON m.personal_memory_id=g.personal_memory_id
          LEFT JOIN book_source_grant_denials sd ON sd.grant_id=g.id
          WHERE g.id IN (${placeholders}) ORDER BY g.id`).all(...frozenGrantIds);
        requireValue(grants.length === frozenGrantIds.length && grants.every((grant) => grant.book_id === bookId &&
          grant.status === "active" && grant.audience_scope === "current_live_space_viewers" &&
          grant.denied == null && grant.memory_denied == null),
        "book_version_unavailable", 404);
        const sourceDenied = grants.filter((grant) => grant.source_denied != null).map((grant) => grant.id);
        if (sourceDenied.length > 0) return { sourceRevoked: true,
          revokedSourcePhotoIds: [...new Set(sourceDenied.flatMap((grantId) =>
            sourcePhotoIdsByGrant.get(grantId) ?? []))] };
      }
      const frozenSources = this.db.prepare(`SELECT photo_id,provenance_json FROM book_version_source_entries
        WHERE version_id=? ORDER BY photo_id`).all(versionId);
      if (frozenSources.length !== pageSources.size) {
        return { sourceRevoked: true,
          revokedSourcePhotoIds: [...new Set([...pageSources.keys(), ...frozenSources.map((row) => row.photo_id)])] };
      }
      for (const frozen of frozenSources) {
        let provenance;
        try { provenance = parse(frozen.provenance_json); } catch {
          return { sourceRevoked: true, revokedSourcePhotoIds: [frozen.photo_id] };
        }
        if (stableJson(provenance) !== stableJson(pageSources.get(frozen.photo_id))) {
          return { sourceRevoked: true, revokedSourcePhotoIds: [frozen.photo_id] };
        }
      }
      return { version, control, manifest, pages, frozenSources };
  }

  async readableBookVersion(headers, spaceId, bookId, versionId) {
    const viewer = this.liveBookViewer(headers, spaceId);
    const first = transaction(this.db, () => this.bookVersionSnapshot(spaceId, bookId, versionId));
    if (first.sourceRevoked) {
      this.markSourceRevoked(first.revokedSourcePhotoIds);
      fail("book_version_unavailable", 404);
    }
    const requests = first.frozenSources.map((source) => ({ photoId: source.photo_id, needsAsset: false }));
    let capability;
    try {
      capability = await this.readBookPhotoCapability(viewer, requests, {
        actorErrorCode: "book_viewer_changed", resourceErrorCode: "book_source_changed", status: 404
      });
    } catch (error) {
      if (error instanceof BookLabError && error.code === "book_source_changed") {
        this.markSourceRevoked(requests.map((request) => request.photoId));
      }
      fail("book_version_unavailable", 404);
    }
    const snapshot = transaction(this.db, () => {
      const current = this.bookVersionSnapshot(spaceId, bookId, versionId);
      if (current.sourceRevoked) return current;
      requireValue(current.version.manifest_hash === first.version.manifest_hash &&
        current.control.version === first.control.version && current.manifest.pages_json === first.manifest.pages_json &&
        stableJson(current.frozenSources) === stableJson(first.frozenSources), "book_version_unavailable", 404);
      for (const frozen of current.frozenSources) {
        const source = this.liveBookSource(capability, frozen.photo_id);
        let provenance;
        try { provenance = parse(frozen.provenance_json); } catch { provenance = null; }
        if (!source || !provenance || stableJson(source.provenance) !== stableJson(provenance)) {
          return { sourceRevoked: true, revokedSourcePhotoIds: [frozen.photo_id] };
        }
      }
      this.revalidateBookActor(viewer, "book_version_unavailable", 404);
      return current;
    });
    if (snapshot.sourceRevoked) {
      this.markSourceRevoked(snapshot.revokedSourcePhotoIds);
      fail("book_version_unavailable", 404);
    }
    return snapshot;
  }

  availableArtifact(versionId, format) {
    this.artifactLookupCount += 1;
    return this.db.prepare(`SELECT * FROM render_artifacts WHERE version_id=? AND format=?`)
      .get(versionId, format) ?? null;
  }

  bookResponseHeaders(book, owner = null, extra = {}, capability = null) {
    const preconditions = {};
    if (owner?.spaceId === book.space_id && book.draft_status === "preview_ready") {
      const preview = this.db.prepare(`SELECT * FROM book_render_jobs WHERE book_id=? AND draft_version_id=?
        AND book_version_id IS NULL AND status='ready' ORDER BY updated_at DESC,rowid DESC LIMIT 1`)
        .get(book.id, book.draft_id);
      try {
        const artifact = preview && this.db.prepare("SELECT * FROM book_preview_artifacts WHERE render_job_id=?")
          .get(preview.id);
        const input = this.freezePreviewInput(capability, book, preview, artifact,
          this.editableDraftPages(capability, book));
        requireValue(input.manifest.authorizationSnapshotHash === book.grant_set_hash, "preview_stale", 409);
        preconditions.freeze = { draftVersionId: book.draft_id, previewHash: preview.preview_hash,
          grantSetHash: book.grant_set_hash, authorizationSnapshotHash: book.grant_set_hash };
      } catch { /* fail closed: exact freeze validation runs again inside the mutation */ }
    }
    if (owner?.spaceId === book.space_id && book.draft_status === "frozen") {
      const source = this.db.prepare(`SELECT v.id from_version_id,v.status version_status,
        v.manifest_hash,v.authorization_snapshot_hash,v.authorized_text_snapshot_hash,v.asset_snapshot_hash,
        c.version access_control_version,c.status access_control_status,m.pages_json,
        m.manifest_hash stored_manifest_hash,m.authorization_snapshot_hash stored_authorization_snapshot_hash,
        m.authorized_text_snapshot_hash stored_authorized_text_snapshot_hash,
        m.asset_snapshot_hash stored_asset_snapshot_hash
        FROM book_versions v JOIN book_version_access_controls c ON c.version_id=v.id
        JOIN immutable_frozen_book_manifests m ON m.book_version_id=v.id AND m.book_id=v.book_id
        WHERE v.book_id=? AND v.draft_version_id=? AND c.book_id=v.book_id
        ORDER BY v.ordinal DESC LIMIT 1`).get(book.id, book.draft_id);
      let pages = null;
      try { pages = parse(source?.pages_json); } catch { pages = null; }
      if (source && START_NEW_VERSION_SOURCE_STATES.has(source.version_status) &&
        START_NEW_VERSION_ACCESS_STATES.has(source.access_control_status) &&
        Number.isSafeInteger(source.access_control_version) && source.access_control_version >= 1 &&
        Array.isArray(pages) && source.manifest_hash === source.stored_manifest_hash &&
        source.authorization_snapshot_hash === source.stored_authorization_snapshot_hash &&
        source.authorized_text_snapshot_hash === source.stored_authorized_text_snapshot_hash &&
        source.asset_snapshot_hash === source.stored_asset_snapshot_hash) {
        preconditions.startNewVersion = { fromVersionId: source.from_version_id,
        accessControlVersion: source.access_control_version, accessControlStatus: source.access_control_status };
      }
    }
    return { ...BASE_HEADERS, etag: `"${this.ownerBookEtag(book)}"`,
      "x-unseen-book-etag": this.ownerBookEtag(book),
      ...(Object.keys(preconditions).length > 0
        ? { "x-unseen-book-owner-preconditions": stableJson(preconditions) } : {}), ...extra };
  }

  bookEvent(bookId, eventType, actorKind, authorizationId, detail = {}, eventId = randomUUID()) {
    const previous = this.db.prepare(`SELECT id FROM book_events WHERE book_id=?
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(bookId);
    this.db.prepare(`INSERT INTO book_events(id,previous_event_id,book_id,event_type,actor_kind,
      authorization_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(eventId, previous?.id ?? null,
    bookId, eventType, actorKind, authorizationId, json(detail), this.now());
    return eventId;
  }

  latestTitleAuditEvent(bookId) {
    return this.db.prepare(`SELECT * FROM book_events WHERE book_id=?
      AND event_type IN ('BOOK.CREATE','BOOK.EDIT_TITLE') ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(bookId);
  }

  pagesWithoutGrants(pagesJson, grantIds) {
    const denied = new Set(grantIds);
    return json(parse(pagesJson, []).filter((page) => !denied.has(page?.grantId))
      .map((page, index) => ({ ...page, index: index + 1 })));
  }

  scrubDraftHistory(bookId, grantIds) {
    // Success receipts are content-bearing snapshots too. Keep a denial tombstone so
    // the original principal/key/body remains bound after reconstructable pages are purged.
    for (const grantId of grantIds) this.db.prepare(`UPDATE idempotency_receipts
      SET status=409,response_json=?,response_headers_json=?
      WHERE action_id LIKE 'BOOK.%' AND json_extract(response_json,'$.bookId')=?
      AND EXISTS (SELECT 1 FROM json_each(idempotency_receipts.response_json,'$.pages') page
        WHERE json_extract(page.value,'$.grantId')=?)`).run(
      json({ error: { code: "book_source_authorization_changed" } }), json(BASE_HEADERS), bookId, grantId);
    for (const row of this.db.prepare("SELECT id,pages_json FROM book_draft_versions WHERE book_id=?").all(bookId)) {
      const pages = this.pagesWithoutGrants(row.pages_json, grantIds);
      if (pages !== row.pages_json) this.db.prepare(`UPDATE book_draft_versions SET pages_json=?,
        preview_worker_input_hash=NULL WHERE id=?`).run(pages, row.id);
    }
  }

  scrubPreviewContent(bookId, grantIds) {
    const denied = new Set(grantIds);
    for (const row of this.db.prepare("SELECT * FROM book_render_jobs WHERE book_id=?").all(bookId)) {
      let input;
      try { input = parse(row.input_json); } catch { input = null; }
      if (!input?.manifest?.authorizedMemoryTexts?.some((item) => denied.has(item.grantId))) continue;
      this.db.prepare("DELETE FROM book_preview_artifacts WHERE render_job_id=?").run(row.id);
      if (row.book_version_id) {
        this.db.prepare(`UPDATE book_render_jobs SET status='cancelled',version=version+1,input_json='{}',
          preview_hash=NULL,page_count=NULL,html_artifact_id=NULL,html_hash=NULL,pdf_hash=NULL,
          last_stable_error='book_version_unavailable',lease_expires_at=NULL,updated_at=? WHERE id=?`)
          .run(this.now(), row.id);
        continue;
      }
      const replacement = sha256("withdrawn-preview-content");
      this.db.prepare(`UPDATE book_render_jobs SET status='cancelled',version=version+1,input_json='{}',
        input_hash=?,manifest_hash=?,source_snapshot_hash=?,authorized_text_snapshot_hash=?,asset_snapshot_hash=?,
        preview_hash=NULL,page_count=NULL,html_artifact_id=NULL,html_hash=NULL,pdf_hash=NULL,
        last_stable_error='render_input_changed',lease_expires_at=NULL,updated_at=? WHERE id=?`).run(replacement,
      replacement, replacement, replacement, replacement, this.now(), row.id);
    }
  }

  invalidateDraft(bookId, reason, withdrawnGrantIds = []) {
    const before = this.currentBook(bookId);
    requireValue(before && before.draft_status !== "freeze_checking", "version_conflict", 409);
    if (before.draft_status === "frozen") return before;
    const stale = ["preview_queued", "preview_ready", "preview_failed"].includes(before.draft_status);
    const status = stale ? "stale" : before.draft_status;
    const staleReason = stale ? reason : before.stale_reason;
    this.db.prepare(`UPDATE book_render_jobs SET status='cancelled',version=version+1,
      last_stable_error='render_input_changed',lease_expires_at=NULL,updated_at=?
      WHERE book_id=? AND status IN ('queued','rendering_html')`)
      .run(this.now(), bookId);
    const now = this.now();
    const nextDraftId = randomUUID();
    this.db.prepare(`INSERT INTO book_draft_versions(id,book_id,parent_version_id,title,status,version,pages_json,
      grant_set_hash,stale_reason,preview_worker_input_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)`).run(nextDraftId, bookId, before.draft_id, before.draft_title,
    status, before.draft_version + 1, this.pagesWithoutGrants(before.pages_json, withdrawnGrantIds),
    this.grantSetHash(bookId), staleReason, now, now);
    this.db.prepare("UPDATE memory_books SET current_draft_version_id=?,updated_at=? WHERE id=?")
      .run(nextDraftId, now, bookId);
    return this.currentBook(bookId);
  }

  revokeFrozenVersions(versionIds, now = this.now()) {
    for (const versionId of [...new Set(versionIds)]) {
      this.db.prepare(`UPDATE book_versions SET status='withdrawal_affected' WHERE id=?
        AND status IN ('rendering','available','render_failed')`).run(versionId);
      this.db.prepare(`UPDATE book_render_jobs SET status='cancelled',version=version+1,
        last_stable_error='book_version_unavailable',lease_expires_at=NULL,updated_at=?
        WHERE book_version_id=? AND status IN ('queued','rendering_html')`).run(now, versionId);
      this.db.prepare(`UPDATE render_artifacts SET status='revoked',updated_at=? WHERE version_id=?
        AND status!='purged'`).run(now, versionId);
    }
  }

  purgeFrozenVersionContent(versionIds) {
    for (const versionId of [...new Set(versionIds)]) {
      this.db.prepare(`UPDATE render_artifacts SET status='purged',content_blob=NULL,content_hash=NULL,
        page_count=NULL,updated_at=? WHERE version_id=?`).run(this.now(), versionId);
      this.db.prepare(`UPDATE book_render_jobs SET status='cancelled',input_json='{}',
        last_stable_error='book_version_unavailable',lease_expires_at=NULL,updated_at=?
        WHERE book_version_id=? AND input_json!='{}'`).run(this.now(), versionId);
      this.db.prepare("DELETE FROM immutable_authorized_memory_text_snapshots WHERE book_version_id=?")
        .run(versionId);
      this.db.prepare("DELETE FROM immutable_frozen_book_assets WHERE book_version_id=?").run(versionId);
    }
  }

  ownerBookPhoto(capability, photoId, errorCode) {
    const source = capability?.get(photoId)?.source;
    requireValue(source, errorCode, 409);
    return source;
  }

  ownerBookAsset(capability, photoId, kind, errorCode) {
    const record = capability?.get(photoId);
    requireValue(record?.asset, errorCode, 409);
    const { source, asset } = record;
    const localAssetRef = `preview-asset:${photoId}:${asset.contentHash}`;
    return {
      metadata: {
        assetSnapshotId: sha256(`${kind}:${localAssetRef}`).slice(0, 32),
        kind,
        photoId,
        sourcePhotosVersion: source.provenance.sourcePhotosVersion,
        contentHash: asset.contentHash,
        mimeType: asset.mimeType,
        byteLength: asset.byteLength,
        localAssetRef
      },
      bytes: { localAssetRef, bytesBase64: asset.bytesBase64 }
    };
  }

  editableDraftPages(capability, book) {
    requireValue(EDITABLE_DRAFT_STATES.has(book.draft_status) && book.title === book.draft_title &&
      book.grant_set_hash === this.grantSetHash(book.id), "book_not_editable", 409);
    let pages;
    try { pages = parse(book.pages_json); } catch { fail("book_not_editable", 409); }
    requireValue(Array.isArray(pages) && pages.length <= 16, "book_not_editable", 409);
    const grants = this.db.prepare(`SELECT g.*,p.photo_id memory_photo_id,
      p.confirmed_submission_id current_submission_id,p.confirmed_submission_hash current_submission_hash,
      p.memory_revision_id current_memory_revision_id,i.status memory_status,i.provenance_json
      FROM book_contribution_grants g JOIN personal_memories p ON p.id=g.personal_memory_id
      JOIN memory_interviews i ON i.personal_memory_id=p.id WHERE g.book_id=? AND g.status='active'
      ORDER BY g.id`).all(book.id);
    const grantsById = new Map();
    for (const grant of grants) {
      if (this.db.prepare("SELECT 1 FROM book_source_grant_denials WHERE grant_id=?").get(grant.id)) continue;
      let provenance;
      try { provenance = parse(grant.provenance_json); } catch { fail("book_not_editable", 409); }
      const source = this.ownerBookPhoto(capability, grant.memory_photo_id, "book_not_editable");
      requireValue(!this.db.prepare("SELECT 1 FROM book_grant_denials WHERE grant_id=?").get(grant.id) &&
        grant.audience_scope === "current_live_space_viewers" &&
        grant.notice_version === this.currentBookNotice.version && grant.notice_hash === this.currentBookNotice.hash &&
        grant.memory_status === "confirmed" && grant.memory_revision_id === grant.current_memory_revision_id &&
        grant.confirmed_submission_hash === grant.current_submission_hash && grant.current_submission_id &&
        stableJson(provenance) === stableJson(source.provenance) &&
        grant.contributor_id === provenance.authorId, "book_not_editable", 409);
      grantsById.set(grant.id, grant);
    }
    const pageIds = new Set();
    for (const [pageIndex, page] of pages.entries()) {
      requireValue(page && typeof page === "object" && !Array.isArray(page) &&
        Object.keys(page).length === BOOK_PAGE_FIELDS.length &&
        BOOK_PAGE_FIELDS.every((field) => Object.hasOwn(page, field)) &&
        typeof page.pageId === "string" && page.pageId.length >= 1 && page.pageId.length <= 200 &&
        !pageIds.has(page.pageId) && Number.isSafeInteger(page.index) && page.index === pageIndex + 1 &&
        BOOK_PAGE_KINDS.has(page.kind), "book_not_editable", 409);
      pageIds.add(page.pageId);
      if (page.sourcePhotoId == null) {
        requireValue(page.sourceProvenance == null, "book_not_editable", 409);
      } else {
        requireValue(typeof page.sourcePhotoId === "string" && page.sourceProvenance?.photoId === page.sourcePhotoId,
          "book_not_editable", 409);
        const source = this.ownerBookPhoto(capability, page.sourcePhotoId, "book_not_editable");
        requireValue(stableJson(source.provenance) === stableJson(page.sourceProvenance),
          "book_not_editable", 409);
      }
      requireValue(page.displayPhotoId == null || typeof page.displayPhotoId === "string",
        "book_not_editable", 409);
      requireValue(page.kind !== "cover" || page.sourcePhotoId == null,
        "book_not_editable", 409);
      requireValue(page.kind !== "closing" || page.sourcePhotoId == null && page.displayPhotoId == null,
        "book_not_editable", 409);
      if (page.displayPhotoId != null) this.ownerBookPhoto(capability, page.displayPhotoId, "book_not_editable");
      const grantFields = [page.personalMemoryId, page.memoryRevisionId, page.confirmedSubmissionId,
        page.confirmedSubmissionHash, page.grantId, page.authorizedMemoryTextId];
      if (grantFields.every((value) => value == null)) {
        requireValue(["cover", "closing"].includes(page.kind), "book_not_editable", 409);
        continue;
      }
      requireValue(grantFields.every((value) => typeof value === "string" && value.length >= 1) &&
        SHA256.test(page.confirmedSubmissionHash) && ["memory", "multi_view"].includes(page.kind) &&
        typeof page.displayPhotoId === "string", "book_not_editable", 409);
      const grant = grantsById.get(page.grantId);
      requireValue(grant && grant.personal_memory_id === page.personalMemoryId &&
        grant.memory_revision_id === page.memoryRevisionId &&
        grant.confirmed_submission_hash === page.confirmedSubmissionHash &&
        grant.current_submission_id === page.confirmedSubmissionId &&
        grant.memory_photo_id === page.sourcePhotoId, "book_not_editable", 409);
    }
    return pages;
  }

  previewInput(capability, book, pages, layoutProfile) {
    requireValue(this.previewLayouts.has(layoutProfile), "preview_input_changed", 409);
    requireValue(pages.length >= 12 && pages.length <= 16, "page_count_out_of_range", 409);
    const grantIds = [...new Set(pages.map((page) => page.grantId).filter(Boolean))].sort();
    requireValue(grantIds.length > 0, "insufficient_eligible_content", 409);
    const textInputs = new Map();
    for (const grantId of grantIds) {
      const row = this.db.prepare(`SELECT g.*,p.photo_id,p.confirmed_submission_id,p.confirmed_submission_hash current_hash,
        p.memory_revision_id current_revision,i.status memory_status,i.provenance_json,a.user_text,a.submission_hash
        FROM book_contribution_grants g JOIN personal_memories p ON p.id=g.personal_memory_id
        JOIN memory_interviews i ON i.personal_memory_id=p.id
        JOIN answer_submissions a ON a.id=p.confirmed_submission_id AND a.personal_memory_id=p.id
        WHERE g.id=? AND g.book_id=?`).get(grantId, book.id);
      requireValue(row && row.status === "active" && row.memory_status === "confirmed" &&
        row.memory_revision_id === row.current_revision && row.confirmed_submission_hash === row.current_hash &&
        row.confirmed_submission_hash === row.submission_hash && row.audience_scope === "current_live_space_viewers" &&
        !this.db.prepare("SELECT 1 FROM book_grant_denials WHERE grant_id=?").get(grantId),
      "preview_input_changed", 409);
      requireValue(Array.from(row.user_text).length <= 900, "preview_input_changed", 409);
      const initial = this.db.prepare(`SELECT rowid,created_at,provenance_json FROM memory_question_jobs
        WHERE personal_memory_id=? AND kind='initial_question' AND status='ready'
        ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(row.personal_memory_id);
      const followup = initial && this.db.prepare(`SELECT provenance_json FROM memory_question_jobs
        WHERE personal_memory_id=? AND kind='followup_question' AND status='ready'
        AND (created_at>? OR (created_at=? AND rowid>?)) ORDER BY created_at DESC,rowid DESC LIMIT 1`)
        .get(row.personal_memory_id, initial.created_at, initial.created_at, initial.rowid);
      const questions = [initial, followup].filter(Boolean).map((item) => parse(item.provenance_json));
      requireValue(questions.length >= 1 && questions.length <= 2 && questions.every(Boolean),
        "provenance_missing", 409);
      textInputs.set(grantId, {
        bookId: book.id, personalMemoryId: row.personal_memory_id, memoryRevisionId: row.memory_revision_id,
        confirmedSubmissionId: row.confirmed_submission_id, confirmedSubmissionHash: row.confirmed_submission_hash,
        originalUserText: row.user_text, authorCredit: row.credit_label, questionProvenance: questions, grantId,
        audienceScope: row.audience_scope, sourceProvenance: parse(row.provenance_json)
      });
    }
    const assetsByPhoto = new Map();
    for (const page of pages) {
      for (const [kind, photoId] of [["source_photo", page.sourcePhotoId], ["display_photo", page.displayPhotoId]]) {
        if (!photoId) continue;
        const existing = assetsByPhoto.get(photoId);
        if (!existing || kind === "source_photo") {
          assetsByPhoto.set(photoId, this.ownerBookAsset(capability, photoId, kind, "preview_input_changed"));
        }
      }
    }
    const coverPhotoId = pages.find((page) => page.kind === "cover")?.displayPhotoId ?? null;
    const orderedAssets = [...assetsByPhoto.values()].sort((left, right) => {
      if (left.metadata.photoId === coverPhotoId) return -1;
      if (right.metadata.photoId === coverPhotoId) return 1;
      return left.metadata.photoId.localeCompare(right.metadata.photoId);
    });
    const frozenAssets = orderedAssets.map((item) => item.metadata);
    const assetBytes = orderedAssets.map((item) => item.bytes);
    requireValue(frozenAssets.reduce((sum, asset) => sum + asset.byteLength, 0) <= MAX_RENDER_ASSET_TOTAL_BYTES,
      "preview_input_changed", 409);
    const sourceSnapshotHash = sha256(stableJson(pages.map((page) => page.sourceProvenance)));
    const accessControlSnapshot = this.accessControlSnapshot(book.id);
    const accessControlVersion = accessControlSnapshot.reduce((maximum, row) => Math.max(maximum, row.version), 0);
    const titleEvent = this.latestTitleAuditEvent(book.id);
    let titleDetail;
    try { titleDetail = titleEvent && parse(titleEvent.detail_json); } catch { titleDetail = null; }
    requireValue(titleEvent && titleDetail?.title === book.draft_title &&
      titleDetail.titleHash === sha256(book.draft_title), "preview_input_changed", 409);
    const titleAuditSnapshot = { title: book.draft_title, titleHash: titleDetail.titleHash,
      titleEventId: titleEvent.id, capturedAt: titleEvent.created_at };
    const snapshotAt = this.now();
    const authorizedMemoryTexts = [];
    const textIdentity = new Map();
    for (const page of pages) {
      if (!page.grantId) continue;
      const base = textInputs.get(page.grantId);
      requireValue(base && typeof page.authorizedMemoryTextId === "string" && page.authorizedMemoryTextId.length >= 1,
        "preview_input_changed", 409);
      const identity = stableJson(base);
      requireValue(!textIdentity.has(page.authorizedMemoryTextId) ||
        textIdentity.get(page.authorizedMemoryTextId) === identity, "preview_input_changed", 409);
      if (textIdentity.has(page.authorizedMemoryTextId)) continue;
      textIdentity.set(page.authorizedMemoryTextId, identity);
      const value = { authorizedMemoryTextId: page.authorizedMemoryTextId, ...base,
        versionId: book.draft_id, frozenAt: snapshotAt };
      authorizedMemoryTexts.push({ ...value, snapshotHash: sha256(stableJson(value)) });
    }
    const authorizedMemoryTextSnapshotHash = sha256(stableJson(authorizedMemoryTexts));
    const assetSnapshotHash = sha256(stableJson(frozenAssets));
    const manifest = {
      ...(layoutProfile === "book-lab-v1" ? { templateVersion: layoutProfile } : {}),
      bookId: book.id,
      versionId: book.draft_id,
      title: book.draft_title,
      authorizationSnapshotHash: book.grant_set_hash,
      authorizedMemoryTextSnapshotHash,
      assetSnapshotHash,
      pages: structuredClone(pages),
      authorizedMemoryTexts,
      frozenAssets,
      frozenAt: snapshotAt
    };
    const manifestHash = sha256(stableJson(manifest));
    const guard = {
      spaceId: book.space_id, draftVersionId: book.draft_id, draftVersion: book.draft_version + 1,
      layoutProfile, grantSetHash: book.grant_set_hash, sourceSnapshotHash, accessControlVersion,
      titleAuditSnapshot
    };
    return {
      manifest: { ...manifest, manifestHash },
      assetBytes,
      accessControlSnapshot,
      guard,
      inputHash: sha256(stableJson({ manifestHash, assetBytes, accessControlSnapshot, guard }))
    };
  }

  previewInputStillCurrent(input, capability) {
    const book = this.currentBook(input.manifest.bookId);
    if (!book || book.draft_id !== input.guard.draftVersionId ||
      book.draft_status !== "preview_queued" || book.draft_version !== input.guard.draftVersion ||
      book.preview_worker_input_hash !== input.inputHash || book.draft_title !== input.manifest.title ||
      book.grant_set_hash !== input.guard.grantSetHash ||
      stableJson(parse(book.pages_json, [])) !== stableJson(input.manifest.pages) ||
      stableJson(this.accessControlSnapshot(book.id)) !== stableJson(input.accessControlSnapshot)) return false;
    const titleEvent = this.latestTitleAuditEvent(book.id);
    let titleDetail;
    try { titleDetail = titleEvent && parse(titleEvent.detail_json); } catch { return false; }
    if (!titleEvent || titleDetail.title !== input.manifest.title ||
      titleDetail.titleHash !== sha256(input.manifest.title)) return false;
    try {
      const sources = new Map();
      for (const page of input.manifest.pages) {
        if (page.sourcePhotoId && !sources.has(page.sourcePhotoId)) {
          sources.set(page.sourcePhotoId,
            this.ownerBookPhoto(capability, page.sourcePhotoId, "preview_input_changed"));
        }
      }
      if (!input.manifest.pages.every((page) => !page.sourcePhotoId ||
        stableJson(sources.get(page.sourcePhotoId).provenance) === stableJson(page.sourceProvenance))) return false;
      const bytesByRef = new Map(input.assetBytes.map((asset) => [asset.localAssetRef, asset]));
      if (bytesByRef.size !== input.assetBytes.length) return false;
      for (const frozen of input.manifest.frozenAssets) {
        const current = this.ownerBookAsset(capability, frozen.photoId, frozen.kind, "preview_input_changed");
        if (stableJson(current.metadata) !== stableJson(frozen) ||
          stableJson(current.bytes) !== stableJson(bytesByRef.get(frozen.localAssetRef))) return false;
      }
      return bytesByRef.size === input.manifest.frozenAssets.length;
    } catch {
      return false;
    }
  }

  freezePreviewInput(capability, book, row, artifact, pages) {
    let input;
    try { input = parse(row.input_json); } catch { fail("preview_stale", 409); }
    const { manifestHash, ...manifestSemantic } = input?.manifest ?? {};
    requireValue(row.status === "ready" && artifact && row.draft_version_id === book.draft_id &&
      row.input_hash === input?.inputHash && row.manifest_hash === manifestHash &&
      manifestHash === sha256(stableJson(manifestSemantic)) && artifact.input_hash === row.input_hash &&
      artifact.html_hash === row.html_hash && sha256(artifact.html_blob) === artifact.html_hash &&
      artifact.page_count === row.page_count && row.page_count === pages.length &&
      row.grant_set_hash === input.guard.grantSetHash &&
      row.source_snapshot_hash === input.guard.sourceSnapshotHash &&
      row.access_control_version === input.guard.accessControlVersion &&
      input.manifest.authorizationSnapshotHash === book.grant_set_hash &&
      row.preview_hash === sha256(stableJson({ inputHash: row.input_hash, htmlHash: row.html_hash,
        pageCount: row.page_count, htmlArtifactId: row.html_artifact_id })) &&
      book.draft_status === "preview_ready" && book.preview_worker_input_hash === row.input_hash &&
      book.draft_version === input.guard.draftVersion + 1 && book.draft_title === input.manifest.title &&
      book.title === book.draft_title && book.grant_set_hash === input.guard.grantSetHash &&
      stableJson(pages) === stableJson(input.manifest.pages) &&
      stableJson(this.accessControlSnapshot(book.id)) === stableJson(input.accessControlSnapshot) &&
      sha256(stableJson(input.manifest.authorizedMemoryTexts)) === row.authorized_text_snapshot_hash &&
      sha256(stableJson(input.manifest.frozenAssets)) === row.asset_snapshot_hash,
    "preview_stale", 409);
    const pendingWithdrawal = this.db.prepare(`SELECT 1 FROM book_contribution_grants g
      LEFT JOIN book_grant_denials d ON d.grant_id=g.id WHERE g.book_id=?
      AND (g.status='withdrawal_pending' OR (g.status='active' AND d.grant_id IS NOT NULL)) LIMIT 1`).get(book.id);
    requireValue(!pendingWithdrawal, "withdrawal_in_progress", 409);
    for (const snapshot of input.manifest.authorizedMemoryTexts) {
      const current = this.db.prepare(`SELECT g.*,p.confirmed_submission_id,p.confirmed_submission_hash current_hash,
        p.memory_revision_id current_revision,i.status memory_status,a.user_text,a.submission_hash
        FROM book_contribution_grants g JOIN personal_memories p ON p.id=g.personal_memory_id
        JOIN memory_interviews i ON i.personal_memory_id=p.id
        JOIN answer_submissions a ON a.id=p.confirmed_submission_id AND a.personal_memory_id=p.id
        WHERE g.id=? AND g.book_id=?`).get(snapshot.grantId, book.id);
      requireValue(current && current.status === "active" && current.memory_status === "confirmed" &&
        !this.db.prepare("SELECT 1 FROM memory_denials WHERE personal_memory_id=?")
          .get(snapshot.personalMemoryId) && current.personal_memory_id === snapshot.personalMemoryId &&
        current.memory_revision_id === snapshot.memoryRevisionId &&
        current.current_revision === snapshot.memoryRevisionId &&
        current.confirmed_submission_id === snapshot.confirmedSubmissionId &&
        current.confirmed_submission_hash === snapshot.confirmedSubmissionHash &&
        current.current_hash === snapshot.confirmedSubmissionHash &&
        current.submission_hash === snapshot.confirmedSubmissionHash && current.user_text === snapshot.originalUserText &&
        current.credit_label === snapshot.authorCredit && current.audience_scope === snapshot.audienceScope,
      "preview_stale", 409);
    }
    const currentAssets = new Map();
    for (const frozen of input.manifest.frozenAssets) {
      const current = this.ownerBookAsset(capability, frozen.photoId, frozen.kind, "preview_stale");
      currentAssets.set(frozen.localAssetRef, current.bytes);
      requireValue(stableJson(current.metadata) === stableJson(frozen), "preview_stale", 409);
    }
    requireValue(input.assetBytes.length === currentAssets.size && input.assetBytes.every((asset) =>
      stableJson(asset) === stableJson(currentAssets.get(asset.localAssetRef))), "preview_stale", 409);
    for (const page of pages) {
      if (!page.sourcePhotoId) continue;
      const source = this.ownerBookPhoto(capability, page.sourcePhotoId, "preview_stale");
      requireValue(stableJson(source.provenance) === stableJson(page.sourceProvenance), "preview_stale", 409);
    }
    return input;
  }

  frozenInputFromPreview(book, previewInput, versionId, frozenAt, accessControlVersion) {
    const textIds = new Map(previewInput.manifest.authorizedMemoryTexts.map((snapshot) =>
      [snapshot.authorizedMemoryTextId, `text-${sha256(`${versionId}:${snapshot.authorizedMemoryTextId}`).slice(0, 32)}`]));
    const authorizedMemoryTexts = previewInput.manifest.authorizedMemoryTexts.map((snapshot) => {
      const { snapshotHash: _snapshotHash, ...semantic } = snapshot;
      const value = { ...semantic, authorizedMemoryTextId: textIds.get(snapshot.authorizedMemoryTextId),
        versionId, frozenAt };
      return { ...value, snapshotHash: sha256(stableJson(value)) };
    });
    const previewBytes = new Map(previewInput.assetBytes.map((asset) => [asset.localAssetRef, asset.bytesBase64]));
    const frozenAssets = previewInput.manifest.frozenAssets.map((asset) => {
      const localAssetRef = `frozen-asset:${versionId}:${asset.photoId}:${asset.contentHash}`;
      return { ...asset, assetSnapshotId: sha256(`${versionId}:${asset.kind}:${asset.photoId}:${asset.contentHash}`)
        .slice(0, 32), localAssetRef };
    });
    const assetBytes = frozenAssets.map((asset, index) => ({ localAssetRef: asset.localAssetRef,
      bytesBase64: previewBytes.get(previewInput.manifest.frozenAssets[index].localAssetRef) }));
    const authorizedMemoryTextSnapshotHash = sha256(stableJson(authorizedMemoryTexts));
    const assetSnapshotHash = sha256(stableJson(frozenAssets));
    const manifestSemantic = {
      ...(previewInput.manifest.templateVersion ? { templateVersion: previewInput.manifest.templateVersion } : {}),
      bookId: book.id,
      versionId,
      title: book.draft_title,
      authorizationSnapshotHash: book.grant_set_hash,
      authorizedMemoryTextSnapshotHash,
      assetSnapshotHash,
      pages: previewInput.manifest.pages.map((page) => ({ ...structuredClone(page),
        authorizedMemoryTextId: page.authorizedMemoryTextId == null
          ? null : textIds.get(page.authorizedMemoryTextId) })),
      authorizedMemoryTexts,
      frozenAssets,
      frozenAt
    };
    const manifestHash = sha256(stableJson(manifestSemantic));
    const guard = {
      spaceId: book.space_id,
      bookVersionId: versionId,
      accessControlVersion,
      sourceSnapshotHash: sha256(stableJson(manifestSemantic.pages.map((page) => page.sourceProvenance))),
      templateVersion: previewInput.guard.layoutProfile,
      rendererBuildHash: sha256(previewInput.guard.layoutProfile === "book-lab-v1" ? "book-renderer-v1" : "book-renderer-v0")
    };
    return { manifest: { ...manifestSemantic, manifestHash }, assetBytes, guard,
      inputHash: sha256(stableJson({ manifestHash, assetBytes, guard })) };
  }

  frozenInputStillCurrent(row, input, capability) {
    try {
      if (!capability) return { current: false, revokedSourcePhotoIds: [] };
      const version = this.db.prepare("SELECT * FROM book_versions WHERE id=?").get(row.book_version_id);
      const control = this.db.prepare("SELECT * FROM book_version_access_controls WHERE version_id=?")
        .get(row.book_version_id);
      const storedManifest = this.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
        WHERE book_version_id=?`).get(row.book_version_id);
      if (!version || version.status !== "rendering" || !control || control.status !== "active" ||
        control.version !== input.guard.accessControlVersion || !storedManifest ||
        storedManifest.book_id !== input.manifest.bookId || storedManifest.title !== input.manifest.title ||
        storedManifest.manifest_hash !== input.manifest.manifestHash ||
        storedManifest.authorization_snapshot_hash !== input.manifest.authorizationSnapshotHash ||
        storedManifest.authorized_text_snapshot_hash !== input.manifest.authorizedMemoryTextSnapshotHash ||
        storedManifest.asset_snapshot_hash !== input.manifest.assetSnapshotHash ||
        storedManifest.pages_json !== json(input.manifest.pages) ||
        storedManifest.frozen_at !== input.manifest.frozenAt || storedManifest.manifest_hash !== row.manifest_hash ||
        row.input_hash !== input.inputHash || row.book_version_id !== input.guard.bookVersionId ||
        sha256(stableJson({ manifestHash: input.manifest.manifestHash, assetBytes: input.assetBytes,
          guard: input.guard })) !== input.inputHash) return { current: false, revokedSourcePhotoIds: [] };
      const texts = this.db.prepare(`SELECT snapshot_json FROM immutable_authorized_memory_text_snapshots
        WHERE book_version_id=? ORDER BY rowid`).all(row.book_version_id).map((item) => parse(item.snapshot_json));
      const assets = this.db.prepare(`SELECT metadata_json,bytes_blob FROM immutable_frozen_book_assets
        WHERE book_version_id=? ORDER BY rowid`).all(row.book_version_id);
      if (stableJson(texts) !== stableJson(input.manifest.authorizedMemoryTexts) ||
        stableJson(assets.map((item) => parse(item.metadata_json))) !== stableJson(input.manifest.frozenAssets) ||
        stableJson(assets.map((item, index) => ({ localAssetRef: input.manifest.frozenAssets[index].localAssetRef,
          bytesBase64: Buffer.from(item.bytes_blob).toString("base64") }))) !== stableJson(input.assetBytes)) {
        return { current: false, revokedSourcePhotoIds: [] };
      }
      const sources = this.db.prepare(`SELECT photo_id,provenance_json FROM book_version_source_entries
        WHERE version_id=? ORDER BY photo_id`).all(row.book_version_id);
      const revokedSourcePhotoIds = [];
      for (const stored of sources) {
        const current = this.liveBookSource(capability, stored.photo_id);
        let provenance;
        try { provenance = parse(stored.provenance_json); } catch { provenance = null; }
        if (!current || !provenance || stableJson(current.provenance) !== stableJson(provenance)) {
          revokedSourcePhotoIds.push(stored.photo_id);
        }
      }
      if (revokedSourcePhotoIds.length > 0) return { current: false, revokedSourcePhotoIds };
      for (const frozen of input.manifest.frozenAssets) {
        const current = this.ownerBookAsset(capability, frozen.photoId, frozen.kind, "book_version_unavailable");
        const storedBytes = input.assetBytes.find((asset) => asset.localAssetRef === frozen.localAssetRef);
        if (stableJson(current.metadata) !== stableJson({ ...frozen,
          assetSnapshotId: current.metadata.assetSnapshotId, localAssetRef: current.metadata.localAssetRef }) ||
          !storedBytes || current.bytes.bytesBase64 !== storedBytes.bytesBase64) {
          return { current: false, revokedSourcePhotoIds: [] };
        }
      }
      return { current: true, revokedSourcePhotoIds: [] };
    } catch {
      return { current: false, revokedSourcePhotoIds: [] };
    }
  }

  discardFrozenRender(row, attempt) {
    const now = this.now();
    const changed = this.db.prepare(`UPDATE book_render_jobs SET status='cancelled',version=version+1,attempt=?,
      last_stable_error='book_version_unavailable',lease_expires_at=NULL,updated_at=? WHERE id=? AND version=?
      AND status IN ('queued','rendering_html')`).run(attempt, now, row.id, row.version);
    requireValue(changed.changes === 1, "render_input_changed", 409);
    this.db.prepare(`UPDATE book_version_access_controls SET status='affected',version=version+1,updated_at=?
      WHERE version_id=? AND status='active'`).run(now, row.book_version_id);
    this.revokeFrozenVersions([row.book_version_id], now);
    this.purgeFrozenVersionContent([row.book_version_id]);
    this.bookEvent(row.book_id, "SOURCE_REVOKED", "render_worker", "book-lab-render-worker",
      { versionId: row.book_version_id, renderJobId: row.id });
    return this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id);
  }

  discardStalePreview(row, attempt) {
    const now = this.now();
    const job = this.db.prepare(`UPDATE book_render_jobs SET status='cancelled',version=version+1,attempt=?,
      last_stable_error='render_input_changed',lease_expires_at=NULL,updated_at=?
      WHERE id=? AND version=? AND status IN ('queued','rendering_html')`).run(attempt, now, row.id, row.version);
    requireValue(job.changes === 1, "render_input_changed", 409);
    const draft = this.db.prepare(`UPDATE book_draft_versions SET status='stale',version=version+1,
      stale_reason='input_changed',preview_worker_input_hash=NULL,updated_at=? WHERE id=?
      AND status='preview_queued' AND preview_worker_input_hash=?`).run(now, row.draft_version_id, row.input_hash);
    requireValue(draft.changes === 1, "render_input_changed", 409);
    return this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id);
  }

  currentOwnerEditableDraft(ctx, owner, spaceId, bookId, capability) {
    this.revalidateOwner(owner);
    const book = this.currentBook(bookId);
    requireValue(book?.space_id === spaceId, "authorization_changed", 409);
    requireValue(sameSecret(unquoteEtag(ctx.headers["if-match"]), this.ownerBookEtag(book)),
      "version_conflict", 409);
    return { book, pages: this.editableDraftPages(capability, book) };
  }

  draftPhotoRequests(bookId, extraPhotoIds = [], needsAsset = false) {
    const book = this.currentBook(bookId);
    let pages;
    try { pages = parse(book?.pages_json, []); } catch { pages = []; }
    const grantedPhotoIds = this.db.prepare(`SELECT p.photo_id FROM book_contribution_grants g
      JOIN personal_memories p ON p.id=g.personal_memory_id WHERE g.book_id=? AND g.status='active'`)
      .all(bookId).map((row) => row.photo_id);
    return [...pages.flatMap((page) => [page?.sourcePhotoId, page?.displayPhotoId]), ...grantedPhotoIds, ...extraPhotoIds]
      .filter(Boolean).map((photoId) => ({ photoId, needsAsset }));
  }

  async ownerDraftCapability(owner, bookId, extraPhotoIds, needsAsset, resourceErrorCode) {
    return this.readBookPhotoCapability(owner, this.draftPhotoRequests(bookId, extraPhotoIds, needsAsset), {
      actorErrorCode: "authorization_changed", resourceErrorCode, status: 409
    });
  }

  async workerInputCapability(input) {
    let owner = null;
    try { owner = await this.core.readOwnerSnapshot?.(input.guard.spaceId); } catch { owner = null; }
    requireValue(owner, "book_actor_changed", 409);
    const requests = (input.manifest?.frozenAssets ?? []).map((asset) =>
      ({ photoId: asset.photoId, needsAsset: true }));
    return this.readBookPhotoCapability(owner, requests, {
      actorErrorCode: "book_actor_changed", resourceErrorCode: "book_source_changed",
      assetErrorCode: "book_asset_changed", status: 409
    });
  }

  async startNewVersionCapability(owner, bookId, versionId) {
    const manifest = this.db.prepare(`SELECT m.pages_json FROM immutable_frozen_book_manifests m
      JOIN book_versions v ON v.id=m.book_version_id WHERE m.book_version_id=? AND m.book_id=?`)
      .get(versionId, bookId);
    let pages;
    try { pages = parse(manifest?.pages_json, []); } catch { pages = []; }
    const requests = pages.flatMap((page) => [page?.sourcePhotoId, page?.displayPhotoId]).filter(Boolean)
      .map((photoId) => ({ photoId, needsAsset: false }));
    try {
      return { capability: await this.readBookPhotoCapability(owner, requests, {
        actorErrorCode: "authorization_changed", resourceErrorCode: "book_source_changed", status: 409
      }), revokedSourcePhotoIds: [] };
    } catch (error) {
      if (!(error instanceof BookLabError) || error.code !== "book_source_changed") throw error;
      return { capability: null, revokedSourcePhotoIds: [...new Set(pages.map((page) => page?.sourcePhotoId)
        .filter(Boolean))] };
    }
  }

  appendEditedDraft(book, pages, { title = book.draft_title, advanceBookVersion = false } = {}) {
    const now = this.now();
    this.db.prepare(`UPDATE book_render_jobs SET status='cancelled',version=version+1,
      last_stable_error='render_input_changed',lease_expires_at=NULL,updated_at=?
      WHERE book_id=? AND status IN ('queued','rendering_html')`)
      .run(now, book.id);
    const draftId = randomUUID();
    this.db.prepare(`INSERT INTO book_draft_versions(id,book_id,parent_version_id,title,status,version,pages_json,
      grant_set_hash,stale_reason,preview_worker_input_hash,created_at,updated_at)
      VALUES(?,?,?,?, 'editing',?,?,?,NULL,NULL,?,?)`).run(draftId, book.id, book.draft_id, title,
    book.draft_version + 1, json(pages), book.grant_set_hash, now, now);
    const updated = advanceBookVersion
      ? this.db.prepare(`UPDATE memory_books SET title=?,version=version+1,current_draft_version_id=?,updated_at=?
        WHERE id=? AND version=? AND current_draft_version_id=?`).run(title, draftId, now, book.id,
      book.version, book.draft_id)
      : this.db.prepare(`UPDATE memory_books SET current_draft_version_id=?,updated_at=?
        WHERE id=? AND version=? AND current_draft_version_id=?`).run(draftId, now, book.id,
      book.version, book.draft_id);
    requireValue(updated.changes === 1, "version_conflict", 409);
    return this.currentBook(book.id);
  }

  precondition(interview) {
    return interview ? { branch: "present", ifNoneMatch: null, ifMatch: this.interviewEtag(interview), version: interview.version }
      : { branch: "absent", ifNoneMatch: "*", ifMatch: null, version: null };
  }

  responseForMemory(principal, memoryId) {
    const row = this.ownedMemory(principal, memoryId);
    const job = this.latestQuestionJob(memoryId);
    const options = this.bookOptions(parse(row.provenance_json).spaceId);
    return {
      status: 200,
      headers: { ...headersFor(this.memoryEtag(row),
        this.interviewEtag({ personal_memory_id: row.id, version: row.interview_version }), this.followupEtag(row, job)),
      ...this.contributionHeaders(principal, row, options) },
      body: { memory: this.memoryDto(row), submissions: this.submissions(memoryId), grantReceipts: this.grantReceipts(memoryId) }
    };
  }

  event(principal, memoryId, eventType, aggregateVersion, detail = {}) {
    this.systemEvent(memoryId, eventType, aggregateVersion, principal.kind, principal.authorizationId, detail);
  }

  systemEvent(memoryId, eventType, aggregateVersion, actorKind, authorizationId, detail = {}) {
    const previous = this.db.prepare(`SELECT id FROM memory_events WHERE personal_memory_id=?
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(memoryId);
    this.db.prepare(`INSERT INTO memory_events(id,previous_event_id,personal_memory_id,event_type,actor_kind,
      authorization_id,aggregate_version,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), previous?.id ?? null, memoryId, eventType, actorKind, authorizationId,
        aggregateVersion, json(detail), this.now());
  }

  privateFactBinding(jobId, memoryId, queuedInput) {
    return {
      jobId,
      personalMemoryId: memoryId,
      kind: queuedInput.kind,
      inputHash: sha256(stableJson(queuedInput)),
      photoId: queuedInput.source.photoId,
      photoContentHash: queuedInput.source.provenance.photoContentHash,
      placementRevisionId: queuedInput.source.provenance.placementRevisionId,
      placementSnapshotHash: queuedInput.source.provenance.placementSnapshotHash,
      model: queuedInput.providerModel,
      modelVersion: queuedInput.modelVersion,
      promptHash: queuedInput.promptHash,
      policyHash: queuedInput.policyHash
    };
  }

  privateFactEvent(row, fromStatus, toStatus, detail = {}) {
    const previous = this.db.prepare(`SELECT id FROM memory_model_fact_events WHERE fact_draft_id=?
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(row.id);
    this.db.prepare(`INSERT INTO memory_model_fact_events(id,previous_event_id,fact_draft_id,personal_memory_id,
      question_job_id,from_status,to_status,aggregate_version,job_version,attempt,binding_hash,detail_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), previous?.id ?? null, row.id, row.personal_memory_id,
    row.question_job_id, fromStatus, toStatus, row.version, row.job_version, row.attempt, row.binding_hash,
    json(detail), this.now());
  }

  createPrivateFactDraft(job, queuedInput, now) {
    const binding = this.privateFactBinding(job.id, job.personal_memory_id, queuedInput);
    requireValue(binding.inputHash === job.input_hash, "question_input_changed", 409);
    const factDraftId = randomUUID();
    const bindingHash = sha256(stableJson(binding));
    this.db.prepare(`INSERT INTO memory_model_fact_drafts(id,personal_memory_id,question_job_id,status,version,
      job_version,attempt,input_hash,binding_hash,photo_id,photo_content_hash,placement_revision_id,
      placement_snapshot_hash,model,model_version,prompt_hash,policy_hash,created_at,updated_at)
      VALUES(?,?,?,'pending',1,?,0,?,?,?,?,?,?,?,?,?,?,?,?)`).run(factDraftId, job.personal_memory_id, job.id,
    job.version, job.input_hash, bindingHash, binding.photoId, binding.photoContentHash,
    binding.placementRevisionId, binding.placementSnapshotHash, binding.model, binding.modelVersion,
    binding.promptHash, binding.policyHash, now, now);
    const row = this.db.prepare("SELECT * FROM memory_model_fact_drafts WHERE id=?").get(factDraftId);
    this.privateFactEvent(row, null, "pending", { event: "FACT_DRAFT_CREATED", inputHash: job.input_hash });
    return row;
  }

  assertPrivateFactBinding(row, job, queuedInput) {
    requireValue(row && PRIVATE_FACT_STATES.has(row.status) && row.personal_memory_id === job.personal_memory_id &&
      row.question_job_id === job.id && row.input_hash === job.input_hash, "question_input_changed", 409);
    const binding = this.privateFactBinding(job.id, job.personal_memory_id, queuedInput);
    requireValue(binding.inputHash === job.input_hash && row.binding_hash === sha256(stableJson(binding)) &&
      row.photo_id === binding.photoId && row.photo_content_hash === binding.photoContentHash &&
      row.placement_revision_id === binding.placementRevisionId &&
      row.placement_snapshot_hash === binding.placementSnapshotHash && row.model === binding.model &&
      row.model_version === binding.modelVersion && row.prompt_hash === binding.promptHash &&
      row.policy_hash === binding.policyHash, "question_input_changed", 409);
    return row;
  }

  transitionPrivateFact(row, toStatus, changes = {}, detail = {}) {
    const transitions = {
      pending: new Set(["pending", "draft_ready", "withdrawn"]),
      draft_ready: new Set(["question_ready", "withdrawn"]),
      question_ready: new Set(["answered", "withdrawn"]),
      answered: new Set(["answered", "confirmed", "withdrawn"]),
      confirmed: new Set(["withdrawn"]),
      withdrawn: new Set()
    };
    requireValue(transitions[row.status]?.has(toStatus), "question_input_changed", 409);
    const allowed = new Set(["job_version", "attempt", "model_visible_facts_json", "facts_hash", "question_hash",
      "provider_result_hash", "provider_latency_ms", "lease_expires_at", "retry_after_at", "last_stable_error"]);
    requireValue(Object.keys(changes).every((key) => allowed.has(key)), "internal_error", 500);
    const entries = Object.entries(changes);
    const set = entries.map(([key]) => `${key}=?`).join(",");
    const updated = this.db.prepare(`UPDATE memory_model_fact_drafts SET status=?,version=version+1,
      ${set ? `${set},` : ""}updated_at=? WHERE id=? AND status=? AND version=?`).run(toStatus,
    ...entries.map(([, value]) => value), this.now(), row.id, row.status, row.version);
    requireValue(updated.changes === 1, "question_input_changed", 409);
    const current = this.db.prepare("SELECT * FROM memory_model_fact_drafts WHERE id=?").get(row.id);
    this.privateFactEvent(current, row.status, toStatus, detail);
    return current;
  }

  leasePrivateFact(job, queuedInput, attempt, leaseExpiresAt) {
    const row = this.assertPrivateFactBinding(this.db.prepare(
      "SELECT * FROM memory_model_fact_drafts WHERE question_job_id=?").get(job.id), job, queuedInput);
    requireValue(row.status === "pending" && row.job_version === job.version - 1 && row.attempt === attempt - 1,
      "question_input_changed", 409);
    return this.transitionPrivateFact(row, "pending", { job_version: job.version, attempt,
      lease_expires_at: leaseExpiresAt, retry_after_at: null, last_stable_error: null },
    { event: "FACT_DRAFT_LEASED" });
  }

  assertInterviewIfMatch(header, interview) {
    requireValue(sameSecret(unquoteEtag(header), this.interviewEtag(interview)), "version_conflict", 409);
  }

  assertMemoryIfMatch(header, memory) {
    requireValue(sameSecret(unquoteEtag(header), this.memoryEtag(memory)), "version_conflict", 409);
  }

  assertFollowupIfMatch(header, memory, job) {
    requireValue(job && sameSecret(unquoteEtag(header), this.followupEtag(memory, job)), "version_conflict", 409);
  }

  readableMutationReceipt(prior) {
    const body = parse(prior.response_json);
    if (prior.action_id.startsWith("BOOK.") && Array.isArray(body?.pages)) {
      for (const page of body.pages) {
        if (!page?.grantId) continue;
        const grant = this.db.prepare(`SELECT g.* FROM book_contribution_grants g
          WHERE g.id=? AND g.book_id=? AND g.status='active'
          AND NOT EXISTS (SELECT 1 FROM book_grant_denials d WHERE d.grant_id=g.id)
          AND NOT EXISTS (SELECT 1 FROM memory_denials d WHERE d.personal_memory_id=g.personal_memory_id)`)
          .get(page.grantId, body.bookId);
        requireValue(grant, "book_source_authorization_changed", 409);
      }
    }
    return { status: prior.status, headers: parse(prior.response_headers_json), body };
  }

  mutation(ctx, { actionId, endpoint, targetMemoryId = null }, run) {
    const key = ctx.headers["idempotency-key"];
    requireValue(typeof key === "string" && key.length >= 8 && key.length <= 200, "idempotency_key_required");
    const keyHash = sha256(key);
    const requestHash = sha256(stableJson({ path: ctx.path, body: ctx.body, ifMatch: ctx.headers["if-match"] ?? null,
      ifNoneMatch: ctx.headers["if-none-match"] ?? null }));
    const scope = `${ctx.principal.kind}:${ctx.principal.authorizationId}`;
    return transaction(this.db, () => {
      const prior = this.db.prepare(`SELECT * FROM idempotency_receipts WHERE principal_scope=? AND method=?
        AND canonical_endpoint=? AND key_hash=?`).get(scope, ctx.method, endpoint, keyHash);
      if (prior) {
        requireValue(prior.action_id === actionId && prior.request_hash === requestHash,
          "idempotency_key_reused", 409);
        return this.readableMutationReceipt(prior);
      }
      const result = run();
      const { targetMemoryId: resultMemoryId, ...publicResult } = result;
      this.db.prepare(`INSERT INTO idempotency_receipts(principal_scope,method,canonical_endpoint,key_hash,
        request_hash,action_id,target_memory_id,status,response_json,response_headers_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(scope, ctx.method, endpoint, keyHash, requestHash, actionId,
        targetMemoryId ?? resultMemoryId ?? null, publicResult.status, json(publicResult.body), json(publicResult.headers), this.now());
      return publicResult;
    });
  }

  replayMutation(ctx, { actionId, endpoint }) {
    const key = ctx.headers["idempotency-key"];
    requireValue(typeof key === "string" && key.length >= 8 && key.length <= 200, "idempotency_key_required");
    const keyHash = sha256(key);
    const requestHash = sha256(stableJson({ path: ctx.path, body: ctx.body, ifMatch: ctx.headers["if-match"] ?? null,
      ifNoneMatch: ctx.headers["if-none-match"] ?? null }));
    const scope = `${ctx.principal.kind}:${ctx.principal.authorizationId}`;
    const prior = this.db.prepare(`SELECT * FROM idempotency_receipts WHERE principal_scope=? AND method=?
      AND canonical_endpoint=? AND key_hash=?`).get(scope, ctx.method, endpoint, keyHash);
    if (!prior) return null;
    requireValue(prior.action_id === actionId && prior.request_hash === requestHash,
      "idempotency_key_reused", 409);
    return this.readableMutationReceipt(prior);
  }

  async preparedMutation(ctx, meta, prepare, run) {
    const replay = this.replayMutation(ctx, meta);
    if (replay) return replay;
    const prepared = await prepare();
    return this.mutation(ctx, meta, () => run(prepared));
  }

  assertPhotoReady(photo) {
    requireValue(photo.completed === true && photo.deleted !== true && photo.withdrawn !== true && photo.l3Enabled === true,
      "photo_not_ready", 409);
  }

  validatePrivateProviderOutcome(kind, supplied) {
    requireValue(QUESTION_INTENT[kind] === PHOTO_QUESTION_INTENT, "question_policy_rejected", 409);
    return privateProviderOutcome(supplied, this.providerModel, this.modelVersion);
  }

  assertQuestionProviderConfigured() {
    requireValue(this.questionProviderConfigured && typeof this.questionProvider === "function",
      "model_unavailable", 503);
  }

  openWorkspace(ctx, photoId) {
    const photo = this.ownedPhoto(ctx.principal, photoId);
    const interview = this.interviewByPhoto(photoId);
    if (interview && interview.contributor_id !== ctx.principal.contributorId) fail("memory_unavailable", 404);
    const denied = interview && this.db.prepare("SELECT 1 FROM memory_denials WHERE personal_memory_id=?").get(interview.personal_memory_id);
    const memory = interview && !denied ? this.ownedMemory(ctx.principal, interview.personal_memory_id) : null;
    const persistedOptions = this.bookOptions(photo.provenance.spaceId);
    const eligibleBooks = persistedOptions.length > 0 ? persistedOptions
      : this.core.listEligibleBooks(ctx.principal, photo.provenance.spaceId);
    const body = {
      photoId,
      provenance: photo.provenance,
      eligibility: denied || photo.withdrawn ? "withdrawn" :
        !photo.l3Enabled || !this.questionProviderConfigured ? "disabled" :
          photo.completed && !photo.deleted ? "eligible" : "not_ready",
      collectionNotice: this.currentNotice,
      memory: memory ? this.memoryDto(memory) : null,
      eligibleBooks: denied ? [] : eligibleBooks,
      recoverableQuestionJobs: memory ? this.recoverableJobs(memory.id) : [],
      interviewPrecondition: this.precondition(interview)
    };
    const latest = memory ? this.latestQuestionJob(memory.id) : null;
    return { status: 200, headers: { ...headersFor(memory ? this.memoryEtag(memory) : null,
      interview ? this.interviewEtag(interview) : null, memory ? this.followupEtag(memory, latest) : null),
    ...this.contributionHeaders(ctx.principal, memory, eligibleBooks),
    "x-unseen-question-provider": this.questionProviderConfigured ? "configured" : "unavailable" }, body };
  }

  startQuestion(ctx, photoId) {
    this.assertQuestionProviderConfigured();
    const endpoint = "/v2-labs/memories/photos/{photoId}/question-jobs";
    const photo = this.ownedPhoto(ctx.principal, photoId);
    this.assertPhotoReady(photo);
    const source = frozenPhotoSource(photo);
    requireValue(source.contributorId === ctx.principal.contributorId, "memory_unavailable", 404);
    const body = exactObject(ctx.body, ["noticeVersion", "noticeHash", "photoContentHash", "placementSnapshotHash"]);
    text(body.noticeVersion, 1, 200);
    hash(body.noticeHash);
    hash(body.photoContentHash);
    hash(body.placementSnapshotHash);
    requireValue(body.noticeVersion === this.currentNotice.version && body.noticeHash === this.currentNotice.hash,
      "notice_changed", 409);
    requireValue(body.photoContentHash === source.provenance.photoContentHash &&
      body.placementSnapshotHash === source.provenance.placementSnapshotHash, "photo_not_ready", 409);
    const before = this.interviewByPhoto(photoId);
    if (before) {
      requireValue(before.contributor_id === ctx.principal.contributorId, "memory_unavailable", 404);
      requireValue(!this.db.prepare("SELECT 1 FROM memory_denials WHERE personal_memory_id=?").get(before.personal_memory_id),
        "memory_unavailable", 404);
    }
    return this.mutation(ctx, { actionId: "MEMORY.START_QUESTION", endpoint,
      targetMemoryId: before?.personal_memory_id }, () => {
      let interview = this.interviewByPhoto(photoId);
      let memoryId;
      const now = this.now();
      if (!interview) {
        requireValue(ctx.headers["if-none-match"] === "*" && ctx.headers["if-match"] == null, "version_conflict", 409);
        memoryId = randomUUID();
        this.db.prepare(`INSERT INTO memory_interviews(personal_memory_id,photo_id,contributor_id,status,version,
          provenance_json,created_at,updated_at) VALUES(?,?,?,'question_queued',1,?,?,?)`)
          .run(memoryId, photoId, ctx.principal.contributorId, json(source.provenance), now, now);
        this.db.prepare(`INSERT INTO personal_memories(id,photo_id,contributor_id,version,created_at,updated_at)
          VALUES(?,?,?,1,?,?)`).run(memoryId, photoId, ctx.principal.contributorId, now, now);
        interview = this.interviewByPhoto(photoId);
      } else {
        requireValue(ctx.headers["if-none-match"] == null, "version_conflict", 409);
        this.assertInterviewIfMatch(ctx.headers["if-match"], interview);
        requireValue(["question_failed", "skipped"].includes(interview.status), "question_already_started", 409);
        memoryId = interview.personal_memory_id;
        this.db.prepare(`UPDATE memory_interviews SET status='question_queued',version=version+1,
          provenance_json=?,updated_at=? WHERE personal_memory_id=?`).run(json(source.provenance), now, memoryId);
        interview = this.interviewByPhoto(photoId);
      }
      const jobId = randomUUID();
      const queuedInput = { kind: "initial_question", source, noticeVersion: this.currentNotice.version,
        noticeHash: this.currentNotice.hash, providerModel: this.providerModel,
        modelVersion: this.modelVersion, promptHash: this.promptHash,
        policyHash: this.policyHash };
      const inputHash = sha256(stableJson(queuedInput));
      this.db.prepare(`INSERT INTO memory_question_jobs(id,personal_memory_id,kind,status,version,attempt,
        source_memory_version,input_hash,provenance_json,created_at,updated_at)
        VALUES(?,?,'initial_question','queued',1,0,1,?,?,?,?)`).run(jobId, memoryId, inputHash,
      json({ queuedInput }), now, now);
      this.createPrivateFactDraft(this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(jobId),
        queuedInput, now);
      const memory = this.ownedMemory(ctx.principal, memoryId);
      this.event(ctx.principal, memoryId, "MEMORY.START_QUESTION", interview.version, { jobId, inputHash });
      const job = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(jobId);
      return { status: 200, targetMemoryId: memoryId,
        headers: headersFor(this.memoryEtag(memory), this.interviewEtag(interview), this.followupEtag(memory, job)),
        body: this.questionJobDto(job) };
    });
  }

  skip(ctx, photoId) {
    const endpoint = "/v2-labs/memories/photos/{photoId}/skip";
    const photo = this.ownedPhoto(ctx.principal, photoId);
    this.assertPhotoReady(photo);
    exactObject(ctx.body, [], ["reason"]);
    if (ctx.body.reason !== undefined) text(ctx.body.reason, 0, 500);
    const before = this.interviewByPhoto(photoId);
    if (before) {
      requireValue(before.contributor_id === ctx.principal.contributorId, "memory_unavailable", 404);
      requireValue(!this.db.prepare("SELECT 1 FROM memory_denials WHERE personal_memory_id=?").get(before.personal_memory_id),
        "memory_unavailable", 404);
    }
    return this.mutation(ctx, { actionId: "MEMORY.SKIP", endpoint, targetMemoryId: before?.personal_memory_id }, () => {
      let interview = this.interviewByPhoto(photoId);
      let memoryId;
      const now = this.now();
      if (!interview) {
        requireValue(ctx.headers["if-none-match"] === "*" && ctx.headers["if-match"] == null, "version_conflict", 409);
        memoryId = randomUUID();
        this.db.prepare(`INSERT INTO memory_interviews(personal_memory_id,photo_id,contributor_id,status,version,
          provenance_json,created_at,updated_at) VALUES(?,?,?,'skipped',1,?,?,?)`)
          .run(memoryId, photoId, ctx.principal.contributorId, json(photo.provenance), now, now);
        this.db.prepare(`INSERT INTO personal_memories(id,photo_id,contributor_id,version,created_at,updated_at)
          VALUES(?,?,?,1,?,?)`).run(memoryId, photoId, ctx.principal.contributorId, now, now);
      } else {
        requireValue(ctx.headers["if-none-match"] == null, "version_conflict", 409);
        this.assertInterviewIfMatch(ctx.headers["if-match"], interview);
        requireValue(interview.status !== "confirmed", "memory_already_confirmed", 409);
        requireValue(["eligible", "question_queued", "question_ready", "question_failed"].includes(interview.status),
          "version_conflict", 409);
        memoryId = interview.personal_memory_id;
        const factDrafts = this.db.prepare(`SELECT * FROM memory_model_fact_drafts WHERE personal_memory_id=?
          AND status!='withdrawn' ORDER BY created_at,rowid`).all(memoryId);
        for (const factDraft of factDrafts) {
          this.transitionPrivateFact(factDraft, "withdrawn", { model_visible_facts_json: null, facts_hash: null,
            question_hash: null, provider_result_hash: null, lease_expires_at: null, retry_after_at: null,
            last_stable_error: null },
          { event: "FACT_SKIPPED" });
        }
        this.db.prepare(`UPDATE memory_question_jobs SET status='cancelled',version=version+1,
          last_stable_error=NULL,lease_expires_at=NULL,updated_at=? WHERE personal_memory_id=?
          AND status IN ('queued','running')`).run(now, memoryId);
        this.db.prepare(`UPDATE memory_interviews SET status='skipped',version=version+1,updated_at=?
          WHERE personal_memory_id=?`).run(now, memoryId);
      }
      interview = this.interviewByPhoto(photoId);
      const memory = this.ownedMemory(ctx.principal, memoryId);
      this.event(ctx.principal, memoryId, "MEMORY.SKIP", interview.version);
      return { status: 200, targetMemoryId: memoryId,
        headers: headersFor(this.memoryEtag(memory), this.interviewEtag(interview), this.followupEtag(memory)),
        body: { memory: this.memoryDto(memory), submissions: [], grantReceipts: [] } };
    });
  }

  detail(ctx, memoryId) {
    const row = this.ownedMemory(ctx.principal, memoryId);
    const job = this.latestQuestionJob(memoryId);
    const options = this.bookOptions(parse(row.provenance_json).spaceId);
    return { status: 200, headers: { ...headersFor(this.memoryEtag(row),
      this.interviewEtag({ personal_memory_id: row.id, version: row.interview_version }), this.followupEtag(row, job)),
    ...this.contributionHeaders(ctx.principal, row, options) },
    body: {
      memory: this.memoryDto(row),
      submissions: this.submissions(memoryId),
      grantReceipts: this.grantReceipts(memoryId),
      recoverableQuestionJobs: this.recoverableJobs(memoryId),
      followupLimit: this.followupLimit,
      interviewPrecondition: this.precondition({ personal_memory_id: row.id, version: row.interview_version })
    } };
  }

  saveAnswer(ctx, memoryId) {
    const endpoint = "/v2-labs/memories/{memoryId}/answer-submissions";
    this.ownedMemory(ctx.principal, memoryId);
    const body = exactObject(ctx.body,
      ["clientSubmissionId", "userText", "previousSubmissionId", "interviewIfMatchVersion"]);
    id(body.clientSubmissionId);
    requireValue(typeof body.userText === "string" && body.userText.length >= 1, "validation_failed");
    requireValue(body.userText.length <= 10_000, "answer_too_long", 413);
    requireValue(body.previousSubmissionId === null || typeof body.previousSubmissionId === "string", "validation_failed");
    if (body.previousSubmissionId !== null) id(body.previousSubmissionId);
    positiveInteger(body.interviewIfMatchVersion);
    return this.mutation(ctx, { actionId: "MEMORY.SAVE_ANSWER_DRAFT", endpoint, targetMemoryId: memoryId }, () => {
      const memory = this.ownedMemory(ctx.principal, memoryId);
      this.assertMemoryIfMatch(ctx.headers["if-match"], memory);
      requireValue(body.interviewIfMatchVersion === memory.interview_version, "version_conflict", 409);
      requireValue(["question_ready", "draft", "followup_ready"].includes(memory.interview_status),
        "memory_not_editable", 409);
      requireValue(body.previousSubmissionId === memory.head_submission_id, "version_conflict", 409);
      requireValue(!this.db.prepare("SELECT 1 FROM answer_submissions WHERE id=?").get(body.clientSubmissionId),
        "version_conflict", 409);
      const factDraft = this.db.prepare(`SELECT f.* FROM memory_model_fact_drafts f
        JOIN memory_question_jobs j ON j.id=f.question_job_id WHERE f.personal_memory_id=? AND j.status='ready'
        ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1`).get(memoryId);
      requireValue(factDraft && ["question_ready", "answered"].includes(factDraft.status),
        "memory_not_editable", 409);
      const now = this.now();
      const submissionHash = sha256(body.userText);
      const revisionId = randomUUID();
      this.db.prepare(`INSERT INTO answer_submissions(id,personal_memory_id,revision_id,previous_submission_id,
        user_text,submission_hash,submitted_at) VALUES(?,?,?,?,?,?,?)`).run(body.clientSubmissionId, memoryId,
      revisionId, body.previousSubmissionId, body.userText, submissionHash, now);
      this.db.prepare(`INSERT INTO memory_model_fact_answer_links(fact_draft_id,submission_id,created_at)
        VALUES(?,?,?)`).run(factDraft.id, body.clientSubmissionId, now);
      this.transitionPrivateFact(factDraft, "answered", {}, { event: "FACT_ANSWERED" });
      this.db.prepare(`UPDATE personal_memories SET head_submission_id=?,version=version+1,updated_at=? WHERE id=?`)
        .run(body.clientSubmissionId, now, memoryId);
      this.db.prepare(`UPDATE memory_interviews SET status='draft',version=version+1,updated_at=? WHERE personal_memory_id=?`)
        .run(now, memoryId);
      const current = this.ownedMemory(ctx.principal, memoryId);
      this.event(ctx.principal, memoryId, "MEMORY.SAVE_ANSWER_DRAFT", current.version,
        { submissionId: body.clientSubmissionId, revisionId });
      const job = this.latestQuestionJob(memoryId);
      return { status: 200, headers: headersFor(this.memoryEtag(current),
        this.interviewEtag({ personal_memory_id: memoryId, version: current.interview_version }),
        this.followupEtag(current, job)),
      body: { memory: this.memoryDto(current), submissions: this.submissions(memoryId),
        grantReceipts: this.grantReceipts(memoryId) } };
    });
  }

  requestFollowup(ctx, memoryId) {
    this.assertQuestionProviderConfigured();
    const endpoint = "/v2-labs/memories/{memoryId}/followup-jobs";
    this.ownedMemory(ctx.principal, memoryId);
    const body = exactObject(ctx.body,
      ["submissionId", "submissionHash", "photoContentHash", "interviewIfMatchVersion"]);
    id(body.submissionId);
    hash(body.submissionHash);
    hash(body.photoContentHash);
    positiveInteger(body.interviewIfMatchVersion);
    return this.mutation(ctx, { actionId: "MEMORY.REQUEST_FOLLOWUP", endpoint, targetMemoryId: memoryId }, () => {
      const memory = this.ownedMemory(ctx.principal, memoryId);
      const terminalJob = this.latestQuestionJob(memoryId);
      this.assertFollowupIfMatch(ctx.headers["if-match"], memory, terminalJob);
      requireValue(JOB_TERMINAL.has(terminalJob.status), "version_conflict", 409);
      requireValue(body.interviewIfMatchVersion === memory.interview_version, "version_conflict", 409);
      requireValue(["draft", "followup_queued", "followup_ready"].includes(memory.interview_status),
        "version_conflict", 409);
      const submission = this.db.prepare("SELECT * FROM answer_submissions WHERE id=? AND personal_memory_id=?")
        .get(body.submissionId, memoryId);
      requireValue(submission, "answer_required", 409);
      requireValue(submission.submission_hash === body.submissionHash, "answer_required", 409);
      const latestReadyJob = this.db.prepare(`SELECT id FROM memory_question_jobs WHERE personal_memory_id=?
        AND status='ready' ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(memoryId);
      const answeredFact = this.db.prepare(`SELECT f.question_job_id,f.status FROM memory_model_fact_drafts f
        JOIN memory_model_fact_answer_links l ON l.fact_draft_id=f.id
        WHERE l.submission_id=? AND f.personal_memory_id=?`).get(submission.id, memoryId);
      requireValue(latestReadyJob && answeredFact?.question_job_id === latestReadyJob.id &&
        answeredFact.status === "answered", "answer_required", 409);
      const provenance = parse(memory.provenance_json);
      const photo = this.ownedPhoto(ctx.principal, memory.photo_id);
      this.assertPhotoReady(photo);
      const source = frozenPhotoSource(photo);
      requireValue(source.contributorId === memory.contributor_id &&
        stableJson(source.provenance) === stableJson(provenance) &&
        body.photoContentHash === source.provenance.photoContentHash, "question_input_changed", 409);
      const ordinal = this.db.prepare(`SELECT COALESCE(MAX(followup_ordinal),0) ordinal FROM memory_question_jobs
        WHERE personal_memory_id=? AND kind='followup_question' AND status='ready'`).get(memoryId).ordinal + 1;
      requireValue(ordinal <= this.followupLimit, "followup_limit_reached", 409);
      const now = this.now();
      if (terminalJob.status === "failed") {
        const failedFact = this.db.prepare("SELECT * FROM memory_model_fact_drafts WHERE question_job_id=?")
          .get(terminalJob.id);
        if (failedFact?.status === "pending") this.transitionPrivateFact(failedFact, "withdrawn", {
          model_visible_facts_json: null, facts_hash: null, question_hash: null, provider_result_hash: null,
          lease_expires_at: null, retry_after_at: null, last_stable_error: null
        }, { event: "FACT_RETRY_SUPERSEDED" });
      }
      const nextMemoryVersion = memory.version + 1;
      const jobId = randomUUID();
      const queuedInput = { kind: "followup_question", memoryId, source,
        sourceMemoryVersion: nextMemoryVersion, sourceSubmissionId: submission.id,
        sourceSubmissionHash: submission.submission_hash, providerModel: this.providerModel,
        modelVersion: this.modelVersion,
        promptHash: this.promptHash, policyHash: this.policyHash };
      const inputHash = sha256(stableJson(queuedInput));
      this.db.prepare("UPDATE personal_memories SET version=version+1,updated_at=? WHERE id=?").run(now, memoryId);
      this.db.prepare(`UPDATE memory_interviews SET status='followup_queued',version=version+1,updated_at=?
        WHERE personal_memory_id=?`).run(now, memoryId);
      this.db.prepare(`INSERT INTO memory_question_jobs(id,personal_memory_id,kind,status,version,attempt,
        followup_ordinal,source_submission_id,source_submission_hash,source_memory_version,input_hash,
        provenance_json,created_at,updated_at)
        VALUES(?,?,'followup_question','queued',1,0,?,?,?,?,?,?,?,?)`).run(jobId, memoryId, ordinal,
      submission.id, submission.submission_hash, nextMemoryVersion, inputHash, json({ queuedInput }), now, now);
      this.createPrivateFactDraft(this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(jobId),
        queuedInput, now);
      const current = this.ownedMemory(ctx.principal, memoryId);
      const job = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(jobId);
      this.event(ctx.principal, memoryId, "MEMORY.REQUEST_FOLLOWUP", current.version,
        { jobId, sourceSubmissionId: submission.id, inputHash });
      return { status: 200, headers: headersFor(this.memoryEtag(current),
        this.interviewEtag({ personal_memory_id: memoryId, version: current.interview_version }),
        this.followupEtag(current, job)), body: this.questionJobDto(job) };
    });
  }

  async completedBookVersions(headers, spaceId, bookId) {
    const result = [];
    const rows = this.db.prepare(`SELECT id FROM book_versions WHERE book_id=? AND status='available'
      ORDER BY ordinal DESC`).all(bookId);
    for (const row of rows) {
      let snapshot;
      try { snapshot = await this.readableBookVersion(headers, spaceId, bookId, row.id); }
      catch (error) { if (error instanceof BookLabError && error.code === "book_version_unavailable") continue; throw error; }
      const version = snapshot.version;
      const suffix = `${encodeURIComponent(spaceId)}/books/${encodeURIComponent(bookId)}/versions/${encodeURIComponent(version.id)}`;
      result.push({ versionId: version.id, ordinal: version.ordinal, status: version.status,
        pageCount: version.page_count, frozenAt: version.frozen_at,
        readerPath: `/s/${suffix}`, metadataPath: `/v2-labs/live/spaces/${suffix}` });
    }
    return result;
  }

  async openBookLab(ctx, spaceId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const books = [];
    for (const row of this.db.prepare("SELECT id FROM memory_books WHERE space_id=? ORDER BY created_at,rowid").all(spaceId)) {
      const completedVersions = await this.completedBookVersions(ctx.headers, spaceId, row.id);
      this.revalidateOwner(owner);
      const book = this.currentBook(row.id);
      books.push({ ...this.draftDto(book), bookVersion: book.version, completedVersions,
        precondition: { ifMatch: this.ownerBookEtag(book), version: book.version,
          draftVersion: book.draft_version } });
    }
    this.revalidateOwner(owner);
    return { status: 200, headers: BASE_HEADERS, body: { spaceId: owner.spaceId, books } };
  }

  createBook(ctx, spaceId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const body = exactObject(ctx.body, ["bookId", "title", "eventId"]);
    id(body.bookId);
    text(body.title, 1, 120);
    id(body.eventId);
    requireValue(ctx.headers["if-none-match"] === "*" && ctx.headers["if-match"] == null,
      "version_conflict", 409);
    const endpoint = "/v2-labs/owner/spaces/{spaceId}/books";
    return this.mutation({ ...ctx, principal: owner }, { actionId: "BOOK.CREATE", endpoint }, () => {
      this.revalidateOwner(owner);
      requireValue(this.core.readEventForOwner?.(owner, body.eventId), "event_unavailable", 404);
      requireValue(!this.db.prepare("SELECT 1 FROM memory_books WHERE id=?").get(body.bookId), "book_id_conflict", 409);
      const now = this.now();
      const draftId = randomUUID();
      this.db.prepare(`INSERT INTO memory_books(id,space_id,event_id,title,version,current_draft_version_id,
        created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)`).run(body.bookId, spaceId, body.eventId, body.title,
      draftId, now, now);
      this.db.prepare(`INSERT INTO book_draft_versions(id,book_id,parent_version_id,title,status,version,pages_json,
        grant_set_hash,stale_reason,created_at,updated_at) VALUES(?,?,NULL,?,'editing',1,'[]',?,NULL,?,?)`)
        .run(draftId, body.bookId, body.title, sha256(stableJson([])), now, now);
      const current = this.currentBook(body.bookId);
      this.bookEvent(body.bookId, "BOOK.CREATE", owner.kind, owner.authorizationId,
        { title: body.title, titleHash: sha256(body.title), eventId: body.eventId });
      return { status: 200, headers: this.bookResponseHeaders(current), body: this.draftDto(current) };
    });
  }

  async openBookDraft(ctx, spaceId, bookId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const book = this.currentBook(bookId);
    requireValue(book?.space_id === spaceId, "authorization_changed", 409);
    let capability = null;
    if (book.draft_status === "preview_ready") {
      try { capability = await this.ownerDraftCapability(owner, bookId, [], true, "preview_stale"); }
      catch (error) { if (!(error instanceof BookLabError) || error.code !== "preview_stale") throw error; }
    }
    const current = this.currentBook(bookId);
    requireValue(current?.draft_id === book.draft_id && current.draft_version === book.draft_version &&
      current.version === book.version, "version_conflict", 409);
    const completedVersions = await this.completedBookVersions(ctx.headers, spaceId, bookId);
    const afterRead = this.currentBook(bookId);
    requireValue(afterRead?.draft_id === current.draft_id && afterRead.draft_version === current.draft_version &&
      afterRead.version === current.version, "version_conflict", 409);
    const headers = this.bookResponseHeaders(current, owner, {}, capability);
    this.revalidateOwner(owner);
    return { status: 200, headers, body: { ...this.draftDto(current), completedVersions } };
  }

  assemblySources(capability, book) {
    this.editableDraftPages(capability, book);
    return this.db.prepare(`SELECT g.*,p.photo_id,p.confirmed_submission_id,p.memory_revision_id,
      p.confirmed_submission_hash,s.user_text,i.provenance_json FROM book_contribution_grants g
      JOIN personal_memories p ON p.id=g.personal_memory_id
      JOIN memory_interviews i ON i.personal_memory_id=p.id
      JOIN answer_submissions s ON s.id=p.confirmed_submission_id
      WHERE g.book_id=? AND g.status='active'
      AND NOT EXISTS(SELECT 1 FROM book_source_grant_denials d WHERE d.grant_id=g.id)
      AND NOT EXISTS(SELECT 1 FROM book_grant_denials d WHERE d.grant_id=g.id)
      ORDER BY g.granted_at,g.id`).all(book.id);
  }

  async readAssemblySources(ctx, spaceId, bookId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const capability = await this.ownerDraftCapability(owner, bookId, [], false, "book_not_editable");
    this.revalidateOwner(owner);
    const book = this.currentBook(bookId);
    requireValue(book?.space_id === spaceId, "authorization_changed", 409);
    const sources = this.assemblySources(capability, book);
    return { status: 200, headers: this.bookResponseHeaders(book), body: { bookId,
      minimumSources: 5, maximumSources: 7, sources: sources.map(row => ({ grantId: row.id,
        photoId: row.photo_id, creditLabel: row.credit_label, userText: row.user_text,
        capturedAt: parse(row.provenance_json).capturedAt })) } };
  }

  async assembleBookDraft(ctx, spaceId, bookId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const body = exactObject(ctx.body, ["grantIds"]);
    requireValue(Array.isArray(body.grantIds) && body.grantIds.every(value => typeof value === "string") &&
      new Set(body.grantIds).size === body.grantIds.length, "book_sources_invalid", 409);
    requireValue(body.grantIds.length >= 5, "book_sources_insufficient", 409);
    requireValue(body.grantIds.length <= 7, "book_sources_too_many", 409);
    const endpoint = "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/assembly";
    return this.preparedMutation({ ...ctx, principal: owner }, { actionId: "BOOK.ASSEMBLE", endpoint },
      () => this.ownerDraftCapability(owner, bookId, [], false, "book_not_editable"), capability => {
        const { book } = this.currentOwnerEditableDraft(ctx, owner, spaceId, bookId, capability);
        const available = new Map(this.assemblySources(capability, book).map(row => [row.id, row]));
        const selected = body.grantIds.map(grantId => available.get(grantId));
        requireValue(selected.every(Boolean), "book_source_authorization_changed", 409);
        requireValue(new Set(selected.map(row => row.photo_id)).size === selected.length,
          "book_sources_invalid", 409);
        const empty = () => Object.fromEntries(BOOK_PAGE_FIELDS.map(field => [field, null]));
        const pages = [{ ...empty(), pageId: randomUUID(), index: 1, kind: "cover", displayPhotoId: selected[0].photo_id }];
        for (const row of selected) {
          const authorizedMemoryTextId = randomUUID();
          for (const kind of ["multi_view", "memory"]) pages.push({
          ...empty(), pageId: randomUUID(), index: pages.length + 1, kind,
          sourcePhotoId: row.photo_id, displayPhotoId: row.photo_id, personalMemoryId: row.personal_memory_id,
          memoryRevisionId: row.memory_revision_id, confirmedSubmissionId: row.confirmed_submission_id,
          confirmedSubmissionHash: row.confirmed_submission_hash, grantId: row.id,
          authorizedMemoryTextId, sourceProvenance: parse(row.provenance_json)
        });
        }
        pages.push({ ...empty(), pageId: randomUUID(), index: pages.length + 1, kind: "closing" });
        // Validate the new plan with the same grant, source and page rules used by rendering.
        this.editableDraftPages(capability, { ...book, pages_json: json(pages) });
        const current = this.appendEditedDraft(book, pages);
        this.bookEvent(bookId, "BOOK.ASSEMBLE", owner.kind, owner.authorizationId,
          { sourceGrantIds: body.grantIds, pageCount: pages.length });
        return { status: 200, headers: this.bookResponseHeaders(current), body: this.draftDto(current) };
      });
  }

  async editBookTitle(ctx, spaceId, bookId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const body = ctx.body;
    requireValue(body && typeof body === "object" && !Array.isArray(body) &&
      Object.keys(body).length === 1 && Object.hasOwn(body, "title") &&
      typeof body.title === "string" && body.title.length >= 1 && body.title.length <= 120,
      "title_invalid", 409);
    const endpoint = "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/title";
    const mutationCtx = { ...ctx, principal: owner };
    return this.preparedMutation(mutationCtx, { actionId: "BOOK.EDIT_TITLE", endpoint },
      () => this.ownerDraftCapability(owner, bookId, [], false, "book_not_editable"), (capability) => {
      const { book, pages } = this.currentOwnerEditableDraft(ctx, owner, spaceId, bookId, capability);
      const current = this.appendEditedDraft(book, pages, { title: body.title, advanceBookVersion: true });
      this.bookEvent(bookId, "BOOK.EDIT_TITLE", owner.kind, owner.authorizationId,
        { title: body.title, titleHash: sha256(body.title) });
      return { status: 200, headers: this.bookResponseHeaders(current), body: this.draftDto(current) };
    });
  }

  async removeBookPage(ctx, spaceId, bookId, pageId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    id(pageId);
    const body = ctx.body;
    requireValue(body && typeof body === "object" && !Array.isArray(body) &&
      Object.keys(body).length === 1 && Object.hasOwn(body, "pageVersion") &&
      typeof body.pageVersion === "string" && body.pageVersion.length >= 1 && body.pageVersion.length <= 200,
      "version_conflict", 409);
    const endpoint = "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/pages/{pageId}/removals";
    const mutationCtx = { ...ctx, principal: owner };
    return this.preparedMutation(mutationCtx, { actionId: "BOOK.REMOVE_PAGE", endpoint },
      () => this.ownerDraftCapability(owner, bookId, [], false, "book_not_editable"), (capability) => {
      const { book, pages } = this.currentOwnerEditableDraft(ctx, owner, spaceId, bookId, capability);
      requireValue(body.pageVersion === book.draft_id, "version_conflict", 409);
      const index = pages.findIndex((page) => page.pageId === pageId);
      requireValue(index >= 0, "page_not_found", 404);
      const nextPages = pages.toSpliced(index, 1).map((page, pageIndex) => ({ ...page, index: pageIndex + 1 }));
      requireValue(nextPages.length <= 16, "page_count_out_of_range", 409);
      const current = this.appendEditedDraft(book, nextPages);
      this.bookEvent(bookId, "BOOK.REMOVE_PAGE", owner.kind, owner.authorizationId,
        { pageId, draftVersionId: current.draft_id });
      return { status: 200, headers: this.bookResponseHeaders(current), body: this.draftDto(current) };
    });
  }

  async replaceBookPagePhoto(ctx, spaceId, bookId, pageId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    id(pageId);
    if (Object.hasOwn(ctx.body ?? {}, "sourcePhotoId")) fail("source_photo_immutable", 409);
    const body = ctx.body;
    requireValue(body && typeof body === "object" && !Array.isArray(body) &&
      Object.keys(body).length === 2 && Object.hasOwn(body, "displayPhotoId") &&
      Object.hasOwn(body, "pageVersion"), "version_conflict", 409);
    requireValue(typeof body.displayPhotoId === "string" && body.displayPhotoId.length >= 1 &&
      body.displayPhotoId.length <= 200, "display_photo_not_eligible", 409);
    requireValue(typeof body.pageVersion === "string" && body.pageVersion.length >= 1 &&
      body.pageVersion.length <= 200, "version_conflict", 409);
    const endpoint = "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/pages/{pageId}/photo";
    const mutationCtx = { ...ctx, principal: owner };
    return this.preparedMutation(mutationCtx, { actionId: "BOOK.REPLACE_PAGE_PHOTO", endpoint },
      () => this.ownerDraftCapability(owner, bookId, [body.displayPhotoId], false, "display_photo_not_eligible"),
      (capability) => {
      const { book, pages } = this.currentOwnerEditableDraft(ctx, owner, spaceId, bookId, capability);
      requireValue(body.pageVersion === book.draft_id, "version_conflict", 409);
      const index = pages.findIndex((page) => page.pageId === pageId);
      requireValue(index >= 0, "version_conflict", 409);
      requireValue(pages[index].kind !== "closing", "display_photo_not_eligible", 409);
      this.ownerBookPhoto(capability, body.displayPhotoId, "display_photo_not_eligible");
      const nextPages = pages.with(index, { ...pages[index], displayPhotoId: body.displayPhotoId });
      const current = this.appendEditedDraft(book, nextPages);
      this.bookEvent(bookId, "BOOK.REPLACE_PAGE_PHOTO", owner.kind, owner.authorizationId,
        { pageId, displayPhotoId: body.displayPhotoId, draftVersionId: current.draft_id });
      return { status: 200, headers: this.bookResponseHeaders(current), body: this.draftDto(current) };
    });
  }

  async generateBookPreview(ctx, spaceId, bookId) {
    requireValue(this.renderWorkerSecret, "render_job_unavailable", 404);
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const body = exactObject(ctx.body, ["renderJobId", "draftVersionId", "grantSetHash", "layoutProfile"]);
    id(body.renderJobId);
    id(body.draftVersionId);
    hash(body.grantSetHash);
    requireValue(typeof body.layoutProfile === "string" && this.previewLayouts.has(body.layoutProfile),
      "preview_input_changed", 409);
    requireValue(ctx.headers["if-none-match"] === "*" && typeof ctx.headers["if-match"] === "string",
      "version_conflict", 409);
    const endpoint = "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/render-jobs";
    const mutationCtx = { ...ctx, principal: owner };
    return this.preparedMutation(mutationCtx, { actionId: "BOOK.GENERATE_PREVIEW", endpoint },
      () => this.ownerDraftCapability(owner, bookId, [], true, "preview_input_changed"), (capability) => {
      const { book, pages } = this.currentOwnerEditableDraft(ctx, owner, spaceId, bookId, capability);
      requireValue(body.draftVersionId === book.draft_id && body.grantSetHash === book.grant_set_hash,
        "preview_input_changed", 409);
      requireValue(!this.db.prepare("SELECT 1 FROM book_render_jobs WHERE id=?").get(body.renderJobId),
        "version_conflict", 409);
      const input = this.previewInput(capability, book, pages, body.layoutProfile);
      const now = this.now();
      this.db.prepare(`INSERT INTO book_render_jobs(id,book_id,status,version,input_hash,draft_version_id,
        grant_set_hash,layout_profile,input_json,manifest_hash,source_snapshot_hash,
        authorized_text_snapshot_hash,asset_snapshot_hash,access_control_version,attempt,created_at,updated_at)
        VALUES(?,?,'queued',1,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(body.renderJobId, book.id, input.inputHash,
      book.draft_id, book.grant_set_hash, body.layoutProfile, json(input), input.manifest.manifestHash,
      input.guard.sourceSnapshotHash, input.manifest.authorizedMemoryTextSnapshotHash,
      input.manifest.assetSnapshotHash, input.guard.accessControlVersion, now, now);
      const updated = this.db.prepare(`UPDATE book_draft_versions SET status='preview_queued',version=version+1,
        stale_reason=NULL,preview_worker_input_hash=?,updated_at=? WHERE id=? AND version=?`).run(input.inputHash,
      now, book.draft_id, book.draft_version);
      requireValue(updated.changes === 1, "version_conflict", 409);
      const current = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(body.renderJobId);
      return { status: 200, headers: this.bookResponseHeaders(this.currentBook(book.id)),
        body: this.previewJobDto(current) };
    });
  }

  async freezeBook(ctx, spaceId, bookId) {
    requireValue(this.renderWorkerSecret, "render_job_unavailable", 404);
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const body = exactObject(ctx.body,
      ["draftVersionId", "previewHash", "grantSetHash", "authorizationSnapshotHash"]);
    id(body.draftVersionId);
    for (const field of ["previewHash", "grantSetHash", "authorizationSnapshotHash"]) hash(body[field]);
    requireValue(typeof ctx.headers["if-match"] === "string", "version_conflict", 409);
    const endpoint = "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/versions";
    const mutationCtx = { ...ctx, principal: owner };
    return this.preparedMutation(mutationCtx, { actionId: "BOOK.FREEZE", endpoint },
      () => this.ownerDraftCapability(owner, bookId, [], true, "preview_stale"), (capability) => {
      this.revalidateOwner(owner);
      const book = this.currentBook(bookId);
      requireValue(book?.space_id === spaceId, "authorization_changed", 409);
      requireValue(sameSecret(unquoteEtag(ctx.headers["if-match"]), this.ownerBookEtag(book)) &&
        body.draftVersionId === book.draft_id, "version_conflict", 409);
      requireValue(book.draft_status === "preview_ready", "preview_required", 409);
      requireValue(book.title === book.draft_title && body.grantSetHash === book.grant_set_hash &&
        body.authorizationSnapshotHash === book.grant_set_hash, "version_conflict", 409);
      const preview = this.db.prepare(`SELECT * FROM book_render_jobs WHERE book_id=? AND draft_version_id=?
        AND book_version_id IS NULL AND status='ready' AND preview_hash=? ORDER BY updated_at DESC,rowid DESC LIMIT 1`)
        .get(book.id, book.draft_id, body.previewHash);
      requireValue(preview, "preview_required", 409);
      const previewArtifact = this.db.prepare(`SELECT * FROM book_preview_artifacts WHERE render_job_id=?`)
        .get(preview.id);
      let pages;
      try { pages = this.editableDraftPages(capability, book); } catch (error) {
        if (error instanceof BookLabError && error.code === "book_not_editable") fail("preview_stale", 409);
        throw error;
      }
      requireValue(pages.length >= 12 && pages.length <= 16, "page_count_out_of_range", 409);
      const previewInput = this.freezePreviewInput(capability, book, preview, previewArtifact, pages);
      requireValue(previewInput.manifest.authorizationSnapshotHash === body.authorizationSnapshotHash,
        "version_conflict", 409);
      const versionId = randomUUID();
      const frozenAt = this.now();
      const ordinal = this.db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 ordinal FROM book_versions WHERE book_id=?")
        .get(book.id).ordinal;
      const frozenInput = this.frozenInputFromPreview(book, previewInput, versionId, frozenAt, 1);
      const renderJobId = randomUUID();
      const htmlArtifactId = randomUUID();
      const pdfArtifactId = randomUUID();
      const manifest = frozenInput.manifest;
      this.db.prepare(`INSERT INTO book_versions(id,book_id,ordinal,draft_version_id,status,manifest_hash,
        authorization_snapshot_hash,authorized_text_snapshot_hash,asset_snapshot_hash,page_count,created_at,frozen_at)
        VALUES(?,?,?,?,'rendering',?,?,?,?,?,?,?)`).run(versionId, book.id, ordinal, book.draft_id,
      manifest.manifestHash, manifest.authorizationSnapshotHash, manifest.authorizedMemoryTextSnapshotHash,
      manifest.assetSnapshotHash, manifest.pages.length, frozenAt, frozenAt);
      this.db.prepare(`INSERT INTO book_version_access_controls(version_id,book_id,status,version,updated_at)
        VALUES(?,?,'active',1,?)`).run(versionId, book.id, frozenAt);
      for (const grantId of [...new Set(manifest.authorizedMemoryTexts.map((item) => item.grantId))]) {
        this.db.prepare("INSERT INTO book_version_grants(version_id,grant_id) VALUES(?,?)").run(versionId, grantId);
      }
      const sources = new Map(manifest.pages.filter((page) => page.sourcePhotoId)
        .map((page) => [page.sourcePhotoId, page.sourceProvenance]));
      for (const [photoId, provenance] of [...sources].sort(([left], [right]) => left.localeCompare(right))) {
        this.db.prepare(`INSERT INTO book_version_source_entries(version_id,photo_id,provenance_json)
          VALUES(?,?,?)`).run(versionId, photoId, json(provenance));
      }
      this.db.prepare(`INSERT INTO immutable_frozen_book_manifests(id,book_id,book_version_id,title,manifest_hash,
        authorization_snapshot_hash,authorized_text_snapshot_hash,asset_snapshot_hash,pages_json,frozen_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), book.id, versionId, manifest.title, manifest.manifestHash,
      manifest.authorizationSnapshotHash, manifest.authorizedMemoryTextSnapshotHash, manifest.assetSnapshotHash,
      json(manifest.pages), frozenAt);
      for (const snapshot of manifest.authorizedMemoryTexts) {
        this.db.prepare(`INSERT INTO immutable_authorized_memory_text_snapshots(id,book_id,book_version_id,
          personal_memory_id,grant_id,snapshot_hash,snapshot_json,frozen_at) VALUES(?,?,?,?,?,?,?,?)`).run(
        snapshot.authorizedMemoryTextId, book.id, versionId, snapshot.personalMemoryId, snapshot.grantId,
        snapshot.snapshotHash, json(snapshot), frozenAt);
      }
      const bytesByRef = new Map(frozenInput.assetBytes.map((asset) => [asset.localAssetRef, asset.bytesBase64]));
      for (const asset of manifest.frozenAssets) {
        this.db.prepare(`INSERT INTO immutable_frozen_book_assets(id,book_version_id,photo_id,kind,content_hash,
          metadata_json,bytes_blob) VALUES(?,?,?,?,?,?,?)`).run(asset.assetSnapshotId, versionId, asset.photoId,
        asset.kind, asset.contentHash, json(asset), Buffer.from(bytesByRef.get(asset.localAssetRef), "base64"));
      }
      this.db.prepare(`INSERT INTO book_render_jobs(id,book_id,status,version,input_hash,draft_version_id,
        book_version_id,grant_set_hash,layout_profile,input_json,manifest_hash,source_snapshot_hash,
        authorized_text_snapshot_hash,asset_snapshot_hash,access_control_version,attempt,created_at,updated_at)
        VALUES(?,?,'queued',1,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`).run(renderJobId, book.id, frozenInput.inputHash,
      book.draft_id, versionId, book.grant_set_hash, preview.layout_profile, json(frozenInput), manifest.manifestHash,
      frozenInput.guard.sourceSnapshotHash, manifest.authorizedMemoryTextSnapshotHash, manifest.assetSnapshotHash,
      frozenAt, frozenAt);
      for (const [artifactId, format] of [[htmlArtifactId, "html"], [pdfArtifactId, "pdf"]]) {
        this.db.prepare(`INSERT INTO render_artifacts(id,render_job_id,version_id,format,status,created_at,updated_at)
          VALUES(?,?,?,?,'queued',?,?)`).run(artifactId, renderJobId, versionId, format, frozenAt, frozenAt);
      }
      const draft = this.db.prepare(`UPDATE book_draft_versions SET status='frozen',version=version+1,
        updated_at=? WHERE id=? AND status='preview_ready' AND version=? AND preview_worker_input_hash=?`)
        .run(frozenAt, book.draft_id, book.draft_version, preview.input_hash);
      requireValue(draft.changes === 1, "version_conflict", 409);
      this.bookEvent(book.id, "BOOK.FREEZE", owner.kind, owner.authorizationId, { versionId, ordinal,
        draftVersionId: book.draft_id, renderJobId, manifestHash: manifest.manifestHash,
        authorizationSnapshotHash: manifest.authorizationSnapshotHash,
        authorizedMemoryTextSnapshotHash: manifest.authorizedMemoryTextSnapshotHash,
        assetSnapshotHash: manifest.assetSnapshotHash, pageCount: manifest.pages.length });
      return { status: 200, headers: BASE_HEADERS,
        body: this.bookVersionDto(this.db.prepare("SELECT * FROM book_versions WHERE id=?").get(versionId)) };
    });
  }

  async startNewBookVersion(ctx, spaceId, bookId) {
    const owner = this.ownerPrincipal(ctx.headers, spaceId);
    const body = exactObject(ctx.body, ["draftVersionId", "fromVersionId", "excludeWithdrawn"]);
    id(body.draftVersionId);
    id(body.fromVersionId);
    requireValue(body.excludeWithdrawn === true, "validation_failed");
    requireValue(typeof ctx.headers["if-match"] === "string" && ctx.headers["if-none-match"] === "*",
      "version_conflict", 409);
    const endpoint = "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft-versions";
    const mutationCtx = { ...ctx, principal: owner };
    return this.preparedMutation(mutationCtx, { actionId: "BOOK.START_NEW_VERSION", endpoint },
      () => this.startNewVersionCapability(owner, bookId, body.fromVersionId), (prepared) => {
      const { capability } = prepared;
      this.revalidateOwner(owner);
      const book = this.currentBook(bookId);
      requireValue(book?.space_id === spaceId, "authorization_changed", 409);
      requireValue(sameSecret(unquoteEtag(ctx.headers["if-match"]), this.ownerBookEtag(book)),
        "version_conflict", 409);
      requireValue(book.draft_status === "frozen", "new_version_already_open", 409);
      const sourceVersion = this.db.prepare(`SELECT * FROM book_versions WHERE id=? AND book_id=?
        AND draft_version_id=?`).get(body.fromVersionId, bookId, book.draft_id);
      const manifest = sourceVersion && this.db.prepare(`SELECT * FROM immutable_frozen_book_manifests
        WHERE book_version_id=? AND book_id=?`).get(sourceVersion.id, bookId);
      const control = sourceVersion && this.db.prepare("SELECT * FROM book_version_access_controls WHERE version_id=?")
        .get(sourceVersion.id);
      requireValue(sourceVersion && manifest && control && control.book_id === bookId &&
        START_NEW_VERSION_SOURCE_STATES.has(sourceVersion.status) &&
        START_NEW_VERSION_ACCESS_STATES.has(control.status) && Number.isSafeInteger(control.version) &&
        control.version >= 1 && manifest.manifest_hash === sourceVersion.manifest_hash &&
        manifest.authorization_snapshot_hash === sourceVersion.authorization_snapshot_hash &&
        manifest.authorized_text_snapshot_hash === sourceVersion.authorized_text_snapshot_hash &&
        manifest.asset_snapshot_hash === sourceVersion.asset_snapshot_hash, "source_version_not_found", 404);
      requireValue(!this.db.prepare("SELECT 1 FROM book_draft_versions WHERE id=?").get(body.draftVersionId),
        "version_conflict", 409);
      let frozenPages;
      try { frozenPages = parse(manifest.pages_json); } catch { frozenPages = null; }
      requireValue(Array.isArray(frozenPages), "source_version_not_found", 404);
      const grants = this.db.prepare(`SELECT g.*,p.confirmed_submission_id,p.confirmed_submission_hash current_hash,
        p.memory_revision_id current_revision,i.status memory_status,d.grant_id grant_denied,
        md.personal_memory_id memory_denied,sd.grant_id source_denied FROM book_contribution_grants g
        JOIN personal_memories p ON p.id=g.personal_memory_id
        JOIN memory_interviews i ON i.personal_memory_id=p.id
        LEFT JOIN book_grant_denials d ON d.grant_id=g.id
        LEFT JOIN memory_denials md ON md.personal_memory_id=g.personal_memory_id
        LEFT JOIN book_source_grant_denials sd ON sd.grant_id=g.id WHERE g.book_id=?`)
        .all(bookId);
      const grantsById = new Map(grants.map((grant) => [grant.id, grant]));
      let sourceRevoked = prepared.revokedSourcePhotoIds.length > 0;
      const revokedSourcePhotoIds = new Set(prepared.revokedSourcePhotoIds);
      const pages = [];
      for (const page of frozenPages) {
        const grant = page?.grantId ? grantsById.get(page.grantId) : null;
        if (page?.grantId && (!grant || grant.status !== "active" ||
          grant.audience_scope !== "current_live_space_viewers" || grant.grant_denied != null ||
          grant.memory_denied != null || grant.source_denied != null || grant.memory_status !== "confirmed" ||
          grant.personal_memory_id !== page.personalMemoryId || grant.memory_revision_id !== page.memoryRevisionId ||
          grant.current_revision !== page.memoryRevisionId ||
          grant.confirmed_submission_id !== page.confirmedSubmissionId ||
          grant.current_hash !== page.confirmedSubmissionHash ||
          grant.confirmed_submission_hash !== page.confirmedSubmissionHash)) continue;
        if (page?.sourcePhotoId) {
          const current = this.liveBookSource(capability, page.sourcePhotoId);
          if (!current || stableJson(current.provenance) !== stableJson(page.sourceProvenance)) {
            sourceRevoked = true;
            revokedSourcePhotoIds.add(page.sourcePhotoId);
            continue;
          }
        }
        if (page?.displayPhotoId && !this.liveBookSource(capability, page.displayPhotoId)) continue;
        pages.push({ ...structuredClone(page), index: pages.length + 1 });
      }
      if (sourceRevoked) this.applySourceRevoked([...revokedSourcePhotoIds]);
      const now = this.now();
      this.db.prepare(`INSERT INTO book_draft_versions(id,book_id,parent_version_id,title,status,version,pages_json,
        grant_set_hash,stale_reason,preview_worker_input_hash,created_at,updated_at)
        VALUES(?,?,?,?,'editing',?,?,?,NULL,NULL,?,?)`).run(body.draftVersionId, bookId, book.draft_id,
      book.title, book.draft_version + 1, json(pages), this.grantSetHash(bookId), now, now);
      const advanced = this.db.prepare(`UPDATE memory_books SET version=version+1,current_draft_version_id=?,updated_at=?
        WHERE id=? AND version=? AND current_draft_version_id=?`).run(body.draftVersionId, now, bookId,
      book.version, book.draft_id);
      requireValue(advanced.changes === 1, "version_conflict", 409);
      const current = this.currentBook(bookId);
      this.bookEvent(bookId, "BOOK.START_NEW_VERSION", owner.kind, owner.authorizationId,
        { fromVersionId: sourceVersion.id, draftVersionId: body.draftVersionId,
          excludedPageCount: frozenPages.length - pages.length });
      return { status: 200, headers: this.bookResponseHeaders(current), body: this.draftDto(current) };
    });
  }

  async canonicalHtmlArtifact(headers, spaceId, bookId, versionId) {
    const first = await this.readableBookVersion(headers, spaceId, bookId, versionId);
    const artifact = this.availableArtifact(versionId, "html");
    const bytes = artifact?.content_blob == null ? null : Buffer.from(artifact.content_blob);
    const html = bytes?.toString("utf8");
    requireValue(artifact?.status === "available" && artifact.version_id === versionId &&
      artifact.page_count === first.version.page_count && SHA256.test(artifact.content_hash) && bytes?.length >= 1 &&
      bytes.length <= MAX_PREVIEW_HTML_BYTES && Buffer.from(html).equals(bytes) &&
      sha256(bytes) === artifact.content_hash && safeSelfContainedHtml(html), "book_version_unavailable", 404);
    const current = await this.readableBookVersion(headers, spaceId, bookId, versionId);
    return { artifact, bytes, current };
  }

  async readCanonicalHtmlForUi(ctx, spaceId, bookId, versionId) {
    const { artifact, bytes } = await this.canonicalHtmlArtifact(ctx.headers, spaceId, bookId, versionId);
    return { bytes: Buffer.from(bytes), contentHash: artifact.content_hash };
  }

  async openBookPreview(ctx, spaceId, bookId, versionId) {
    const { artifact, current } = await this.canonicalHtmlArtifact(ctx.headers, spaceId, bookId, versionId);
    const orderedPageIds = current.pages.map((page) => page.pageId);
    const orderedSourceIds = current.pages.map((page) => page.sourcePhotoId);
    const orderedDisplayPhotoIds = current.pages.map((page) => page.displayPhotoId);
    return { status: 200, headers: { ...BASE_HEADERS, etag: `"${artifact.content_hash}"` }, body: {
      bookVersion: this.bookVersionDto(current.version),
      htmlArtifact: this.renderArtifactDto(artifact),
      orderedPageIds,
      orderedSourceIds,
      orderedDisplayPhotoIds
    } };
  }

  async downloadBookPdf(ctx, spaceId, bookId, versionId) {
    const first = await this.readableBookVersion(ctx.headers, spaceId, bookId, versionId);
    const artifact = this.availableArtifact(versionId, "pdf");
    const bytes = artifact?.content_blob == null ? null : Buffer.from(artifact.content_blob);
    requireValue(artifact?.status === "available" && artifact.version_id === versionId &&
      artifact.page_count === first.version.page_count && SHA256.test(artifact.content_hash) &&
      bytes?.length >= 5 && bytes.length <= MAX_FROZEN_PDF_BYTES &&
      bytes.subarray(0, 5).toString() === "%PDF-" && sha256(bytes) === artifact.content_hash,
    "book_version_unavailable", 404);
    await this.readableBookVersion(ctx.headers, spaceId, bookId, versionId);
    const filename = `unseen-book-version-${String(first.version.ordinal).padStart(2, "0")}.pdf`;
    return { status: 200, headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename=${filename}`,
      "content-length": String(bytes.length),
      etag: `"${artifact.content_hash}"`,
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff"
    }, body: bytes };
  }

  authorizeBookMemory(ctx, bookId, memoryId) {
    const endpoint = "/v2-labs/books/{bookId}/contribution-grants/{personalMemoryId}";
    const memory = this.ownedMemory(ctx.principal, memoryId);
    const body = exactObject(ctx.body, ["personalMemoryId", "memoryRevisionId", "confirmedSubmissionHash",
      "creditLabel", "audienceScope", "noticeVersion", "noticeHash"]);
    requireValue(body.personalMemoryId === memoryId, "memory_unavailable", 404);
    id(body.memoryRevisionId);
    hash(body.confirmedSubmissionHash);
    requireValue(typeof body.creditLabel === "string" && body.creditLabel.length >= 1 && body.creditLabel.length <= 120,
      "credit_label_invalid", 409);
    requireValue(body.audienceScope === "current_live_space_viewers", "audience_scope_changed", 409);
    text(body.noticeVersion, 1, 200);
    hash(body.noticeHash);
    requireValue(ctx.headers["if-none-match"] === "*", "version_conflict", 409);
    return this.mutation(ctx, { actionId: "BOOK_MEMORY.AUTHORIZE", endpoint, targetMemoryId: memoryId }, () => {
      const currentMemory = this.ownedMemory(ctx.principal, memoryId);
      requireValue(body.noticeVersion === this.currentBookNotice.version && body.noticeHash === this.currentBookNotice.hash,
        "notice_changed", 409);
      requireValue(this.currentMemorySource(ctx.principal, currentMemory), "memory_revision_changed", 409);
      const book = this.currentBook(bookId);
      requireValue(book && book.space_id === parse(currentMemory.provenance_json).spaceId, "memory_unavailable", 404);
      requireValue(sameSecret(unquoteEtag(ctx.headers["if-match"]), this.authorizationEtag(currentMemory, book)),
        "version_conflict", 409);
      requireValue(currentMemory.interview_status === "confirmed", "memory_not_confirmed", 409);
      requireValue(currentMemory.memory_revision_id === body.memoryRevisionId &&
        currentMemory.confirmed_submission_hash === body.confirmedSubmissionHash, "memory_revision_changed", 409);
      requireValue(!this.db.prepare(`SELECT 1 FROM book_contribution_grants WHERE book_id=? AND personal_memory_id=?
        AND status IN ('active','withdrawal_pending')`).get(bookId, memoryId), "version_conflict", 409);
      const now = this.now();
      const grantId = randomUUID();
      const titleEvent = this.latestTitleAuditEvent(bookId);
      const titleDetail = titleEvent && parse(titleEvent.detail_json);
      requireValue(titleEvent && titleDetail.title === book.title && titleDetail.titleHash === sha256(book.title),
        "internal_error", 500);
      const titleAuditSnapshot = { title: book.title, titleHash: sha256(book.title), titleEventId: titleEvent.id,
        capturedAt: titleEvent.created_at };
      this.bookEvent(bookId, "BOOK_MEMORY.AUTHORIZE", ctx.principal.kind, ctx.principal.authorizationId,
        { grantId, personalMemoryId: memoryId, memoryRevisionId: body.memoryRevisionId,
          confirmedSubmissionHash: body.confirmedSubmissionHash, creditLabel: body.creditLabel,
          audienceScope: body.audienceScope, noticeVersion: body.noticeVersion, noticeHash: body.noticeHash,
          titleAuditSnapshot });
      this.db.prepare(`INSERT INTO book_contribution_grants(id,book_id,personal_memory_id,memory_revision_id,
        confirmed_submission_hash,contributor_id,credit_label,audience_scope,status,notice_version,notice_hash,
        title_audit_snapshot_json,version,granted_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'current_live_space_viewers','active',?,?,?,1,?,?)`).run(grantId, bookId, memoryId,
      body.memoryRevisionId, body.confirmedSubmissionHash, currentMemory.contributor_id, body.creditLabel,
      body.noticeVersion, body.noticeHash, json(titleAuditSnapshot), now, now);
      const currentBook = this.invalidateDraft(bookId, "grant_authorized");
      const grant = this.db.prepare("SELECT * FROM book_contribution_grants WHERE id=?").get(grantId);
      return { status: 200, headers: { ...BASE_HEADERS,
        "x-unseen-grant-etag": this.grantWithdrawalEtag(grant, currentBook) }, body: this.grantDto(grant) };
    });
  }

  withdrawBookMemory(ctx, bookId, memoryId) {
    const endpoint = "/v2-labs/books/{bookId}/contribution-grants/{personalMemoryId}/withdrawals";
    this.ownedMemory(ctx.principal, memoryId);
    exactObject(ctx.body, [], ["reason"]);
    if (ctx.body.reason !== undefined) text(ctx.body.reason, 0, 500);
    return this.mutation(ctx, { actionId: "BOOK_MEMORY.WITHDRAW", endpoint, targetMemoryId: memoryId }, () => {
      this.ownedMemory(ctx.principal, memoryId);
      const grant = this.db.prepare(`SELECT * FROM book_contribution_grants WHERE book_id=? AND personal_memory_id=?
        AND contributor_id=? ORDER BY granted_at DESC,rowid DESC LIMIT 1`).get(bookId, memoryId,
      ctx.principal.contributorId);
      requireValue(grant, "grant_not_found", 404);
      requireValue(grant.status !== "withdrawn", "grant_already_withdrawn", 409);
      requireValue(grant.status === "active", "version_conflict", 409);
      const book = this.currentBook(bookId);
      requireValue(book, "grant_not_found", 404);
      requireValue(sameSecret(unquoteEtag(ctx.headers["if-match"]), this.grantWithdrawalEtag(grant, book)),
        "version_conflict", 409);
      const now = this.now();
      const withdrawalId = randomUUID();
      this.db.prepare("INSERT INTO book_grant_denials(grant_id,withdrawal_id,read_blocked_at) VALUES(?,?,?)")
        .run(grant.id, withdrawalId, now);
      const controls = this.grantAccessControlSnapshot(grant.id).filter((row) => row.status === "active");
      for (const control of controls) this.db.prepare(`UPDATE book_version_access_controls
        SET status='affected',version=version+1,updated_at=? WHERE version_id=? AND status='active'`)
        .run(now, control.versionId);
      this.revokeFrozenVersions(controls.map((row) => row.versionId), now);
      this.db.prepare(`UPDATE book_contribution_grants SET status='withdrawal_pending',version=version+1,
        updated_at=? WHERE id=?`).run(now, grant.id);
      this.invalidateDraft(bookId, "grant_withdrawn", [grant.id]);
      const affected = controls.map((row) => row.versionId);
      const accessVersion = controls.length === 0 ? 1 : Math.max(...controls.map((row) => row.version + 1));
      this.db.prepare(`INSERT INTO book_grant_withdrawal_receipts(id,grant_id,book_id,personal_memory_id,
        read_blocked_at,purge_status,affected_book_version_ids_json,access_control_version,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(withdrawalId, grant.id, bookId, memoryId, now,
      "queued", json(affected), accessVersion, now);
      this.db.prepare(`INSERT INTO book_grant_cleanup_outbox(withdrawal_id,grant_id,status,attempt,updated_at)
        VALUES(?,?,'queued',0,?)`).run(withdrawalId, grant.id, now);
      this.bookEvent(bookId, "BOOK_MEMORY.WITHDRAW", ctx.principal.kind, ctx.principal.authorizationId,
        { grantId: grant.id, withdrawalId, readBlockedAt: now });
      return { status: 200, headers: BASE_HEADERS, body: { withdrawalId, scope: "memory_one_book",
        readBlockedAt: now, purgeStatus: "queued", affectedBookVersionIds: affected,
        version: accessVersion } };
    });
  }

  grantWithdrawalDto(row) {
    return {
      withdrawalId: row.id,
      scope: "memory_one_book",
      readBlockedAt: row.read_blocked_at,
      purgeStatus: row.purge_status,
      affectedBookVersionIds: parse(row.affected_book_version_ids_json, []),
      version: row.access_control_version
    };
  }

  pendingGrantCleanup(workerSecret) {
    requireValue(sameSecret(workerSecret, this.cleanupSecret), "memory_unavailable", 404);
    return this.db.prepare(`SELECT withdrawal_id withdrawalId,grant_id grantId,attempt
      FROM book_grant_cleanup_outbox WHERE status IN ('queued','retrying') ORDER BY updated_at,rowid`).all();
  }

  scrubGrantContent(grant) {
    const frozenVersionIds = this.db.prepare("SELECT version_id versionId FROM book_version_grants WHERE grant_id=?")
      .all(grant.id).map((row) => row.versionId);
    this.scrubDraftHistory(grant.book_id, [grant.id]);
    this.scrubPreviewContent(grant.book_id, [grant.id]);
    this.purgeFrozenVersionContent(frozenVersionIds);
    this.db.prepare(`UPDATE book_events SET detail_json='{}' WHERE event_type='BOOK_MEMORY.AUTHORIZE'
      AND (json_extract(detail_json,'$.grantId')=? OR (json_extract(detail_json,'$.grantId') IS NULL
      AND book_id=? AND json_extract(detail_json,'$.personalMemoryId')=?
      AND json_extract(detail_json,'$.memoryRevisionId')=?
      AND json_extract(detail_json,'$.confirmedSubmissionHash')=?))`).run(grant.id, grant.book_id,
    grant.personal_memory_id, grant.memory_revision_id, grant.confirmed_submission_hash);
    this.db.prepare(`DELETE FROM idempotency_receipts WHERE action_id='BOOK_MEMORY.AUTHORIZE'
      AND json_extract(response_json,'$.grantId')=?`).run(grant.id);
    this.db.prepare(`UPDATE book_contribution_grants SET confirmed_submission_hash=?,credit_label='[withdrawn]',
      title_audit_snapshot_json='{}',updated_at=? WHERE id=?`).run(sha256("withdrawn-book-grant"), this.now(), grant.id);
  }

  processGrantCleanup(withdrawalId, workerSecret) {
    requireValue(sameSecret(workerSecret, this.cleanupSecret), "memory_unavailable", 404);
    id(withdrawalId);
    const logical = transaction(this.db, () => {
      const receipt = this.db.prepare("SELECT * FROM book_grant_withdrawal_receipts WHERE id=?").get(withdrawalId);
      requireValue(receipt, "memory_unavailable", 404);
      if (receipt.purge_status === "complete") return { complete: this.grantWithdrawalDto(receipt) };
      requireValue(this.db.prepare(`SELECT 1 FROM book_grant_denials WHERE grant_id=? AND withdrawal_id=?`)
        .get(receipt.grant_id, withdrawalId), "memory_unavailable", 404);
      const grant = this.db.prepare("SELECT * FROM book_contribution_grants WHERE id=?").get(receipt.grant_id);
      requireValue(grant && grant.status === "withdrawal_pending", "memory_unavailable", 404);
      const now = this.now();
      this.db.prepare(`UPDATE book_grant_cleanup_outbox SET status='retrying',attempt=attempt+1,updated_at=?
        WHERE withdrawal_id=?`).run(now, withdrawalId);
      this.db.prepare(`UPDATE book_grant_withdrawal_receipts SET purge_status='retrying',updated_at=? WHERE id=?`)
        .run(now, withdrawalId);
      this.scrubGrantContent(grant);
      return { grantId: grant.id, bookId: grant.book_id };
    });
    if (logical.complete) return logical.complete;
    this.secureFiles();
    if (this.database !== ":memory:") {
      const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      requireValue(checkpoint.busy === 0 && checkpoint.log === 0, "cleanup_retry_required", 503);
    }
    const result = transaction(this.db, () => {
      const receipt = this.db.prepare("SELECT * FROM book_grant_withdrawal_receipts WHERE id=?").get(withdrawalId);
      requireValue(receipt, "memory_unavailable", 404);
      if (receipt.purge_status === "complete") return this.grantWithdrawalDto(receipt);
      const now = this.now();
      for (const versionId of parse(receipt.affected_book_version_ids_json, [])) {
        this.db.prepare(`UPDATE book_version_access_controls SET status='revoked',version=version+1,updated_at=?
          WHERE version_id=? AND status='affected'`).run(now, versionId);
      }
      this.db.prepare(`UPDATE book_contribution_grants SET status='withdrawn',version=version+1,updated_at=?
        WHERE id=? AND status='withdrawal_pending'`).run(now, logical.grantId);
      this.db.prepare(`UPDATE book_grant_withdrawal_receipts SET purge_status='complete',updated_at=? WHERE id=?`)
        .run(now, withdrawalId);
      this.db.prepare(`UPDATE book_grant_cleanup_outbox SET status='complete',updated_at=? WHERE withdrawal_id=?`)
        .run(now, withdrawalId);
      this.bookEvent(logical.bookId, "BOOK_MEMORY_PURGE_COMPLETE", "cleanup_worker",
        "book-lab-cleanup-worker", { grantId: logical.grantId, withdrawalId });
      return this.grantWithdrawalDto(this.db.prepare("SELECT * FROM book_grant_withdrawal_receipts WHERE id=?")
        .get(withdrawalId));
    });
    this.secureFiles();
    return result;
  }

  confirm(ctx, memoryId) {
    const endpoint = "/v2-labs/memories/{memoryId}/confirmations";
    this.ownedMemory(ctx.principal, memoryId);
    const body = exactObject(ctx.body, ["submissionId", "submissionHash", "interviewIfMatchVersion"]);
    id(body.submissionId);
    hash(body.submissionHash);
    positiveInteger(body.interviewIfMatchVersion);
    return this.mutation(ctx, { actionId: "MEMORY.CONFIRM", endpoint, targetMemoryId: memoryId }, () => {
      const memory = this.ownedMemory(ctx.principal, memoryId);
      this.assertMemoryIfMatch(ctx.headers["if-match"], memory);
      requireValue(body.interviewIfMatchVersion === memory.interview_version, "version_conflict", 409);
      requireValue(["draft", "followup_queued", "followup_ready"].includes(memory.interview_status),
        "version_conflict", 409);
      const submission = this.db.prepare("SELECT * FROM answer_submissions WHERE id=? AND personal_memory_id=?")
        .get(body.submissionId, memoryId);
      requireValue(submission, "answer_required", 409);
      requireValue(submission.submission_hash === body.submissionHash, "selected_text_changed", 409);
      const factDraft = this.db.prepare(`SELECT f.* FROM memory_model_fact_drafts f
        JOIN memory_model_fact_answer_links l ON l.fact_draft_id=f.id
        WHERE l.submission_id=? AND f.personal_memory_id=?`).get(submission.id, memoryId);
      requireValue(factDraft?.status === "answered", "selected_text_changed", 409);
      const memoryRevisionId = randomUUID();
      const now = this.now();
      if (memory.interview_status === "followup_queued") {
        const activeJobs = this.db.prepare(`SELECT * FROM memory_question_jobs WHERE personal_memory_id=?
          AND kind='followup_question' AND status IN ('queued','running') ORDER BY created_at,rowid`).all(memoryId);
        for (const activeJob of activeJobs) {
          const pendingFact = this.db.prepare("SELECT * FROM memory_model_fact_drafts WHERE question_job_id=?")
            .get(activeJob.id);
          if (pendingFact?.status === "pending") this.transitionPrivateFact(pendingFact, "withdrawn", {
            model_visible_facts_json: null, facts_hash: null, question_hash: null, provider_result_hash: null,
            lease_expires_at: null, retry_after_at: null, last_stable_error: null
          }, { event: "FACT_CONVERSATION_FINISHED" });
          this.db.prepare(`UPDATE memory_question_jobs SET status='cancelled',version=version+1,
            last_stable_error=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status IN ('queued','running')`)
            .run(now, activeJob.id);
        }
      }
      this.db.prepare(`UPDATE personal_memories SET confirmed_submission_id=?,confirmed_submission_hash=?,
        memory_revision_id=?,version=version+1,updated_at=? WHERE id=?`).run(submission.id,
      submission.submission_hash, memoryRevisionId, now, memoryId);
      this.db.prepare(`UPDATE memory_interviews SET status='confirmed',version=version+1,updated_at=?
        WHERE personal_memory_id=?`).run(now, memoryId);
      this.transitionPrivateFact(factDraft, "confirmed", {}, { event: "FACT_CONFIRMED" });
      const current = this.ownedMemory(ctx.principal, memoryId);
      this.event(ctx.principal, memoryId, "MEMORY.CONFIRM", current.version,
        { submissionId: submission.id, memoryRevisionId });
      return { status: 200, headers: headersFor(this.memoryEtag(current),
        this.interviewEtag({ personal_memory_id: memoryId, version: current.interview_version }),
        this.followupEtag(current)),
      body: { memory: this.memoryDto(current), submissions: this.submissions(memoryId),
        grantReceipts: this.grantReceipts(memoryId) } };
    });
  }

  withdraw(ctx, memoryId) {
    const endpoint = "/v2-labs/memories/{memoryId}/withdrawals";
    this.ownedMemory(ctx.principal, memoryId, { allowDenied: true });
    const body = exactObject(ctx.body, ["interviewIfMatchVersion"], ["reason"]);
    positiveInteger(body.interviewIfMatchVersion);
    if (body.reason !== undefined) text(body.reason, 0, 500);
    return this.mutation(ctx, { actionId: "MEMORY.WITHDRAW", endpoint, targetMemoryId: memoryId }, () => {
      const memory = this.ownedMemory(ctx.principal, memoryId, { allowDenied: true });
      requireValue(!this.db.prepare("SELECT 1 FROM memory_denials WHERE personal_memory_id=?").get(memoryId),
        "memory_already_withdrawn", 409);
      this.assertMemoryIfMatch(ctx.headers["if-match"], memory);
      requireValue(body.interviewIfMatchVersion === memory.interview_version, "version_conflict", 409);
      requireValue(["question_queued", "question_ready", "question_failed", "draft", "followup_queued",
        "followup_ready", "confirmed"].includes(memory.interview_status), "memory_already_withdrawn", 409);
      const now = this.now();
      const withdrawalId = randomUUID();
      this.db.prepare("INSERT INTO memory_denials(personal_memory_id,withdrawal_id,read_blocked_at) VALUES(?,?,?)")
        .run(memoryId, withdrawalId, now);
      const grants = this.db.prepare(`SELECT * FROM book_contribution_grants WHERE personal_memory_id=?
        AND status IN ('active','withdrawal_pending') ORDER BY book_id,id`).all(memoryId);
      const affectedBookVersionIds = [];
      let receiptVersion = 1;
      const grantsByBook = new Map();
      for (const grant of grants) {
        const controls = this.grantAccessControlSnapshot(grant.id).filter((row) => row.status !== "revoked");
        affectedBookVersionIds.push(...controls.map((row) => row.versionId));
        if (controls.length > 0) receiptVersion = Math.max(receiptVersion, ...controls.map((row) => row.version + 1));
        for (const control of controls) this.db.prepare(`UPDATE book_version_access_controls
          SET status='affected',version=version+1,updated_at=? WHERE version_id=? AND status='active'`)
          .run(now, control.versionId);
        this.revokeFrozenVersions(controls.map((row) => row.versionId), now);
        this.db.prepare(`UPDATE book_contribution_grants SET status='withdrawal_pending',version=version+1,
          updated_at=? WHERE id=?`).run(now, grant.id);
        grantsByBook.set(grant.book_id, [...(grantsByBook.get(grant.book_id) ?? []), grant.id]);
        this.bookEvent(grant.book_id, "MEMORY.WITHDRAW", ctx.principal.kind, ctx.principal.authorizationId,
          { personalMemoryId: memoryId, grantId: grant.id, withdrawalId, readBlockedAt: now });
      }
      for (const [bookId, grantIds] of grantsByBook) this.invalidateDraft(bookId, "memory_withdrawn", grantIds);
      const factDrafts = this.db.prepare(`SELECT * FROM memory_model_fact_drafts
        WHERE personal_memory_id=? AND status!='withdrawn' ORDER BY created_at,rowid`).all(memoryId);
      for (const factDraft of factDrafts) {
        this.transitionPrivateFact(factDraft, "withdrawn", { model_visible_facts_json: null,
          facts_hash: null, question_hash: null, provider_result_hash: null, lease_expires_at: null,
          retry_after_at: null, last_stable_error: null }, { event: "FACT_WITHDRAWN", withdrawalId });
      }
      this.db.prepare(`UPDATE memory_question_jobs SET status='cancelled',version=version+1,last_stable_error=NULL,
        lease_expires_at=NULL,updated_at=? WHERE personal_memory_id=? AND status IN ('queued','running')`)
        .run(now, memoryId);
      this.db.prepare("UPDATE personal_memories SET version=version+1,updated_at=? WHERE id=?").run(now, memoryId);
      this.db.prepare(`UPDATE memory_interviews SET status='withdrawal_pending',version=version+1,updated_at=?
        WHERE personal_memory_id=?`).run(now, memoryId);
      this.db.prepare(`INSERT INTO withdrawal_receipts(id,personal_memory_id,scope,read_blocked_at,purge_status,
        affected_book_version_ids_json,version,updated_at) VALUES(?,?,'memory_all_books',?,'queued',?,?,?)`)
        .run(withdrawalId, memoryId, now, json([...new Set(affectedBookVersionIds)]), receiptVersion, now);
      this.db.prepare(`INSERT INTO cleanup_outbox(withdrawal_id,personal_memory_id,status,attempt,updated_at)
        VALUES(?,?,'queued',0,?)`).run(withdrawalId, memoryId, now);
      this.event(ctx.principal, memoryId, "MEMORY.WITHDRAW", memory.version + 1, { withdrawalId, readBlockedAt: now });
      return { status: 200, headers: BASE_HEADERS, body: {
        withdrawalId, scope: "memory_all_books", readBlockedAt: now, purgeStatus: "queued",
        affectedBookVersionIds: [...new Set(affectedBookVersionIds)], version: receiptVersion
      } };
    });
  }

  pendingCleanup(workerSecret) {
    requireValue(sameSecret(workerSecret, this.cleanupSecret), "memory_unavailable", 404);
    return this.db.prepare("SELECT withdrawal_id withdrawalId,personal_memory_id personalMemoryId,attempt FROM cleanup_outbox WHERE status IN ('queued','retrying') ORDER BY updated_at,rowid").all();
  }

  processCleanup(withdrawalId, workerSecret) {
    requireValue(sameSecret(workerSecret, this.cleanupSecret), "memory_unavailable", 404);
    id(withdrawalId);
    const logical = transaction(this.db, () => {
      const receipt = this.db.prepare("SELECT * FROM withdrawal_receipts WHERE id=?").get(withdrawalId);
      requireValue(receipt, "memory_unavailable", 404);
      if (receipt.purge_status === "complete") return { complete: this.withdrawalDto(receipt) };
      const denial = this.db.prepare("SELECT * FROM memory_denials WHERE personal_memory_id=? AND withdrawal_id=?")
        .get(receipt.personal_memory_id, withdrawalId);
      requireValue(denial, "memory_unavailable", 404);
      const now = this.now();
      this.db.prepare("UPDATE cleanup_outbox SET status='retrying',attempt=attempt+1,updated_at=? WHERE withdrawal_id=?")
        .run(now, withdrawalId);
      this.db.prepare("UPDATE withdrawal_receipts SET purge_status='retrying',updated_at=? WHERE id=?")
        .run(now, withdrawalId);
      const grants = this.db.prepare("SELECT * FROM book_contribution_grants WHERE personal_memory_id=?")
        .all(receipt.personal_memory_id);
      for (const grant of grants) {
        this.scrubGrantContent(grant);
        this.db.prepare(`UPDATE book_version_access_controls SET status='revoked',version=version+1,updated_at=?
          WHERE status='affected' AND version_id IN
          (SELECT version_id FROM book_version_grants WHERE grant_id=?)`).run(now, grant.id);
        this.db.prepare(`UPDATE book_contribution_grants SET status='withdrawn',version=version+1,updated_at=?
          WHERE id=? AND status='withdrawal_pending'`).run(now, grant.id);
        this.db.prepare(`UPDATE book_grant_withdrawal_receipts SET purge_status='complete',updated_at=?
          WHERE grant_id=?`).run(now, grant.id);
        this.db.prepare(`UPDATE book_grant_cleanup_outbox SET status='complete',updated_at=? WHERE grant_id=?`)
          .run(now, grant.id);
      }
      this.db.prepare(`UPDATE book_events SET detail_json='{}' WHERE event_type='BOOK_MEMORY.AUTHORIZE'
        AND json_extract(detail_json,'$.personalMemoryId')=?`).run(receipt.personal_memory_id);
      this.db.prepare("DELETE FROM answer_submissions WHERE personal_memory_id=?").run(receipt.personal_memory_id);
      this.db.prepare("DELETE FROM memory_question_jobs WHERE personal_memory_id=?").run(receipt.personal_memory_id);
      this.db.prepare(`DELETE FROM idempotency_receipts WHERE target_memory_id=? AND action_id!='MEMORY.WITHDRAW'`)
        .run(receipt.personal_memory_id);
      this.db.prepare(`UPDATE personal_memories SET head_submission_id=NULL,confirmed_submission_id=NULL,
        confirmed_submission_hash=NULL,updated_at=? WHERE id=?`).run(now, receipt.personal_memory_id);
      this.db.prepare(`UPDATE memory_events SET detail_json='{}' WHERE personal_memory_id=? AND event_type IN
        ('MEMORY.SAVE_ANSWER_DRAFT','MEMORY.REQUEST_FOLLOWUP','MEMORY.CONFIRM')`).run(receipt.personal_memory_id);
      this.db.prepare(`UPDATE memory_interviews SET status='withdrawn',version=version+1,updated_at=?
        WHERE personal_memory_id=? AND status='withdrawal_pending'`).run(now, receipt.personal_memory_id);
      const interview = this.db.prepare("SELECT * FROM memory_interviews WHERE personal_memory_id=?")
        .get(receipt.personal_memory_id);
      const provenance = parse(interview.provenance_json);
      this.db.prepare("UPDATE memory_interviews SET provenance_json=? WHERE personal_memory_id=?")
        .run(json({ photoId: provenance.photoId, photoContentHash: provenance.photoContentHash,
          placementSnapshotHash: provenance.placementSnapshotHash }), receipt.personal_memory_id);
      return { personalMemoryId: receipt.personal_memory_id };
    });
    if (logical.complete) return logical.complete;
    this.secureFiles();
    if (this.database !== ":memory:") {
      const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      requireValue(checkpoint.busy === 0 && checkpoint.log === 0, "cleanup_retry_required", 503);
    }
    const result = transaction(this.db, () => {
      const receipt = this.db.prepare("SELECT * FROM withdrawal_receipts WHERE id=?").get(withdrawalId);
      requireValue(receipt, "memory_unavailable", 404);
      if (receipt.purge_status === "complete") return this.withdrawalDto(receipt);
      const now = this.now();
      this.db.prepare("UPDATE withdrawal_receipts SET purge_status='complete',updated_at=? WHERE id=?")
        .run(now, withdrawalId);
      this.db.prepare("UPDATE cleanup_outbox SET status='complete',updated_at=? WHERE withdrawal_id=?")
        .run(now, withdrawalId);
      const interview = this.db.prepare("SELECT * FROM memory_interviews WHERE personal_memory_id=?")
        .get(logical.personalMemoryId);
      this.systemEvent(logical.personalMemoryId, "MEMORY_PURGE_COMPLETE", interview.version,
        "cleanup_worker", "book-lab-cleanup-worker");
      return this.withdrawalDto(this.db.prepare("SELECT * FROM withdrawal_receipts WHERE id=?").get(withdrawalId));
    });
    this.secureFiles();
    return result;
  }

  withdrawalDto(row) {
    return {
      withdrawalId: row.id,
      scope: row.scope,
      readBlockedAt: row.read_blocked_at,
      purgeStatus: row.purge_status,
      affectedBookVersionIds: parse(row.affected_book_version_ids_json, []),
      version: row.version
    };
  }

  pendingPreviewJobs(renderWorkerSecret) {
    requireValue(this.renderWorkerSecret && sameSecret(renderWorkerSecret, this.renderWorkerSecret),
      "render_job_unavailable", 404);
    const now = this.now();
    return this.db.prepare(`SELECT * FROM book_render_jobs WHERE book_version_id IS NULL AND
      (status='queued' OR (status='rendering_html' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?))
      ORDER BY created_at,updated_at,rowid`).all(now).map((row) => ({
      renderJobId: row.id,
      jobVersion: row.version,
      draftVersionId: row.draft_version_id,
      manifestHash: row.manifest_hash,
      grantSetHash: row.grant_set_hash,
      sourceSnapshotHash: row.source_snapshot_hash,
      authorizedMemoryTextSnapshotHash: row.authorized_text_snapshot_hash,
      assetSnapshotHash: row.asset_snapshot_hash,
      accessControlVersion: row.access_control_version,
      inputHash: row.input_hash,
      attempt: row.attempt + 1
    }));
  }

  previewProcessorResult(row, status = row.status) {
    return {
      renderJobId: row.id,
      status,
      manifestHash: row.manifest_hash,
      authorizedMemoryTextSnapshotHash: row.authorized_text_snapshot_hash,
      assetSnapshotHash: row.asset_snapshot_hash,
      htmlHash: row.html_hash,
      pdfHash: row.pdf_hash,
      stableError: row.last_stable_error,
      version: row.version
    };
  }

  async processPreview(request, renderWorkerSecret) {
    requireValue(this.renderWorkerSecret && sameSecret(renderWorkerSecret, this.renderWorkerSecret),
      "render_job_unavailable", 404);
    exactObject(request, ["renderJobId", "jobVersion", "draftVersionId", "manifestHash", "grantSetHash",
      "sourceSnapshotHash", "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "accessControlVersion",
      "inputHash", "attempt"]);
    id(request.renderJobId);
    positiveInteger(request.jobVersion);
    id(request.draftVersionId);
    for (const field of ["manifestHash", "grantSetHash", "sourceSnapshotHash",
      "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "inputHash"]) hash(request[field]);
    requireValue(Number.isSafeInteger(request.accessControlVersion) && request.accessControlVersion >= 0,
      "render_input_changed", 409);
    positiveInteger(request.attempt);
    const before = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=? AND book_version_id IS NULL")
      .get(request.renderJobId);
    let capability = null;
    if (before && !PREVIEW_TERMINAL.has(before.status)) {
      try { capability = await this.workerInputCapability(parse(before.input_json), "render_input_changed"); }
      catch { capability = null; }
    }
    const claimed = transaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=? AND book_version_id IS NULL")
        .get(request.renderJobId);
      requireValue(row, "render_job_unavailable", 404);
      for (const [field, column] of [["draftVersionId", "draft_version_id"], ["manifestHash", "manifest_hash"],
        ["grantSetHash", "grant_set_hash"], ["sourceSnapshotHash", "source_snapshot_hash"],
        ["authorizedMemoryTextSnapshotHash", "authorized_text_snapshot_hash"],
        ["assetSnapshotHash", "asset_snapshot_hash"], ["accessControlVersion", "access_control_version"],
        ["inputHash", "input_hash"]]) {
        requireValue(request[field] === row[column], "render_input_changed", 409);
      }
      if (PREVIEW_TERMINAL.has(row.status)) {
        requireValue((request.attempt === row.attempt ||
          row.status === "cancelled" && row.attempt === 0 && request.attempt === 1) &&
          (request.jobVersion === row.version - 1 || request.jobVersion === row.version - 2),
        "render_input_changed", 409);
        return { terminal: row };
      }
      if (row.status === "rendering_html" && request.attempt === row.attempt &&
        request.jobVersion === row.version - 1) return { row };
      requireValue(row.version === request.jobVersion && request.attempt === row.attempt + 1,
        "render_input_changed", 409);
      const expired = row.status === "rendering_html" && row.lease_expires_at && row.lease_expires_at <= this.now();
      requireValue(row.status === "queued" || expired, "render_input_changed", 409);
      const input = parse(row.input_json);
      const { manifestHash: storedManifestHash, ...manifestSemantic } = input?.manifest ?? {};
      requireValue(input && input.inputHash === row.input_hash &&
        storedManifestHash === sha256(stableJson(manifestSemantic)) &&
        sha256(stableJson(input.manifest.authorizedMemoryTexts)) === row.authorized_text_snapshot_hash &&
        sha256(stableJson(input.manifest.frozenAssets)) === row.asset_snapshot_hash &&
        sha256(stableJson({ manifestHash: storedManifestHash, assetBytes: input.assetBytes,
          accessControlSnapshot: input.accessControlSnapshot, guard: input.guard })) === row.input_hash,
      "render_input_changed", 409);
      if (!this.previewInputStillCurrent(input, capability)) {
        return { terminal: this.discardStalePreview(row, request.attempt), stale: true };
      }
      const leaseExpiresAt = new Date(this.nowMs() + this.previewLeaseMs).toISOString();
      const changed = this.db.prepare(`UPDATE book_render_jobs SET status='rendering_html',version=version+1,
        attempt=?,lease_expires_at=?,last_stable_error=NULL,updated_at=? WHERE id=? AND version=?`).run(
      request.attempt, leaseExpiresAt, this.now(), row.id, row.version);
      requireValue(changed.changes === 1, "render_input_changed", 409);
      return { row: this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id) };
    });
    if (claimed.terminal) return this.previewProcessorResult(claimed.terminal,
      claimed.stale ? "discarded_stale" : claimed.terminal.status);
    return { renderJobId: claimed.row.id, status: "claimed", version: claimed.row.version,
      input: deepFreeze(structuredClone(parse(claimed.row.input_json))) };
  }

  async completePreview(request, output, renderWorkerSecret) {
    requireValue(this.renderWorkerSecret && sameSecret(renderWorkerSecret, this.renderWorkerSecret),
      "render_job_unavailable", 404);
    exactObject(request, ["renderJobId", "jobVersion", "inputHash", "attempt"]);
    id(request.renderJobId);
    positiveInteger(request.jobVersion);
    hash(request.inputHash);
    positiveInteger(request.attempt);
    let stableError = null;
    try {
      exactObject(output, ["status"], ["html", "htmlHash", "pageCount", "htmlArtifactId", "equality", "stableError"]);
      requireValue(["ready", "failed"].includes(output.status), "render_failed", 503);
      if (output.status === "failed") {
        requireValue(Object.keys(output).length === 2 &&
          ["render_failed", "artifact_mismatch"].includes(output.stableError), "render_failed", 503);
        stableError = output.stableError;
      } else {
        requireValue(Object.keys(output).length === 6 && output.stableError === undefined,
          "artifact_mismatch", 409);
        requireValue(typeof output.html === "string" && Buffer.byteLength(output.html) >= 1 &&
          Buffer.byteLength(output.html) <= MAX_PREVIEW_HTML_BYTES && safeSelfContainedHtml(output.html),
        "artifact_mismatch", 409);
        hash(output.htmlHash);
        requireValue(Number.isSafeInteger(output.pageCount) && output.pageCount >= 12 && output.pageCount <= 16,
          "artifact_mismatch", 409);
        id(output.htmlArtifactId);
        exactObject(output.equality, ["bookId", "versionId", "title", "manifestHash",
          "authorizationSnapshotHash", "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "pageCount",
          "orderedPageIds", "orderedSourceIds", "orderedDisplayPhotoIds"]);
      }
    } catch (error) {
      stableError = error instanceof BookLabError && error.code === "artifact_mismatch"
        ? "artifact_mismatch" : "render_failed";
    }
    const before = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=? AND book_version_id IS NULL")
      .get(request.renderJobId);
    let capability = null;
    if (before && !PREVIEW_TERMINAL.has(before.status)) {
      try { capability = await this.workerInputCapability(parse(before.input_json), "render_input_changed"); }
      catch { capability = null; }
    }
    const completed = transaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=? AND book_version_id IS NULL")
        .get(request.renderJobId);
      requireValue(row, "render_job_unavailable", 404);
      if (PREVIEW_TERMINAL.has(row.status)) {
        requireValue(row.input_hash === request.inputHash && row.attempt === request.attempt &&
          row.version === request.jobVersion + 1, "render_input_changed", 409);
        return { row, stale: row.status === "cancelled" };
      }
      requireValue(row.status === "rendering_html" && row.version === request.jobVersion &&
        row.attempt === request.attempt && row.input_hash === request.inputHash, "render_input_changed", 409);
      const input = parse(row.input_json);
      if (!this.previewInputStillCurrent(input, capability)) {
        return { row: this.discardStalePreview(row, request.attempt), stale: true };
      }
      const now = this.now();
      if (!stableError) {
        const expectedEquality = {
          bookId: input.manifest.bookId,
          versionId: input.manifest.versionId,
          title: input.manifest.title,
          manifestHash: input.manifest.manifestHash,
          authorizationSnapshotHash: input.manifest.authorizationSnapshotHash,
          authorizedMemoryTextSnapshotHash: input.manifest.authorizedMemoryTextSnapshotHash,
          assetSnapshotHash: input.manifest.assetSnapshotHash,
          pageCount: input.manifest.pages.length,
          orderedPageIds: input.manifest.pages.map((page) => page.pageId),
          orderedSourceIds: input.manifest.pages.map((page) => page.sourcePhotoId),
          orderedDisplayPhotoIds: input.manifest.pages.map((page) => page.displayPhotoId)
        };
        if (output.pageCount !== input.manifest.pages.length || output.htmlHash !== sha256(output.html) ||
          stableJson(output.equality) !== stableJson(expectedEquality)) stableError = "artifact_mismatch";
      }
      if (stableError) {
        const job = this.db.prepare(`UPDATE book_render_jobs SET status='failed',version=version+1,last_stable_error=?,
          lease_expires_at=NULL,updated_at=? WHERE id=?`).run(stableError, now, row.id);
        requireValue(job.changes === 1, "render_input_changed", 409);
        const draft = this.db.prepare(`UPDATE book_draft_versions SET status='preview_failed',version=version+1,
          updated_at=? WHERE id=? AND status='preview_queued' AND preview_worker_input_hash=?`).run(now,
        row.draft_version_id, row.input_hash);
        requireValue(draft.changes === 1, "render_input_changed", 409);
      } else {
        const htmlHash = output.htmlHash;
        const previewHash = sha256(stableJson({ inputHash: row.input_hash, htmlHash,
          pageCount: output.pageCount, htmlArtifactId: output.htmlArtifactId }));
        this.db.prepare(`INSERT INTO book_preview_artifacts(id,render_job_id,input_hash,html_blob,html_hash,
          page_count,created_at) VALUES(?,?,?,?,?,?,?)`).run(output.htmlArtifactId, row.id, row.input_hash,
        Buffer.from(output.html), htmlHash, output.pageCount, now);
        const job = this.db.prepare(`UPDATE book_render_jobs SET status='ready',version=version+1,preview_hash=?,page_count=?,
          html_artifact_id=?,html_hash=?,pdf_hash=NULL,last_stable_error=NULL,lease_expires_at=NULL,updated_at=?
          WHERE id=?`).run(previewHash, output.pageCount, output.htmlArtifactId, htmlHash, now, row.id);
        requireValue(job.changes === 1, "render_input_changed", 409);
        const draft = this.db.prepare(`UPDATE book_draft_versions SET status='preview_ready',version=version+1,
          updated_at=? WHERE id=? AND status='preview_queued' AND preview_worker_input_hash=?`).run(now,
        row.draft_version_id, row.input_hash);
        requireValue(draft.changes === 1, "render_input_changed", 409);
      }
      return { row: this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id), stale: false };
    });
    this.secureFiles();
    return this.previewProcessorResult(completed.row, completed.stale ? "discarded_stale" : completed.row.status);
  }

  pendingFrozenRenderJobs(renderWorkerSecret) {
    requireValue(this.renderWorkerSecret && sameSecret(renderWorkerSecret, this.renderWorkerSecret),
      "render_job_unavailable", 404);
    return this.db.prepare(`SELECT * FROM book_render_jobs WHERE book_version_id IS NOT NULL AND
      (status='queued' OR (status='rendering_html' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?))
      ORDER BY created_at,updated_at,rowid`).all(this.now()).map((row) => ({
      renderJobId: row.id,
      jobVersion: row.version,
      draftVersionId: row.draft_version_id,
      manifestHash: row.manifest_hash,
      grantSetHash: row.grant_set_hash,
      sourceSnapshotHash: row.source_snapshot_hash,
      authorizedMemoryTextSnapshotHash: row.authorized_text_snapshot_hash,
      assetSnapshotHash: row.asset_snapshot_hash,
      accessControlVersion: row.access_control_version,
      inputHash: row.input_hash,
      attempt: row.attempt + 1
    }));
  }

  frozenProcessorResult(row, status = row.status) {
    return {
      renderJobId: row.id,
      status,
      manifestHash: row.manifest_hash,
      authorizedMemoryTextSnapshotHash: row.authorized_text_snapshot_hash,
      assetSnapshotHash: row.asset_snapshot_hash,
      htmlHash: row.html_hash,
      pdfHash: row.pdf_hash,
      stableError: row.last_stable_error,
      version: row.version
    };
  }

  async processFrozenRender(request, renderWorkerSecret) {
    requireValue(this.renderWorkerSecret && sameSecret(renderWorkerSecret, this.renderWorkerSecret),
      "render_job_unavailable", 404);
    exactObject(request, ["renderJobId", "jobVersion", "draftVersionId", "manifestHash", "grantSetHash",
      "sourceSnapshotHash", "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "accessControlVersion",
      "inputHash", "attempt"]);
    id(request.renderJobId);
    positiveInteger(request.jobVersion);
    id(request.draftVersionId);
    for (const field of ["manifestHash", "grantSetHash", "sourceSnapshotHash",
      "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "inputHash"]) hash(request[field]);
    positiveInteger(request.accessControlVersion);
    positiveInteger(request.attempt);
    const before = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=? AND book_version_id IS NOT NULL")
      .get(request.renderJobId);
    let capability = null;
    let sourceDrift = false;
    if (before && !PREVIEW_TERMINAL.has(before.status)) {
      try { capability = await this.workerInputCapability(parse(before.input_json)); }
      catch (error) { sourceDrift = error instanceof BookLabError && error.code === "book_source_changed"; }
    }
    const claimed = transaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=? AND book_version_id IS NOT NULL")
        .get(request.renderJobId);
      requireValue(row, "render_job_unavailable", 404);
      for (const [field, column] of [["draftVersionId", "draft_version_id"], ["manifestHash", "manifest_hash"],
        ["grantSetHash", "grant_set_hash"], ["sourceSnapshotHash", "source_snapshot_hash"],
        ["authorizedMemoryTextSnapshotHash", "authorized_text_snapshot_hash"],
        ["assetSnapshotHash", "asset_snapshot_hash"], ["accessControlVersion", "access_control_version"],
        ["inputHash", "input_hash"]]) requireValue(request[field] === row[column], "render_input_changed", 409);
      if (PREVIEW_TERMINAL.has(row.status)) {
        requireValue((request.attempt === row.attempt ||
          row.status === "cancelled" && row.attempt === 0 && request.attempt === 1) &&
          (request.jobVersion === row.version - 1 || request.jobVersion === row.version - 2),
        "render_input_changed", 409);
        return { terminal: row };
      }
      const input = parse(row.input_json);
      if (sourceDrift) {
        const sourceIds = this.db.prepare(`SELECT photo_id FROM book_version_source_entries WHERE version_id=?`)
          .all(row.book_version_id).map((source) => source.photo_id);
        this.applySourceRevoked(sourceIds);
        return { terminal: this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id), stale: true };
      }
      const freshness = this.frozenInputStillCurrent(row, input, capability);
      if (!freshness.current) {
        if (freshness.revokedSourcePhotoIds.length > 0) {
          this.applySourceRevoked(freshness.revokedSourcePhotoIds);
          return { terminal: this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id), stale: true };
        }
        return { terminal: this.discardFrozenRender(row, request.attempt), stale: true };
      }
      if (row.status === "rendering_html" && request.attempt === row.attempt &&
        request.jobVersion === row.version - 1) return { row, input };
      requireValue(row.version === request.jobVersion && request.attempt === row.attempt + 1,
        "render_input_changed", 409);
      const expired = row.status === "rendering_html" && row.lease_expires_at && row.lease_expires_at <= this.now();
      requireValue(row.status === "queued" || expired, "render_input_changed", 409);
      const leaseExpiresAt = new Date(this.nowMs() + this.previewLeaseMs).toISOString();
      const changed = this.db.prepare(`UPDATE book_render_jobs SET status='rendering_html',version=version+1,
        attempt=?,lease_expires_at=?,last_stable_error=NULL,updated_at=? WHERE id=? AND version=?`).run(
      request.attempt, leaseExpiresAt, this.now(), row.id, row.version);
      requireValue(changed.changes === 1, "render_input_changed", 409);
      this.db.prepare(`UPDATE render_artifacts SET status='rendering_html',updated_at=?
        WHERE render_job_id=? AND format='html' AND status='queued'`).run(this.now(), row.id);
      return { row: this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id), input };
    });
    if (claimed.terminal) return this.frozenProcessorResult(claimed.terminal,
      claimed.stale ? "discarded_stale" : claimed.terminal.status);
    return { renderJobId: claimed.row.id, status: "claimed", version: claimed.row.version,
      input: deepFreeze(structuredClone(claimed.input)) };
  }

  async completeFrozenRender(request, output, renderWorkerSecret) {
    requireValue(this.renderWorkerSecret && sameSecret(renderWorkerSecret, this.renderWorkerSecret),
      "render_job_unavailable", 404);
    exactObject(request, ["renderJobId", "jobVersion", "inputHash", "attempt"]);
    id(request.renderJobId);
    positiveInteger(request.jobVersion);
    hash(request.inputHash);
    positiveInteger(request.attempt);
    let stableError = null;
    let pdfBytes = null;
    try {
      exactObject(output, ["status"], ["html", "htmlHash", "pdfBase64", "pdfHash", "pageCount", "equality",
        "stableError"]);
      requireValue(["ready", "failed"].includes(output.status), "render_failed", 503);
      if (output.status === "failed") {
        requireValue(Object.keys(output).length === 2 &&
          ["render_failed", "artifact_mismatch"].includes(output.stableError), "render_failed", 503);
        stableError = output.stableError;
      } else {
        requireValue(Object.keys(output).length === 7 && output.stableError === undefined,
          "artifact_mismatch", 409);
        requireValue(typeof output.html === "string" && Buffer.byteLength(output.html) >= 1 &&
          Buffer.byteLength(output.html) <= MAX_PREVIEW_HTML_BYTES && safeSelfContainedHtml(output.html),
        "artifact_mismatch", 409);
        hash(output.htmlHash);
        hash(output.pdfHash);
        requireValue(typeof output.pdfBase64 === "string" && output.pdfBase64.length >= 1,
          "artifact_mismatch", 409);
        pdfBytes = Buffer.from(output.pdfBase64, "base64");
        requireValue(pdfBytes.length >= 5 && pdfBytes.length <= MAX_FROZEN_PDF_BYTES &&
          pdfBytes.toString("base64") === output.pdfBase64 && pdfBytes.subarray(0, 5).toString() === "%PDF-",
        "artifact_mismatch", 409);
        requireValue(Number.isSafeInteger(output.pageCount) && output.pageCount >= 12 && output.pageCount <= 16,
          "artifact_mismatch", 409);
        exactObject(output.equality, ["bookId", "versionId", "title", "manifestHash",
          "authorizationSnapshotHash", "authorizedMemoryTextSnapshotHash", "assetSnapshotHash", "pageCount",
          "orderedPageIds", "orderedSourceIds", "orderedDisplayPhotoIds"]);
      }
    } catch (error) {
      stableError = error instanceof BookLabError && error.code === "artifact_mismatch"
        ? "artifact_mismatch" : "render_failed";
    }
    const before = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=? AND book_version_id IS NOT NULL")
      .get(request.renderJobId);
    let capability = null;
    let sourceDrift = false;
    if (before && !PREVIEW_TERMINAL.has(before.status)) {
      try { capability = await this.workerInputCapability(parse(before.input_json)); }
      catch (error) { sourceDrift = error instanceof BookLabError && error.code === "book_source_changed"; }
    }
    const completed = transaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM book_render_jobs WHERE id=? AND book_version_id IS NOT NULL")
        .get(request.renderJobId);
      requireValue(row, "render_job_unavailable", 404);
      if (PREVIEW_TERMINAL.has(row.status)) {
        requireValue(row.input_hash === request.inputHash && row.attempt === request.attempt &&
          row.version === request.jobVersion + 1, "render_input_changed", 409);
        return { row, stale: row.status === "cancelled" };
      }
      requireValue(row.status === "rendering_html" && row.version === request.jobVersion &&
        row.attempt === request.attempt && row.input_hash === request.inputHash, "render_input_changed", 409);
      const input = parse(row.input_json);
      if (sourceDrift) {
        const sourceIds = this.db.prepare(`SELECT photo_id FROM book_version_source_entries WHERE version_id=?`)
          .all(row.book_version_id).map((source) => source.photo_id);
        this.applySourceRevoked(sourceIds);
        return { row: this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id), stale: true };
      }
      const freshness = this.frozenInputStillCurrent(row, input, capability);
      if (!freshness.current) {
        if (freshness.revokedSourcePhotoIds.length > 0) {
          this.applySourceRevoked(freshness.revokedSourcePhotoIds);
          return { row: this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id), stale: true };
        }
        return { row: this.discardFrozenRender(row, request.attempt), stale: true };
      }
      const now = this.now();
      if (!stableError) {
        const expectedEquality = {
          bookId: input.manifest.bookId,
          versionId: input.manifest.versionId,
          title: input.manifest.title,
          manifestHash: input.manifest.manifestHash,
          authorizationSnapshotHash: input.manifest.authorizationSnapshotHash,
          authorizedMemoryTextSnapshotHash: input.manifest.authorizedMemoryTextSnapshotHash,
          assetSnapshotHash: input.manifest.assetSnapshotHash,
          pageCount: input.manifest.pages.length,
          orderedPageIds: input.manifest.pages.map((page) => page.pageId),
          orderedSourceIds: input.manifest.pages.map((page) => page.sourcePhotoId),
          orderedDisplayPhotoIds: input.manifest.pages.map((page) => page.displayPhotoId)
        };
        if (output.pageCount !== input.manifest.pages.length || output.htmlHash !== sha256(output.html) ||
          output.pdfHash !== sha256(pdfBytes) || stableJson(output.equality) !== stableJson(expectedEquality)) {
          stableError = "artifact_mismatch";
        }
      }
      if (stableError) {
        this.db.prepare(`UPDATE book_render_jobs SET status='failed',version=version+1,last_stable_error=?,
          lease_expires_at=NULL,updated_at=? WHERE id=?`).run(stableError, now, row.id);
        this.db.prepare(`UPDATE book_versions SET status='render_failed' WHERE id=? AND status='rendering'`)
          .run(row.book_version_id);
        this.db.prepare(`UPDATE render_artifacts SET status='failed',content_blob=NULL,content_hash=NULL,
          page_count=NULL,updated_at=? WHERE render_job_id=?`).run(now, row.id);
        this.bookEvent(row.book_id, "RENDER_FAILED", "render_worker", "book-lab-render-worker",
          { versionId: row.book_version_id, renderJobId: row.id, stableError });
      } else {
        const artifacts = this.db.prepare(`SELECT id,format FROM render_artifacts WHERE render_job_id=?`)
          .all(row.id);
        requireValue(artifacts.length === 2, "artifact_mismatch", 409);
        for (const artifact of artifacts) {
          const bytes = artifact.format === "html" ? Buffer.from(output.html) : pdfBytes;
          const contentHash = artifact.format === "html" ? output.htmlHash : output.pdfHash;
          this.db.prepare(`UPDATE render_artifacts SET status='available',content_blob=?,content_hash=?,
            page_count=?,updated_at=? WHERE id=?`).run(bytes, contentHash, output.pageCount, now, artifact.id);
        }
        const htmlArtifactId = artifacts.find((artifact) => artifact.format === "html").id;
        this.db.prepare(`UPDATE book_render_jobs SET status='ready',version=version+1,page_count=?,
          html_artifact_id=?,html_hash=?,pdf_hash=?,last_stable_error=NULL,lease_expires_at=NULL,updated_at=?
          WHERE id=?`).run(output.pageCount, htmlArtifactId, output.htmlHash, output.pdfHash, now, row.id);
        const available = this.db.prepare(`UPDATE book_versions SET status='available' WHERE id=?
          AND status='rendering'`).run(row.book_version_id);
        requireValue(available.changes === 1, "book_version_unavailable", 409);
        this.bookEvent(row.book_id, "HTML_AND_PDF_VERIFIED", "render_worker", "book-lab-render-worker",
          { versionId: row.book_version_id, renderJobId: row.id, htmlHash: output.htmlHash,
            pdfHash: output.pdfHash, pageCount: output.pageCount });
        this.bookEvent(row.book_id, "ARTIFACTS_VERIFIED", "render_worker", "book-lab-render-worker",
          { versionId: row.book_version_id, renderJobId: row.id });
      }
      return { row: this.db.prepare("SELECT * FROM book_render_jobs WHERE id=?").get(row.id), stale: false };
    });
    this.secureFiles();
    return this.frozenProcessorResult(completed.row,
      completed.stale ? "discarded_stale" : completed.row.status);
  }

  pendingQuestionJobs(workerSecret) {
    requireValue(sameSecret(workerSecret, this.workerSecret), "question_job_unavailable", 404);
    return this.db.prepare(`SELECT j.id,j.version,j.kind,j.input_hash,j.attempt FROM memory_question_jobs j
      JOIN memory_model_fact_drafts f ON f.question_job_id=j.id AND f.status='pending'
      WHERE (j.status='queued' AND (f.retry_after_at IS NULL OR f.retry_after_at<=?)) OR
        (j.status='running' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at<=?)
      ORDER BY j.created_at,j.updated_at,j.rowid`).all(this.now(), this.now()).map((row) => ({
        jobId: row.id, jobVersion: row.version, kind: row.kind,
        inputHash: row.input_hash, attempt: row.attempt + 1 }));
  }

  privateAiAuthorizationSnapshot(job, factDraft) {
    requireValue(job && factDraft && factDraft.question_job_id === job.id &&
      factDraft.personal_memory_id === job.personal_memory_id && factDraft.input_hash === job.input_hash &&
      SHA256.test(factDraft.binding_hash) && SHA256.test(factDraft.photo_content_hash) &&
      SHA256.test(factDraft.placement_snapshot_hash), "question_input_changed", 409);
    return sha256(stableJson({ schema: PRIVATE_AI_AUTHORIZATION_SCHEMA, jobId: job.id,
      inputHash: job.input_hash, photoId: factDraft.photo_id, photoContentHash: factDraft.photo_content_hash,
      placementSnapshotHash: factDraft.placement_snapshot_hash, bindingHash: factDraft.binding_hash }));
  }

  privateAiQuestionContext(job) {
    if (job.kind === "initial_question") return Object.freeze({ kind: "initial_question" });
    requireValue(job.kind === "followup_question" && Number.isSafeInteger(job.followup_ordinal) &&
      job.followup_ordinal >= 1 && job.followup_ordinal <= this.followupLimit,
    "question_input_changed", 409);
    const submission = this.db.prepare(`SELECT id,user_text,submission_hash FROM answer_submissions
      WHERE id=? AND personal_memory_id=?`).get(job.source_submission_id, job.personal_memory_id);
    requireValue(submission && submission.submission_hash === job.source_submission_hash,
      "question_input_changed", 409);
    const prior = this.db.prepare(`SELECT j.question,f.model_visible_facts_json FROM memory_question_jobs j
      JOIN memory_model_fact_drafts f ON f.question_job_id=j.id WHERE j.personal_memory_id=? AND j.status='ready'
      AND (j.created_at<? OR (j.created_at=? AND j.rowid<?)) ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1`)
      .get(job.personal_memory_id, job.created_at, job.created_at, job.question_rowid);
    let priorVisibleFacts;
    try { priorVisibleFacts = parse(prior?.model_visible_facts_json); } catch { priorVisibleFacts = null; }
    requireValue(typeof prior?.question === "string" && prior.question.length >= 2 &&
      Array.isArray(priorVisibleFacts) && priorVisibleFacts.length >= 1 && priorVisibleFacts.length <= 2 &&
      priorVisibleFacts.every((fact) => typeof fact === "string" && fact.length >= 2 && fact.length <= 160),
    "question_input_changed", 409);
    return Object.freeze({
      kind: "followup_question",
      followupOrdinal: job.followup_ordinal,
      followupLimit: this.followupLimit,
      priorVisibleFacts: Object.freeze([...priorVisibleFacts]),
      priorQuestion: prior.question,
      userAnswerText: submission.user_text.slice(0, FOLLOWUP_CONTEXT_MAX_CHARS)
    });
  }

  privateAiCompositionIntents(workerSecret) {
    requireValue(sameSecret(workerSecret, this.workerSecret), "question_job_unavailable", 404);
    const authorize = [];
    const revoke = [];
    const pending = new Map(this.pendingQuestionJobs(workerSecret).map((request) => [request.jobId, request]));
    const rows = this.db.prepare(`SELECT j.*,j.rowid question_rowid FROM memory_question_jobs j
      JOIN memory_model_fact_drafts f ON f.question_job_id=j.id
      ORDER BY j.created_at,j.rowid`).all();
    for (const job of rows) {
      const factDraft = this.db.prepare("SELECT * FROM memory_model_fact_drafts WHERE question_job_id=?").get(job.id);
      const authorizationSnapshotHash = this.privateAiAuthorizationSnapshot(job, factDraft);
      const intent = Object.freeze({ photoId: factDraft.photo_id, authorizationSnapshotHash });
      const request = pending.get(job.id);
      if (request) authorize.push(Object.freeze({ ...intent, questionProcessorRequest: Object.freeze(request),
        questionContext: this.privateAiQuestionContext(job) }));
      else if (job.status === "cancelled" || factDraft.status === "withdrawn") revoke.push(intent);
    }
    return Object.freeze({ authorize: Object.freeze(authorize), revoke: Object.freeze(revoke) });
  }

  revokePrivateQuestionSources(revocations, workerSecret) {
    requireValue(sameSecret(workerSecret, this.workerSecret), "question_job_unavailable", 404);
    requireValue(Array.isArray(revocations) && revocations.length <= 1_000, "question_job_unavailable", 404);
    const requested = new Map();
    for (const value of revocations) {
      requireValue(value && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).sort().join("\0") === "authorizationSnapshotHash\0photoId" &&
        typeof value.photoId === "string" && value.photoId.length >= 1 && value.photoId.length <= 200 &&
        SHA256.test(value.authorizationSnapshotHash), "question_job_unavailable", 404);
      requested.set(`${value.photoId}\0${value.authorizationSnapshotHash}`, value);
    }
    return transaction(this.db, () => {
      let revokedCount = 0;
      const now = this.now();
      const jobs = this.db.prepare(`SELECT j.* FROM memory_question_jobs j
        JOIN memory_model_fact_drafts f ON f.question_job_id=j.id AND f.status!='withdrawn'
        ORDER BY j.created_at,j.rowid`).all();
      for (const job of jobs) {
        const factDraft = this.db.prepare("SELECT * FROM memory_model_fact_drafts WHERE question_job_id=?").get(job.id);
        const authorizationSnapshotHash = this.privateAiAuthorizationSnapshot(job, factDraft);
        if (!requested.has(`${factDraft.photo_id}\0${authorizationSnapshotHash}`)) continue;
        const updated = this.db.prepare(`UPDATE memory_question_jobs SET status='cancelled',version=version+1,
          question=NULL,question_hash=NULL,model_version=NULL,provenance_json=NULL,
          last_stable_error='question_source_revoked',lease_expires_at=NULL,updated_at=?
          WHERE id=? AND version=? AND input_hash=?`).run(now, job.id, job.version, job.input_hash);
        if (updated.changes !== 1) continue;
        const currentJob = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(job.id);
        this.db.prepare("DELETE FROM memory_model_fact_answer_links WHERE fact_draft_id=?").run(factDraft.id);
        this.transitionPrivateFact(factDraft, "withdrawn", { job_version: currentJob.version,
          model_visible_facts_json: null, facts_hash: null, question_hash: null, provider_result_hash: null,
          provider_latency_ms: null, lease_expires_at: null, retry_after_at: null,
          last_stable_error: "question_source_revoked" },
        { event: "FACT_SOURCE_REVOKED", reason: "source_revoked" });
        const interview = this.db.prepare("SELECT * FROM memory_interviews WHERE personal_memory_id=?")
          .get(job.personal_memory_id);
        if (interview && !["confirmed", "skipped", "withdrawal_pending", "withdrawn"].includes(interview.status)) {
          this.db.prepare(`UPDATE memory_interviews SET status='question_failed',version=version+1,updated_at=?
            WHERE personal_memory_id=? AND version=?`).run(now, interview.personal_memory_id, interview.version);
        }
        const currentInterview = this.db.prepare("SELECT * FROM memory_interviews WHERE personal_memory_id=?")
          .get(job.personal_memory_id);
        this.systemEvent(job.personal_memory_id, "QUESTION_SOURCE_REVOKED", currentInterview.version,
          "private_ai_composition", "book-lab-private-ai-composition", { jobId: job.id });
        revokedCount += 1;
      }
      return Object.freeze({ requestedCount: requested.size, revokedCount });
    });
  }

  async reconcilePrivateQuestionSources(workerSecret) {
    requireValue(sameSecret(workerSecret, this.workerSecret), "question_job_unavailable", 404);
    const revocations = [];
    const rows = this.db.prepare(`SELECT j.* FROM memory_question_jobs j
      JOIN memory_model_fact_drafts f ON f.question_job_id=j.id AND f.status!='withdrawn'
      ORDER BY j.created_at,j.rowid`).all();
    for (const job of rows) {
      const factDraft = this.db.prepare("SELECT * FROM memory_model_fact_drafts WHERE question_job_id=?").get(job.id);
      const memory = this.questionMemory(job);
      let photo = null;
      try { photo = await Promise.resolve(this.readQuestionSourceForWorker(memory)); } catch { /* stale */ }
      let source = null;
      try { source = frozenPhotoSource(photo); } catch { /* stale */ }
      if (sourceEligible(source) && source.photoId === factDraft.photo_id &&
        source.provenance.photoContentHash === factDraft.photo_content_hash &&
        source.provenance.placementRevisionId === factDraft.placement_revision_id &&
        source.provenance.placementSnapshotHash === factDraft.placement_snapshot_hash) continue;
      revocations.push(Object.freeze({ photoId: factDraft.photo_id,
        authorizationSnapshotHash: this.privateAiAuthorizationSnapshot(job, factDraft) }));
    }
    const result = this.revokePrivateQuestionSources(revocations, workerSecret);
    return Object.freeze({ scannedCount: rows.length, ...result, revocations: Object.freeze(revocations) });
  }

  questionMemory(job) {
    return this.db.prepare(`SELECT p.*,i.status interview_status,i.version interview_version,i.provenance_json
      FROM personal_memories p JOIN memory_interviews i ON i.personal_memory_id=p.id WHERE p.id=?`)
      .get(job.personal_memory_id) ?? null;
  }

  readQuestionSourceForWorker(memory) {
    requireValue(typeof this.core.readQuestionSourceForWorker === "function",
      "question_source_port_unavailable", 503);
    return this.core.readQuestionSourceForWorker({ photoId: memory.photo_id,
      contributorId: memory.contributor_id });
  }

  questionInputCurrent(job, memory, queuedInput, photo) {
    if (!this.questionProviderConfigured || typeof this.questionProvider !== "function" || !queuedInput ||
      queuedInput.kind !== job.kind || sha256(stableJson(queuedInput)) !== job.input_hash ||
      queuedInput.providerModel !== this.providerModel || queuedInput.modelVersion !== this.modelVersion ||
      queuedInput.promptHash !== this.promptHash ||
      queuedInput.policyHash !== this.policyHash) return { current: false, terminalStatus: "failed" };
    if (!photo) return { current: false, terminalStatus: "cancelled" };
    let source;
    try { source = frozenPhotoSource(photo); }
    catch { return { current: false, terminalStatus: "failed" }; }
    if (!sourceEligible(source)) return { current: false, terminalStatus: "cancelled" };
    if (stableJson(source) !== stableJson(queuedInput.source)) {
      return { current: false, terminalStatus: "failed" };
    }
    if (job.kind === "followup_question" && job.source_memory_version !== memory.version) {
      return { current: false, terminalStatus: "failed" };
    }
    const submission = job.source_submission_id
      ? this.db.prepare("SELECT * FROM answer_submissions WHERE id=? AND personal_memory_id=?")
        .get(job.source_submission_id, memory.id)
      : null;
    if (job.kind === "followup_question" && submission?.submission_hash !== job.source_submission_hash) {
      return { current: false, terminalStatus: "failed" };
    }
    return { current: true, source, userText: submission?.user_text ?? "" };
  }

  retryQuestionJob({ job, memory, queuedInput, attempt, stableError }) {
    requireValue(stableError === "model_unavailable", "internal_error", 500);
    const factDraft = this.assertPrivateFactBinding(this.db.prepare(
      "SELECT * FROM memory_model_fact_drafts WHERE question_job_id=?").get(job.id), job, queuedInput);
    requireValue(factDraft.status === "pending" && factDraft.job_version === job.version &&
      factDraft.attempt === attempt, "question_input_changed", 409);
    const now = this.now();
    const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
    const retryAfterAt = new Date(this.nowMs() + retryDelayMs).toISOString();
    const changed = this.db.prepare(`UPDATE memory_question_jobs SET status='queued',version=version+1,
      last_stable_error=?,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND version=?
      AND attempt=?`).run(stableError, now, job.id, job.version, attempt);
    requireValue(changed.changes === 1, "question_input_changed", 409);
    const currentJob = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(job.id);
    this.transitionPrivateFact(factDraft, "pending", { job_version: currentJob.version, attempt,
      lease_expires_at: null, retry_after_at: retryAfterAt, last_stable_error: stableError },
    { event: "FACT_DRAFT_RETRY_QUEUED", retryDelayMs });
    this.systemEvent(memory.id, job.kind === "initial_question" ? "QUESTION_RETRY_QUEUED" :
      "FOLLOWUP_RETRY_QUEUED", memory.interview_version, "question_worker", "book-lab-question-worker",
    { jobId: job.id, stableError, retryAfterAt });
    return { retryError: stableError };
  }

  finishQuestionJob({ job, memory, queuedInput, attempt, generated = null, providerResult = null,
    stableError = null, terminalStatus = stableError ? "failed" : "ready" }) {
    const now = this.now();
    const nextInterview = stableError ? (job.kind === "initial_question" ? "question_failed" : "draft")
      : (job.kind === "initial_question" ? "question_ready" : "followup_ready");
    let questionHash = null;
    let questionProvenance = null;
    const factDraft = this.assertPrivateFactBinding(this.db.prepare(
      "SELECT * FROM memory_model_fact_drafts WHERE question_job_id=?").get(job.id), job, queuedInput);
    requireValue(factDraft.status === "pending" && factDraft.job_version === job.version &&
      [attempt - 1, attempt].includes(factDraft.attempt), "question_input_changed", 409);
    if (!stableError) {
      requireValue(providerResult && generated === providerResult.question, "question_policy_rejected", 409);
      questionHash = sha256(generated);
      questionProvenance = {
        questionId: randomUUID(),
        kind: job.kind,
        question: generated,
        questionHash,
        modelVersion: providerResult.modelVersion,
        promptHash: queuedInput.promptHash,
        policyHash: queuedInput.policyHash,
        sourcePhotoId: memory.photo_id,
        photoContentHash: queuedInput.source.provenance.photoContentHash,
        placementRevisionId: queuedInput.source.provenance.placementRevisionId,
        generatedAt: now
      };
    }
    const changed = this.db.prepare(`UPDATE memory_question_jobs SET status=?,version=version+1,attempt=?,
      question=?,question_hash=?,model_version=?,provenance_json=?,last_stable_error=?,lease_expires_at=NULL,
      updated_at=? WHERE id=? AND version=? AND status=? AND attempt=?`).run(terminalStatus, attempt,
    stableError ? null : generated, questionHash, stableError ? null : queuedInput.modelVersion,
    questionProvenance ? json(questionProvenance) : null, stableError, now, job.id, job.version, job.status,
    job.attempt);
    requireValue(changed.changes === 1, "question_input_changed", 409);
    const interview = this.db.prepare(`UPDATE memory_interviews SET status=?,version=version+1,updated_at=?
      WHERE personal_memory_id=? AND status=? AND version=?`).run(nextInterview, now, memory.id,
    memory.interview_status, memory.interview_version);
    requireValue(interview.changes === 1, "question_input_changed", 409);
    const currentJob = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(job.id);
    const currentInterview = this.db.prepare("SELECT * FROM memory_interviews WHERE personal_memory_id=?")
      .get(memory.id);
    if (stableError) {
      this.transitionPrivateFact(factDraft, "pending", { job_version: currentJob.version, attempt,
        lease_expires_at: null, retry_after_at: null, last_stable_error: stableError },
      { event: "FACT_DRAFT_TERMINAL", stableError });
    } else {
      const factsHash = sha256(stableJson(providerResult.modelVisibleFacts));
      const providerResultHash = sha256(stableJson(providerResult));
      const draftReady = this.transitionPrivateFact(factDraft, "draft_ready", {
        job_version: currentJob.version,
        attempt,
        model_visible_facts_json: json(providerResult.modelVisibleFacts),
        facts_hash: factsHash,
        question_hash: questionHash,
        provider_result_hash: providerResultHash,
        provider_latency_ms: providerResult.latencyMs,
        lease_expires_at: null,
        retry_after_at: null,
        last_stable_error: null
      }, { event: "FACT_DRAFT_READY", factsHash, providerResultHash });
      this.transitionPrivateFact(draftReady, "question_ready", {},
        { event: "FACT_QUESTION_READY", questionHash });
    }
    this.systemEvent(memory.id, stableError ? (job.kind === "initial_question" ? "QUESTION_FAILED" : "FOLLOWUP_FAILED")
      : (job.kind === "initial_question" ? "QUESTION_READY" : "FOLLOWUP_READY"), currentInterview.version,
    "question_worker", "book-lab-question-worker", { jobId: job.id, status: currentJob.status,
      stableError: currentJob.last_stable_error });
    return this.questionProcessorResult(currentJob);
  }

  claimQuestion(request, photo) {
    return transaction(this.db, () => {
      const job = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(request.jobId);
      requireValue(job && job.kind === request.kind, "question_job_unavailable", 404);
      requireValue(job.input_hash === request.inputHash, "question_input_changed", 409);
      if (JOB_TERMINAL.has(job.status)) {
        requireValue(request.attempt === job.attempt ||
          job.status === "cancelled" && job.attempt === 0 && request.attempt === 1,
        "question_input_changed", 409);
        return { terminal: this.questionProcessorResult(job) };
      }
      requireValue(job.version === request.jobVersion && request.attempt === job.attempt + 1,
        "question_input_changed", 409);
      const expired = job.status === "running" && job.lease_expires_at && job.lease_expires_at <= this.now();
      requireValue(job.status === "queued" || expired, "question_input_changed", 409);
      const memory = this.questionMemory(job);
      requireValue(memory && !this.db.prepare("SELECT 1 FROM memory_denials WHERE personal_memory_id=?")
        .get(job.personal_memory_id), "question_job_unavailable", 404);
      const expectedStatus = job.kind === "initial_question" ? "question_queued" : "followup_queued";
      requireValue(memory.interview_status === expectedStatus, "question_input_changed", 409);
      const queuedInput = parse(job.provenance_json)?.queuedInput ?? null;
      const currentness = this.questionInputCurrent(job, memory, queuedInput, photo);
      if (!currentness.current) {
        return { terminal: this.finishQuestionJob({ job, memory, queuedInput, attempt: request.attempt,
          stableError: "question_input_changed", terminalStatus: currentness.terminalStatus }) };
      }
      const leaseExpiresAt = new Date(this.nowMs() + this.questionLeaseMs).toISOString();
      const changed = this.db.prepare(`UPDATE memory_question_jobs SET status='running',version=version+1,
        attempt=?,lease_expires_at=?,last_stable_error=NULL,updated_at=?
        WHERE id=? AND version=? AND status=? AND attempt=?`).run(request.attempt, leaseExpiresAt, this.now(),
      job.id, job.version, job.status, job.attempt);
      requireValue(changed.changes === 1, "question_input_changed", 409);
      const currentJob = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(job.id);
      const factDraft = this.leasePrivateFact(currentJob, queuedInput, request.attempt, leaseExpiresAt);
      return { row: currentJob, factDraft, memory, queuedInput, source: currentness.source,
        userText: currentness.userText };
    });
  }

  questionProviderOutcome(claim, supplied) {
    try {
      const providerResult = this.validatePrivateProviderOutcome(claim.row.kind, supplied);
      return { generated: providerResult.question, providerResult, stableError: null };
    } catch (error) {
      return { generated: null,
        stableError: error instanceof BookLabError ? error.code : "model_unavailable" };
    }
  }

  invokeQuestionProvider(claim) {
    const controller = new AbortController();
    const input = Object.freeze({
      jobId: claim.row.id,
      attempt: claim.row.attempt,
      inputHash: claim.row.input_hash,
      idempotencyKey: sha256(stableJson([claim.row.id, claim.row.input_hash, claim.row.attempt])),
      kind: claim.row.kind,
      visibleFacts: deepFreeze(structuredClone(claim.source.visibleFacts)),
      userText: claim.userText,
      sourcePhotoId: claim.source.photoId,
      photoContentHash: claim.source.provenance.photoContentHash,
      placementRevisionId: claim.source.provenance.placementRevisionId,
      placementSnapshotHash: claim.source.provenance.placementSnapshotHash,
      model: this.providerModel,
      modelVersion: this.modelVersion,
      promptHash: this.promptHash,
      policyHash: this.policyHash,
      signal: controller.signal
    });
    let supplied;
    try { supplied = this.questionProvider(input); }
    catch { return { generated: null, stableError: "model_unavailable" }; }
    let then;
    try { then = supplied?.then; }
    catch { return { generated: null, stableError: "model_unavailable" }; }
    if (typeof then !== "function") return this.questionProviderOutcome(claim, supplied);
    let timer;
    let cancel;
    const timeout = new Promise((_, reject) => {
      cancel = () => {
        controller.abort();
        reject(new BookLabError("model_unavailable", 503));
      };
      timer = setTimeout(cancel, this.questionProviderTimeoutMs);
    });
    const operation = { cancel, timer };
    this.questionOperations.add(operation);
    return Promise.race([Promise.resolve(supplied), timeout])
      .then((output) => this.questionProviderOutcome(claim, output),
        () => ({ generated: null, stableError: "model_unavailable" }))
      .finally(() => {
        clearTimeout(timer);
        this.questionOperations.delete(operation);
      });
  }

  completeQuestion(request, claim, outcome, photo) {
    return transaction(this.db, () => {
      const job = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(request.jobId);
      requireValue(job && job.kind === request.kind && job.input_hash === request.inputHash &&
        job.status === "running" && job.version === claim.row.version && job.attempt === request.attempt,
      "question_input_changed", 409);
      const memory = this.questionMemory(job);
      requireValue(memory && !this.db.prepare("SELECT 1 FROM memory_denials WHERE personal_memory_id=?")
        .get(job.personal_memory_id), "question_input_changed", 409);
      const expectedStatus = job.kind === "initial_question" ? "question_queued" : "followup_queued";
      requireValue(memory.interview_status === expectedStatus, "question_input_changed", 409);
      const queuedInput = parse(job.provenance_json)?.queuedInput ?? null;
      const currentness = this.questionInputCurrent(job, memory, queuedInput, photo);
      if (!currentness.current) {
        return this.finishQuestionJob({ job, memory, queuedInput, attempt: request.attempt,
          stableError: "question_input_changed", terminalStatus: currentness.terminalStatus });
      }
      if (outcome.stableError === "model_unavailable") {
        return this.retryQuestionJob({ job, memory, queuedInput, attempt: request.attempt,
          stableError: outcome.stableError });
      }
      return this.finishQuestionJob({ job, memory, queuedInput, attempt: request.attempt,
        generated: outcome.generated, providerResult: outcome.providerResult, stableError: outcome.stableError });
    });
  }

  processQuestionWithOutcome(request, workerSecret, outcomeForClaim) {
    requireValue(sameSecret(workerSecret, this.workerSecret), "question_job_unavailable", 404);
    requireValue(typeof outcomeForClaim === "function", "question_job_unavailable", 404);
    exactObject(request, ["jobId", "jobVersion", "kind", "inputHash", "attempt"]);
    id(request.jobId);
    positiveInteger(request.jobVersion);
    requireValue(["initial_question", "followup_question"].includes(request.kind), "question_job_unavailable", 404);
    hash(request.inputHash);
    positiveInteger(request.attempt);
    const before = this.db.prepare("SELECT * FROM memory_question_jobs WHERE id=?").get(request.jobId);
    requireValue(before && before.kind === request.kind, "question_job_unavailable", 404);
    requireValue(before.input_hash === request.inputHash, "question_input_changed", 409);
    if (before.status === "queued" && before.last_stable_error === "model_unavailable" &&
      request.attempt === before.attempt && request.jobVersion === before.version - 2) {
      fail("model_unavailable", 503);
    }
    if (JOB_TERMINAL.has(before.status)) {
      requireValue(request.attempt === before.attempt ||
        before.status === "cancelled" && before.attempt === 0 && request.attempt === 1,
      "question_input_changed", 409);
      return this.questionProcessorResult(before);
    }
    const memory = this.questionMemory(before);
    requireValue(memory, "question_job_unavailable", 404);
    let firstRead;
    try { firstRead = this.readQuestionSourceForWorker(memory); }
    catch (error) {
      if (error instanceof BookLabError) throw error;
      firstRead = null;
    }
    const run = (photo) => {
      const claim = this.claimQuestion(request, photo);
      if (claim.terminal) {
        this.secureFiles();
        return claim.terminal;
      }
      const complete = (outcome) => {
        requireValue(!this.closed, "question_input_changed", 409);
        let secondRead;
        try { secondRead = this.readQuestionSourceForWorker(claim.memory); }
        catch (error) {
          if (error instanceof BookLabError) throw error;
          secondRead = null;
        }
        const finish = (currentPhoto) => {
          const result = this.completeQuestion(request, claim, outcome, currentPhoto);
          this.secureFiles();
          if (result.retryError) fail(result.retryError, 503);
          return result;
        };
        let then;
        try { then = secondRead?.then; }
        catch { return finish(null); }
        return typeof then === "function" ? Promise.resolve(secondRead).then(finish, () => finish(null))
          : finish(secondRead);
      };
      let outcome;
      try { outcome = outcomeForClaim(claim); }
      catch { outcome = { generated: null, stableError: "model_unavailable" }; }
      let then;
      try { then = outcome?.then; }
      catch { return complete({ generated: null, stableError: "model_unavailable" }); }
      return typeof then === "function" ? Promise.resolve(outcome).then(complete) : complete(outcome);
    };
    let then;
    try { then = firstRead?.then; }
    catch { return run(null); }
    return typeof then === "function" ? Promise.resolve(firstRead).then(run, () => run(null)) : run(firstRead);
  }

  processQuestion(request, workerSecret) {
    return this.processQuestionWithOutcome(request, workerSecret, (claim) => this.invokeQuestionProvider(claim));
  }

  ingestPrivateQuestionResult(request, providerResult, workerSecret) {
    return this.processQuestionWithOutcome(request, workerSecret,
      (claim) => this.questionProviderOutcome(claim, providerResult));
  }

  recordQuestionProviderUnavailable(request, workerSecret) {
    return this.processQuestionWithOutcome(request, workerSecret,
      () => ({ generated: null, stableError: "model_unavailable" }));
  }

  questionProcessorResult(job) {
    return {
      jobId: job.id,
      status: job.status,
      question: job.question,
      questionHash: job.question_hash,
      modelVersion: job.model_version,
      questionProvenance: job.status === "ready" ? parse(job.provenance_json) : null,
      stableError: job.last_stable_error,
      version: job.version
    };
  }

  async handle(request) {
    const method = String(request.method ?? "GET").toUpperCase();
    const pathValue = String(request.path ?? request.url ?? "/");
    const pathname = new URL(pathValue, "http://book-lab.local").pathname;
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    try {
      const ctx = { method, path: pathname, headers, body: request.body ?? {}, principal: null };
      let match;
      if (method === "GET" && (match = pathname.match(/^\/v2-labs\/owner\/spaces\/([^/]+)\/book-lab$/))) {
        return await this.openBookLab(ctx, decodeURIComponent(match[1]));
      }
      if (method === "POST" && (match = pathname.match(/^\/v2-labs\/owner\/spaces\/([^/]+)\/books$/))) {
        return this.createBook(ctx, decodeURIComponent(match[1]));
      }
      if (method === "GET" && (match = pathname.match(/^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/draft$/))) {
        return await this.openBookDraft(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      if (method === "POST" && (match = pathname.match(
        /^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/render-jobs$/))) {
        return await this.generateBookPreview(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      if (method === "POST" && (match = pathname.match(
        /^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/versions$/))) {
        return await this.freezeBook(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      if (method === "POST" && (match = pathname.match(
        /^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/draft-versions$/))) {
        return await this.startNewBookVersion(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      if (method === "PATCH" && (match = pathname.match(
        /^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/title$/))) {
        return await this.editBookTitle(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      if (method === "POST" && (match = pathname.match(
        /^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/draft\/pages\/([^/]+)\/removals$/))) {
        return await this.removeBookPage(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]),
          decodeURIComponent(match[3]));
      }
      if (method === "PUT" && (match = pathname.match(
        /^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/draft\/pages\/([^/]+)\/photo$/))) {
        return await this.replaceBookPagePhoto(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]),
          decodeURIComponent(match[3]));
      }
      if (method === "GET" && (match = pathname.match(/^\/v2-labs\/live\/spaces\/([^/]+)\/books\/([^/]+)\/versions\/([^/]+)\/html$/))) {
        const result = await this.readCanonicalHtmlForUi(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]), decodeURIComponent(match[3]));
        return { status: 200, headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "content-length": String(result.bytes.length), "x-content-type-options": "nosniff", etag: `"${result.contentHash}"`,
          "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'none'" }, body: result.bytes };
      }
      if (method === "GET" && (match = pathname.match(
        /^\/v2-labs\/live\/spaces\/([^/]+)\/books\/([^/]+)\/versions\/([^/]+)\/pdf$/))) {
        return await this.downloadBookPdf(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]),
          decodeURIComponent(match[3]));
      }
      if (method === "GET" && (match = pathname.match(
        /^\/v2-labs\/live\/spaces\/([^/]+)\/books\/([^/]+)\/versions\/([^/]+)$/))) {
        return await this.openBookPreview(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]),
          decodeURIComponent(match[3]));
      }
      if (method === "GET" && (match = pathname.match(/^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/draft\/sources$/))) {
        return await this.readAssemblySources(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      if (method === "POST" && (match = pathname.match(/^\/v2-labs\/owner\/spaces\/([^/]+)\/books\/([^/]+)\/draft\/assembly$/))) {
        return await this.assembleBookDraft(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      ctx.principal = this.principal(headers);
      if (method === "POST" && (match = pathname.match(/^\/v2-labs\/books\/([^/]+)\/contribution-grants\/([^/]+)$/))) {
        return this.authorizeBookMemory(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      if (method === "POST" && (match = pathname.match(
        /^\/v2-labs\/books\/([^/]+)\/contribution-grants\/([^/]+)\/withdrawals$/))) {
        return this.withdrawBookMemory(ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      }
      if (method === "GET" && (match = pathname.match(/^\/v2-labs\/memories\/photos\/([^/]+)$/))) {
        return this.openWorkspace(ctx, decodeURIComponent(match[1]));
      }
      if (method === "POST" && (match = pathname.match(/^\/v2-labs\/memories\/photos\/([^/]+)\/question-jobs$/))) {
        return this.startQuestion(ctx, decodeURIComponent(match[1]));
      }
      if (method === "POST" && (match = pathname.match(/^\/v2-labs\/memories\/photos\/([^/]+)\/skip$/))) {
        return this.skip(ctx, decodeURIComponent(match[1]));
      }
      if (method === "GET" && (match = pathname.match(/^\/v2-labs\/memories\/([^/]+)$/))) {
        return this.detail(ctx, decodeURIComponent(match[1]));
      }
      if (method === "PUT" && (match = pathname.match(/^\/v2-labs\/memories\/([^/]+)\/answer-submissions$/))) {
        return this.saveAnswer(ctx, decodeURIComponent(match[1]));
      }
      if (method === "POST" && (match = pathname.match(/^\/v2-labs\/memories\/([^/]+)\/followup-jobs$/))) {
        return this.requestFollowup(ctx, decodeURIComponent(match[1]));
      }
      if (method === "POST" && (match = pathname.match(/^\/v2-labs\/memories\/([^/]+)\/confirmations$/))) {
        return this.confirm(ctx, decodeURIComponent(match[1]));
      }
      if (method === "POST" && (match = pathname.match(/^\/v2-labs\/memories\/([^/]+)\/withdrawals$/))) {
        return this.withdraw(ctx, decodeURIComponent(match[1]));
      }
      return { status: 404, headers: BASE_HEADERS, body: { error: { code: "route_unavailable" } } };
    } catch (error) {
      const known = error instanceof BookLabError;
      return { status: known ? error.status : 500, headers: BASE_HEADERS,
        body: { error: { code: known ? error.code : "internal_error" } } };
    } finally {
      this.secureFiles();
    }
  }

  secureFiles() {
    if (this.database === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { chmodSync(`${this.database}${suffix}`, 0o600); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  close() {
    this.closed = true;
    for (const operation of this.questionOperations) operation.cancel();
    this.questionOperations.clear();
    this.secureFiles();
    this.db.close();
  }
}

export { BookLabError, sha256, stableJson };
