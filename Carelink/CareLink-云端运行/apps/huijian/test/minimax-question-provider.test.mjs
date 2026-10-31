import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMAX_QUESTION_SYSTEM_PROMPT,
  MiniMaxProviderError,
  SAFE_INITIAL_MEMORY_QUESTION,
  createMiniMaxQuestionProvider
} from "../lib/minimax-question-provider.mjs";

const BASE_INPUT = Object.freeze({
  signal: new AbortController().signal,
  model: "MiniMax-Text-01",
  modelVersion: "test"
});

function completion(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function providerReturning(content, options = {}) {
  return createMiniMaxQuestionProvider({
    apiKey: "not-a-real-test-key",
    fetchImpl: async () => completion(content),
    ...options
  });
}

test("initial prompt explicitly forbids premises absent from visible facts", () => {
  assert.match(MINIMAX_QUESTION_SYSTEM_PROMPT, /第一次提问/);
  assert.match(MINIMAX_QUESTION_SYSTEM_PROMPT, /事实没写出的时间/);
  assert.match(MINIMAX_QUESTION_SYSTEM_PROMPT, /不能根据暖光、天色或灯光/);
  assert.match(MINIMAX_QUESTION_SYSTEM_PROMPT, /从几点开始、何时结束、持续多久或之后又发生什么/);
  assert.match(MINIMAX_QUESTION_SYSTEM_PROMPT, /桌上的人.*人物数量、围坐.*吃饭、相聚/su);
  assert.match(MINIMAX_QUESTION_SYSTEM_PROMPT, /对方回答里已经明确写出/);
  assert.match(MINIMAX_QUESTION_SYSTEM_PROMPT, /不要让用户替你识图/);
});

test("known-facts initial question accepts an open memory invitation", async () => {
  const provider = providerReturning({ question: "碰杯之外，还有什么没有被照片拍下来？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["几只手正举杯", "桌上放着几杯饮品"]
  });

  assert.equal(result.question, "碰杯之外，还有什么没有被照片拍下来？");
  assert.deepEqual(result.modelVisibleFacts, ["几只手正举杯", "桌上放着几杯饮品"]);
  assert.equal(result.questionFallback, undefined);
});

test("initial question may use a time marker that the facts explicitly contain", async () => {
  const provider = providerReturning({ question: "照片标注的今晚，还有什么没拍下来？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["照片角落标注今晚八点", "几只手正举杯"]
  });

  assert.equal(result.question, "照片标注的今晚，还有什么没拍下来？");
});

test("initial question may use an explicitly observed time of day", async () => {
  const provider = providerReturning({ question: "这个傍晚，还有什么没被拍下来？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["照片文字标注傍晚六点", "几只手正举杯"]
  });

  assert.equal(result.question, "这个傍晚，还有什么没被拍下来？");
});

for (const question of [
  "你会给这两杯起什么名字？",
  "这张照片让你想到哪次旅行？",
  "这张照片让你想到哪个傍晚？",
  "你会在什么时候想起这张照片？"
]) {
  test(`initial question allows open invitation without treating its topic as fact: ${question}`, async () => {
    const provider = providerReturning({ question });
    const result = await provider({
      ...BASE_INPUT,
      kind: "initial_question",
      visibleFacts: ["桌上放着两杯饮品"]
    });

    assert.equal(result.question, question);
  });
}

test("photo1 cheers counterexample cannot turn warm lights into a definite evening start time", async () => {
  const facts = ["上方悬挂暖色串灯", "几只手正举杯相碰"];
  const provider = providerReturning({
    modelVisibleFacts: facts,
    question: "这个傍晚是从几点开始坐下来的？"
  }, { resolveImage: async () => ({ url: "https://example.test/photo1_cheers.jpg" }) });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question"
  });

  assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
  assert.deepEqual(result.modelVisibleFacts, facts);
  assert.equal(result.questionFallback, "unsupported_initial_premise");
});

test("an initial start-time question is allowed only when the facts establish the boundary", async () => {
  const provider = providerReturning({ question: "活动是从几点开始的？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["邀请牌写着活动晚上七点开始", "桌上放着几杯饮品"]
  });

  assert.equal(result.question, "活动是从几点开始的？");
  assert.equal(result.questionFallback, undefined);
});

test("an unrelated use of start in the facts does not support a made-up event start time", async () => {
  const provider = providerReturning({ question: "大家是从几点开始坐下来的？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["暖色串灯开始发亮", "几只手正举杯"]
  });

  assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
  assert.equal(result.questionFallback, "unsupported_initial_premise");
});

for (const question of [
  "这张照片让你想起了谁？",
  "这样的桌面让你想起和谁的哪一次相聚？",
  "这张照片让你想起哪次围坐聊天？"
]) {
  test(`initial question preserves an open association without claiming visible people: ${question}`, async () => {
    const provider = providerReturning({ question });
    const result = await provider({
      ...BASE_INPUT,
      kind: "initial_question",
      visibleFacts: ["桌上摆着几套餐具", "背景有暖色光点"]
    });

    assert.equal(result.question, question);
    assert.equal(result.questionFallback, undefined);
  });
}

for (const question of [
  "这张照片让你想起哪一顿饭，桌上的人都还在脑海里吗？",
  "围坐在这样布置的桌旁，你最先想起的是谁？",
  "这三个人之外，还有什么没有被照片拍下来？",
  "大家吃饭时，最值得留下的是什么？"
]) {
  test(`photo4 initial question replaces an unsupported human or event premise: ${question}`, async () => {
    const facts = ["木桌上摆放着多套餐具", "背景中有暖色光点"];
    const provider = providerReturning({ modelVisibleFacts: facts, question }, {
      resolveImage: async () => ({ url: "https://example.test/photo4_table_detail.jpg" })
    });
    const result = await provider({
      ...BASE_INPUT,
      kind: "initial_question"
    });

    assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
    assert.deepEqual(result.modelVisibleFacts, facts);
    assert.equal(result.questionFallback, "unsupported_initial_premise");
  });
}

test("facts that explicitly show people and their posture support a matching initial premise", async () => {
  const question = "围坐在桌旁的人，照片外还有什么故事？";
  const provider = providerReturning({ question });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["三个人围坐在木桌旁", "桌上摆着几套餐具"]
  });

  assert.equal(result.question, question);
  assert.equal(result.questionFallback, undefined);
});

test("a negative no-people fact cannot support a definite person premise", async () => {
  const provider = providerReturning({ question: "画面中的人，照片外还有什么故事？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["画面中没有人物", "桌上摆着几套餐具"]
  });

  assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
  assert.equal(result.questionFallback, "unsupported_initial_premise");
});

test("an object count beside one person cannot support a made-up human count", async () => {
  const provider = providerReturning({ question: "这三个人之外，还有什么没有被照片拍下来？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["一位女性站在摆着三个杯子的桌旁"]
  });

  assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
  assert.equal(result.questionFallback, "unsupported_initial_premise");
});

test("an explicit human count supports the same count in an initial premise", async () => {
  const question = "这三个人之外，还有什么没有被照片拍下来？";
  const provider = providerReturning({ question });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["三个人围坐在木桌旁"]
  });

  assert.equal(result.question, question);
  assert.equal(result.questionFallback, undefined);
});

for (const question of [
  "那杯酒让你想起了哪个人？",
  "碰杯之后，你们聊了什么让你到现在还记得的事？",
  "碰杯的那一瞬，你最先想起的是谁？",
  "这杯碰在一起的时候，你身边坐着谁呢？"
]) {
  test(`photo1 real-probe premise is safely replaced: ${question}`, async () => {
    const facts = ["两只手各握一只高脚酒杯正在碰杯", "一只杯中是淡色液体，另一只杯中是红色液体"];
    const provider = providerReturning({ modelVisibleFacts: facts, question }, {
      resolveImage: async () => ({ url: "https://example.test/photo1_cheers.jpg" })
    });
    const result = await provider({
      ...BASE_INPUT,
      kind: "initial_question"
    });

    assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
    assert.equal(result.questionFallback, "unsupported_initial_premise");
  });
}

test("an explicitly visible drink supports the matching open association", async () => {
  const question = "这杯红酒让你想起了谁？";
  const provider = providerReturning({ question });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["一只杯中盛着红酒", "两只手正在碰杯"]
  });

  assert.equal(result.question, question);
  assert.equal(result.questionFallback, undefined);
});

test("photo4 cannot turn an arranged table into an intentional careful preparation", async () => {
  const provider = providerReturning({ question: "这张精心布置的桌面，会让你想起哪一次聚会呢？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["桌上摆着多套餐具", "桌面中央放着陶土花盆"]
  });

  assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
  assert.equal(result.questionFallback, "unsupported_initial_premise");
});

for (const [label, question] of [
  ["time", "今晚碰杯时，还有什么故事没拍下来？"],
  ["relationship", "和朋友们碰杯时，还发生了什么？"],
  ["emotion", "大家这么开心，是在庆祝什么？"],
  ["event purpose separated by a location", "这是在户外庆祝什么特别的日子吗？"],
  ["participant identity", "你正举着杯子时，想到了什么？"]
]) {
  test(`known-facts initial question safely replaces unsupported ${label} premise`, async () => {
    const provider = providerReturning({ question });
    const result = await provider({
      ...BASE_INPUT,
      kind: "initial_question",
      visibleFacts: ["几只手正举杯", "桌上放着几杯饮品"]
    });

    assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
    assert.deepEqual(result.modelVisibleFacts, ["几只手正举杯", "桌上放着几杯饮品"]);
    assert.equal(result.questionFallback, "unsupported_initial_premise");
  });
}

test("initial question safely replaces a request to confirm an uncertain visible object", async () => {
  const provider = providerReturning({ question: "左边那杯透明饮品里加的是柠檬片吗？" });
  const facts = ["两只手碰杯", "左杯透明饮品带冰与一片黄色圆片；右杯红色饮品"];
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: facts
  });

  assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
  assert.deepEqual(result.modelVisibleFacts, facts);
  assert.equal(result.questionFallback, "unsupported_initial_premise");
});

test("vision initial question preserves model facts when using the safe replacement", async () => {
  const facts = ["几只手正举杯", "桌上放着几杯饮品"];
  const provider = providerReturning({
    modelVisibleFacts: facts,
    question: "那天和同事们聚会时，大家是不是很开心？"
  }, { resolveImage: async () => ({ url: "https://example.test/photo.jpg" }) });
  const result = await provider({
    ...BASE_INPUT,
    kind: "initial_question"
  });

  assert.equal(result.question, SAFE_INITIAL_MEMORY_QUESTION);
  assert.deepEqual(result.modelVisibleFacts, facts);
  assert.equal(result.questionFallback, "unsupported_initial_premise");
});

test("malformed known-facts question still fails instead of using the safe replacement", async () => {
  const provider = providerReturning({ question: "这不是一个有效问题" });

  await assert.rejects(provider({
    ...BASE_INPUT,
    kind: "initial_question",
    visibleFacts: ["几只手正举杯"]
  }), (error) => error instanceof MiniMaxProviderError && error.code === "minimax_question_invalid");
});

test("vision abstention still fails instead of inventing facts for the safe replacement", async () => {
  const provider = providerReturning({ modelVisibleFacts: [], question: "" }, {
    resolveImage: async () => ({ url: "https://example.test/photo.jpg" })
  });

  await assert.rejects(provider({
    ...BASE_INPUT,
    kind: "initial_question"
  }), (error) => error instanceof MiniMaxProviderError && error.code === "minimax_vision_abstained");
});

test("follow-up may reuse time, relationship and emotion explicitly introduced by the user", async () => {
  const provider = providerReturning({ question: "那天和同事告别后，什么让你最舍不得？" });
  const result = await provider({
    ...BASE_INPUT,
    kind: "followup_question",
    visibleFacts: ["几只手正举杯", "桌上放着几杯饮品"],
    userText: "那天是和同事的送别聚会，我很舍不得。"
  });

  assert.equal(result.question, "那天和同事告别后，什么让你最舍不得？");
});
