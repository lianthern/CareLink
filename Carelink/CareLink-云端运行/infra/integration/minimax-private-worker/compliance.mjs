// Local, generation-side compliance pre-check for the MiniMax private-ai worker.
//
// Two independent validators sit downstream of this worker's completed result:
//   1. The wire protocol itself (`services/api/src/private-ai-job-queue.mjs` `checkedResult`, mirrored by
//      `infra/integration/mac-codex-private-worker/remote-pull.mjs` `checkedAnalysisResult`): structural only --
//      1-2 unique facts of 2-160 chars, a 2-300 char question with exactly one trailing `?`/`?`, no control
//      characters, `model`/`modelVersion` equal to what the server expects, `latencyMs` in range. It does not
//      check for sensitive content and does not check that the question relates to the facts at all.
//   2. Book Lab's own semantic validator, `privateProviderOutcome()` in `services/book-lab/src/memory-api.mjs`
//      (see `UNSAFE_MODEL_TEXT` at line 35, `GENERIC_FACT_BIGRAMS`/`factBigrams` at lines 36 and 116-124, and
//      `privateProviderOutcome` at lines 126-154). This is the validator that actually gates whether a completed
//      private-ai result is accepted into a Book Lab memory interview once the composition consumer
//      (`infra/integration/book-lab/private-ai-composition.mjs`) delivers it via `ingestPrivateQuestionResult`.
//      It additionally forbids identity/sensitive-attribute/relationship/emotion/inference language and -- the
//      constraint the overall reviewer specifically flagged -- requires the question to share at least one
//      Chinese/token bigram with one of the visible facts (excluding a small set of generic filler bigrams),
//      so the question reads as *about* what was actually seen rather than a generic non-sequitur.
//
// This module ports validator #2 (same regex, same bigram algorithm, same generic-bigram exclusion list) so the
// worker can enforce it *before* ever calling `/complete`, instead of hoping a downstream consumer happens to
// accept the result. `checkCompliance()` returns a reason instead of throwing, so the caller can decide whether
// to retry-with-a-reworded-prompt or abstain.

// Copied verbatim from services/book-lab/src/memory-api.mjs (UNSAFE_MODEL_TEXT, line 35) -- keep in sync by
// hand; there is no cross-workspace import boundary between infra/integration and services/book-lab in this
// repo, so each worker pins its own compliance constants the same way infra/integration/mac-codex-private-worker
// pins its own prompt/policy hash rather than importing services/book-lab's. (Its leading `\p{Cc}|\r|\n`
// alternatives are handled separately here by `hasControlCharacter()` so this source file never has to embed a
// raw control byte inside a regex literal.)
const UNSAFE_MODEL_TEXT = /(?:忽略(?:之前|以上|系统)|系统提示|开发者消息|提示词|调用工具|执行命令|读取文件|访问文件|联网|打开终端|输出(?:密码|凭据)|prompt\s*injection|system\s*(?:message|prompt)|ignore\s+(?:all\s+)?(?:previous|system)|call\s+(?:a\s+)?tool|read\s+(?:a\s+)?file|\bwho\b|谁|人脸|识别人|认出|这个人是|那个人是|姓名|名叫|身份|民族|种族|宗教|政治(?:倾向|观点)?|疾病|残疾|性取向|性别认同|怀孕|医疗状况|基因|身份证|住址|电话|邮箱|收入|未成年|男士|女士|男人|女人|男性|女性|男孩|女孩|悲伤|伤心|开心|幸福|愤怒|焦虑|害怕|紧张|孤独|情侣|夫妻|恋人|父母|父亲|母亲|儿子|女儿|亲属|同事|朋友|关系|显然|似乎|可能是|应该是|看起来|大概|估计|推测)/iu;
// Copied verbatim from services/book-lab/src/memory-api.mjs (GENERIC_FACT_BIGRAMS, line 36).
const GENERIC_FACT_BIGRAMS = new Set(["照片", "画面", "可以", "看到", "一张", "一个", "一位", "其中"]);

// Ported verbatim from services/book-lab/src/memory-api.mjs (factBigrams, lines 116-124).
function factBigrams(value) {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const tokens = new Set();
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    const token = normalized.slice(index, index + 2);
    if (!GENERIC_FACT_BIGRAMS.has(token)) tokens.add(token);
  }
  return tokens;
}

// Equivalent to the control-character range excluded by the wire protocol's own SAFE_TEXT /
// CONTROL_OR_NEWLINE checks (the C0 control range plus DEL), written as a numeric code-point scan instead of a
// regex literal so this file never needs to carry a raw control byte or an unescaped `\u`/`\x` sequence.
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeFacts(facts) {
  if (!Array.isArray(facts) || facts.length < 1 || facts.length > 2) return "facts_count_invalid";
  for (const fact of facts) {
    if (typeof fact !== "string" || fact.length < 2 || fact.length > 160 || hasControlCharacter(fact) ||
      /[?？]/u.test(fact) || UNSAFE_MODEL_TEXT.test(fact)) return "fact_content_invalid";
  }
  if (new Set(facts).size !== facts.length) return "fact_duplicate";
  return null;
}

function safeQuestion(question) {
  if (typeof question !== "string" || question.length < 2 || question.length > 300 ||
    hasControlCharacter(question) || UNSAFE_MODEL_TEXT.test(question)) return "question_content_invalid";
  const marks = question.match(/[?？]/gu) ?? [];
  if (marks.length !== 1 || !/[?？]$/u.test(question)) return "question_mark_invalid";
  return null;
}

/**
 * Mirrors `privateProviderOutcome()` in services/book-lab/src/memory-api.mjs, minus the parts that are specific
 * to that method's calling convention (exact-key/model/modelVersion/latencyMs checks -- those are already
 * enforced by the wire protocol's own `checkedAnalysisResult`/`checkedResult`, so re-checking them here would
 * just duplicate work the transport layer already does correctly).
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkCompliance({ modelVisibleFacts, question }) {
  const factsReason = safeFacts(modelVisibleFacts);
  if (factsReason) return { ok: false, reason: factsReason };
  const questionReason = safeQuestion(question);
  if (questionReason) return { ok: false, reason: questionReason };
  const questionBigrams = factBigrams(question);
  const overlaps = modelVisibleFacts.some((fact) => [...factBigrams(fact)].some((token) => questionBigrams.has(token)));
  if (!overlaps) return { ok: false, reason: "question_fact_bigram_disjoint" };
  return { ok: true };
}

export { factBigrams, GENERIC_FACT_BIGRAMS, hasControlCharacter, UNSAFE_MODEL_TEXT };
