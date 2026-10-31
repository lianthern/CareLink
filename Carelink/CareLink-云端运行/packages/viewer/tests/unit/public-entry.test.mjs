import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the package has exactly one public entry under src/public", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(manifest.exports["."], {
    types: "./src/public/index.d.ts",
    import: "./src/public/index.js",
  });
  assert.deepEqual(fs.readdirSync(path.join(packageRoot, "src/public")).sort(), ["index.d.ts", "index.js"]);
  assert.equal(fs.existsSync(path.join(packageRoot, "src/index.js")), false);
  assert.equal(fs.existsSync(path.join(packageRoot, "src/index.d.ts")), false);
  assert.equal(typeof (await import("@unseen/viewer")).createViewer, "function");
  await assert.rejects(import("@unseen/viewer/src/viewer.js"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
});

test("color and depth share the canonical yaw-zero equirectangular seam", () => {
  const implementation = fs.readFileSync(path.join(packageRoot, "src/viewer.js"), "utf8");
  assert.match(implementation, /fract\(atan\(ray\.x,ray\.z\)\/\(2\.0\*PI\)\)/);
  assert.doesNotMatch(implementation, /0\.5\+atan\(ray\.x,ray\.z\)/);
  assert.match(implementation, /texture2D\(uDepth,panoUv\(ray\)\)/);
  assert.match(implementation, /texture2D\(uColor,panoUv\(sampleRay\)\)/);
});
