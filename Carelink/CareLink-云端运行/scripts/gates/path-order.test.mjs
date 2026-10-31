import assert from "node:assert/strict";
import test from "node:test";

import { binaryNameCompare, flattenBinarySorted } from "./path-order.mjs";

test("provenance uses bytewise ordering for demo and demo-ai paths", () => {
  const values = ["demo/demo.js", "demo-ai-pano/app.js", "z-last.js", "A-first.js"];
  assert.deepEqual(values.toSorted(binaryNameCompare), values.toSorted());
  assert.deepEqual(values.toSorted(binaryNameCompare), [
    "A-first.js",
    "demo-ai-pano/app.js",
    "demo/demo.js",
    "z-last.js"
  ]);
});

test("recursive provenance walker globally sorts full relative paths", () => {
  const tree = {
    "legacy-web": {
      miniapp: {
        pages: {
          demo: { "demo.js": true },
          "demo-ai-pano": { "demo-ai-pano.js": true }
        }
      }
    }
  };
  assert.deepEqual(flattenBinarySorted(tree), [
    "legacy-web/miniapp/pages/demo-ai-pano/demo-ai-pano.js",
    "legacy-web/miniapp/pages/demo/demo.js"
  ]);
});

test("path ordering is UTF-8 bytewise rather than JavaScript UTF-16", () => {
  assert.deepEqual(["\uE000", "😀"].sort(binaryNameCompare), ["\uE000", "😀"]);
});
