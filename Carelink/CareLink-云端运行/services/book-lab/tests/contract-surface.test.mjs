import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contract = JSON.parse(readFileSync(new URL(
  "../../../packages/contracts/generated/book-lab/action-api-coverage.json", import.meta.url)));

test("all 20 Book Lab product routes stay byte-aligned with the frozen coverage map", () => {
  const expected = new Map([
    ["MEMORY.OPEN", ["GET", "/v2-labs/memories/photos/{photoId}"]],
    ["MEMORY.START_QUESTION", ["POST", "/v2-labs/memories/photos/{photoId}/question-jobs"]],
    ["MEMORY.SKIP", ["POST", "/v2-labs/memories/photos/{photoId}/skip"]],
    ["MEMORY.SAVE_ANSWER_DRAFT", ["PUT", "/v2-labs/memories/{memoryId}/answer-submissions"]],
    ["MEMORY.REQUEST_FOLLOWUP", ["POST", "/v2-labs/memories/{memoryId}/followup-jobs"]],
    ["MEMORY.CONFIRM", ["POST", "/v2-labs/memories/{memoryId}/confirmations"]],
    ["MEMORY.WITHDRAW", ["POST", "/v2-labs/memories/{memoryId}/withdrawals"]],
    ["BOOK_MEMORY.AUTHORIZE", ["POST", "/v2-labs/books/{bookId}/contribution-grants/{personalMemoryId}"]],
    ["BOOK_MEMORY.WITHDRAW", ["POST", "/v2-labs/books/{bookId}/contribution-grants/{personalMemoryId}/withdrawals"]],
    ["BOOK.OPEN_LAB", ["GET", "/v2-labs/owner/spaces/{spaceId}/book-lab"]],
    ["BOOK.CREATE", ["POST", "/v2-labs/owner/spaces/{spaceId}/books"]],
    ["BOOK.OPEN_DRAFT", ["GET", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft"]],
    ["BOOK.GENERATE_PREVIEW", ["POST", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/render-jobs"]],
    ["BOOK.EDIT_TITLE", ["PATCH", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/title"]],
    ["BOOK.REMOVE_PAGE", ["POST",
      "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/pages/{pageId}/removals"]],
    ["BOOK.REPLACE_PAGE_PHOTO", ["PUT",
      "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/pages/{pageId}/photo"]],
    ["BOOK.FREEZE", ["POST", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/versions"]],
    ["BOOK.START_NEW_VERSION", ["POST", "/v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft-versions"]],
    ["BOOK.OPEN_PREVIEW", ["GET", "/v2-labs/live/spaces/{spaceId}/books/{bookId}/versions/{versionId}"]],
    ["BOOK.DOWNLOAD_PDF", ["GET", "/v2-labs/live/spaces/{spaceId}/books/{bookId}/versions/{versionId}/pdf"]]
  ]);
  const actual = new Map(contract.actions.filter((action) => expected.has(action.actionId))
    .map((action) => [action.actionId, [action.method, action.endpoint]]));
  assert.deepEqual(actual, expected);
  assert.equal(actual.size, 20);
  const detail = contract.subordinateReadCoverage.find((entry) => entry.operationId === "MEMORY_DETAIL_READ");
  assert.deepEqual([detail.method, detail.endpoint], ["GET", "/v2-labs/memories/{memoryId}"]);
  const processor = contract.internalOperationCoverage.find((entry) => entry.operationId === "QUESTION_PROCESSOR");
  assert.equal(processor.endpoint, "internal:book-lab-question-processor");
  assert.equal(processor.successDTO, "QuestionProcessorResult");
  const renderProcessor = contract.internalOperationCoverage.find((entry) => entry.operationId === "BOOK_RENDER_PROCESSOR");
  assert.equal(renderProcessor.endpoint, "internal:book-lab-render-processor");
  assert.equal(renderProcessor.successDTO, "BookRenderProcessorResult");
});
