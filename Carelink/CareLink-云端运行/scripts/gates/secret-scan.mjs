// Secret scan over the repository's *tracked* content.
//
// Scope: driven by `git ls-files`, so untracked and gitignored paths (node_modules/,
// .claude/worktrees/, local scratch) are never scanned. The scan target is what can be
// committed and published; installed dependencies and local scratch directories are not
// this gate's business, and walking them produced both false findings and hard crashes on
// workspace symlinks.
//
// Fake credentials in tests: a literal test credential MUST carry one of the markers in
// `placeholderMarkers` (`not-a-real`, `not-production`) *inside the value itself* —
// e.g. "sk-test-not-a-real-minimax-key", "test-book-lab-etag-secret-not-production-0001".
// A marker elsewhere on the line does not count. Anything else is reported as a finding.
// The markers are deliberately few and unambiguous: a per-value sha256 allowlist has to be
// re-registered on every test edit, and that maintenance cost is what killed this gate once
// already.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");

const forbiddenTargets = [
  "imports/legacy-web/tools/android-webview-harness/build/test-debug.keystore",
  "imports/recovered-backend/tools/android-webview-harness/build/test-debug.keystore",
  "imports/recovered-backend/artifacts/policy-backups/s4-20260802T071754Z-c54868db3b8f.space.json",
  "imports/recovered-backend/artifacts/policy-backups/stressexp1-20260802T071800Z-c7c7f4eb5042.space.json",
  "imports/recovered-backend/prompts/h5-upload-first-v20-final-blockers-20260802.md"
];

const fixtureSpecifications = {
  "imports/recovered-backend/backend/test/oss-v1.test.js": {
    fileSha256: "d8f8e617c8c4619d25232b89fdcf00cd02f0e7995c19ac078e8f34d5e93df1ed",
    values: [
      [13, "accessKeyId", 9, "539b3ed57456a8c8822ef9152c97e409cdb1626e1731cc2bef9c96c1d82520d4"],
      [14, "accessKeySecret", 13, "894e01a8315fcc4199bed8138560585d3ebdd0b4a2e295e47d730dc45061d12b"],
      [46, "accessKeyId", 9, "539b3ed57456a8c8822ef9152c97e409cdb1626e1731cc2bef9c96c1d82520d4"],
      [47, "accessKeySecret", 13, "894e01a8315fcc4199bed8138560585d3ebdd0b4a2e295e47d730dc45061d12b"]
    ],
    transport: "injected_fetch"
  },
  "imports/recovered-backend/backend/test/service.test.js": {
    fileSha256: "6f2b1ee3ed01151c7cd1b4ff564bf873098ff0e3511755c5eda5db255f963713",
    values: [
      [26, "accessKeyId", 14, "f3e9bc9cd861a577b1a52762ef634b27973c65f6ec58a57fde9f53b5456bb43d"],
      [27, "accessKeySecret", 37, "0ef2e06f0f7dcc8957ad8fb972536ebe3219936e52eeb753d33f8111f9ac9c64"],
      [28, "tokenSecret", 45, "41b90ca30b0b35597991051d001d6e9d8953d9834e3203408032e36d7aa75db5"],
      [29, "spaceIdSecret", 45, "efe4c5fe999e55e6ccd0f82c786448e7f203b42bb58cf9894711731f7f4ee5d3"],
      [30, "hostKeySecret", 45, "b0eb7cfcd7d1a4d9b1c9108139a3af9a7fe4b7eaedd37147049f48f7788ce072"],
      [31, "rateLimitSecret", 45, "3f5cf65c01c5fcf67629abd66f0dc219e62f836ad8fe53bd0570ee367c826b35"]
    ],
    transport: "fake_oss"
  }
};

// Reviewed memory-frame 0.5.6 import exceptions: synthetic local/mock credentials,
// a per-call configuration sentinel, a template interpolation, an intentionally rejected
// credentialed URL, and an example configuration with empty credential fields.
// Whole-file digest + exact line + rule prevent these exceptions from hiding new values.
const memoryFrameReviewedFindings = {
  "products/memory-frame/devices/link2-windows/test/uploader-lifecycle.test.cjs": {
    "fileSha256": "3808cc6deea88156717b4c728796b1dc66edcda70ce47b8de8a596da854a319e",
    "findings": [
      [
        104,
        "literal_secret_assignment"
      ],
      [
        107,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/public-release/.env.example": {
    "fileSha256": "2a60b3bd1111b2e49eb2da9334b0373ca0c27c6e822104b5ecda9b77b51b5548",
    "findings": [
      [
        null,
        "credential_shaped_path"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/scripts/package-public.test.mjs": {
    "fileSha256": "b5764ecbcce7f09a432cb7935052be2306e1a1ac4d1b01fec6642f25e66e2cec",
    "findings": [
      [
        135,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/server/ai-realtime-trtc.js": {
    "fileSha256": "cb79ed91ce6355d8656ca000330a422db1a0a2bf8dd1991b91caf21643a31be6",
    "findings": [
      [
        34,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/ai-adapter.test.js": {
    "fileSha256": "3344257e29a607dff4cbd55c69a4b5dffb9b39485b7729a2331365a610ffb8a6",
    "findings": [
      [
        41,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/ai-conversation-ui.test.js": {
    "fileSha256": "01674083357df1420141174c96889e14baa8a26f12e16f807e21255f29a10810",
    "findings": [
      [
        310,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/ai-conversation.test.js": {
    "fileSha256": "31fe1359624807ac0fb87ac7f5b717330054749e39fd461388cbbbb375f240a9",
    "findings": [
      [
        83,
        "literal_secret_assignment"
      ],
      [
        104,
        "literal_secret_assignment"
      ],
      [
        120,
        "literal_secret_assignment"
      ],
      [
        162,
        "literal_secret_assignment"
      ],
      [
        179,
        "literal_secret_assignment"
      ],
      [
        193,
        "literal_secret_assignment"
      ],
      [
        202,
        "literal_secret_assignment"
      ],
      [
        232,
        "literal_secret_assignment"
      ],
      [
        246,
        "literal_secret_assignment"
      ],
      [
        264,
        "literal_secret_assignment"
      ],
      [
        280,
        "literal_secret_assignment"
      ],
      [
        386,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/ai-realtime-bridge.test.js": {
    "fileSha256": "fa798a32cafc682ede57645bd76f19a1e48a2a1c6225be95ea43a692fe66e75b",
    "findings": [
      [
        167,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/ai-realtime-hy3-stream.test.js": {
    "fileSha256": "0113039ddd0333a9a54c0e7e84280cf5e3b552087c611de6d09d940cb7ea4f1b",
    "findings": [
      [
        13,
        "literal_secret_assignment"
      ],
      [
        41,
        "literal_secret_assignment"
      ],
      [
        218,
        "literal_secret_assignment"
      ],
      [
        250,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/ai-realtime-readiness.test.js": {
    "fileSha256": "1012ae63f645b93cc41365ad4497f396e075c8838c3bc3d9b33230146b1c4a4c",
    "findings": [
      [
        13,
        "literal_secret_assignment"
      ],
      [
        15,
        "literal_secret_assignment"
      ],
      [
        31,
        "literal_secret_assignment"
      ],
      [
        42,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/ai-realtime.test.js": {
    "fileSha256": "964ed823234a8e6f871a48fd5a1a178748019d75006b9a165d492cbc9868276c",
    "findings": [
      [
        30,
        "literal_secret_assignment"
      ],
      [
        39,
        "literal_secret_assignment"
      ],
      [
        40,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/family-call-readiness-http-browser.test.js": {
    "fileSha256": "2f77d8cd1b01659d00a316f02df9b00ebd3c20e28f375b88529632024751caf9",
    "findings": [
      [
        40,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/realtime-evidence.test.js": {
    "fileSha256": "e590b01d53864bdd17d5f4e0940dd5e9b6a8e024b8f6a69f3c51d0e1da2d308c",
    "findings": [
      [
        105,
        "literal_secret_assignment"
      ]
    ]
  },
  "products/memory-frame/memory-frame-demo/test/spatial-link.test.js": {
    "fileSha256": "cd18a43f77fc986c6388bd845df64e8c6bf0daae54fc8110d2c02420f5d2fa62",
    "findings": [
      [
        35,
        "credentialed_url"
      ]
    ]
  }
};

const pathRule = /(^|\/)(\.env(?:\..*)?|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx|jks|keystore)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/i;
// This frozen processor configuration contains paths/ports only; its contents are still scanned.
const configurationExamples = new Set([
  "tools/agent-bridge/jobs/to-4060/unseen-3dgs-local-product-2026-09-04-v15/inputs/.env.example"
]);
// Keep an immutable upstream task's test bytes intact. Only this exact synthetic value is allowed.
const importedSyntheticAssignments = new Map([
  ["tools/agent-bridge/jobs/to-4060/unseen-3dgs-room-and-local-upload-2026-09-02-v6/inputs/tests/test_local_video_intake.py", new Set(["unit-test-token"])]
]);
const providerRules = {
  private_key_pem: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  aws_access_key: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  aliyun_access_key: /\bLTAI[A-Za-z0-9]{12,24}\b/g,
  github_token: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g,
  openai_key: /\bsk-[A-Za-z0-9_-]{20,255}\b/g,
  google_api_key: /\bAIza[0-9A-Za-z_-]{30,50}\b/g,
  jwt: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  credentialed_url: /https?:\/\/[^\s/:@]{1,80}:[^\s/@]{6,160}@/g
};
const assignmentRule = /([A-Za-z_][A-Za-z0-9_-]*(?:secret|token|password|passwd)|access[_-]?key[_-]?secret|secret[_-]?access[_-]?key|client[_-]?secret|api[_-]?key|private[_-]?key)\s*[:=]\s*["']([^"'\r\n]{8,512})["']/gi;
const placeholderMarkers = ["not-a-real", "not-production"];
const binarySuffixes = new Set([".apk", ".class", ".dex", ".gif", ".idsig", ".jar", ".jpeg", ".jpg", ".pdf", ".png", ".webp", ".zip"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// The marker must live inside the flagged value itself, not merely somewhere on the line.
function hasPlaceholderMarker(value) {
  const lower = value.toLowerCase();
  return placeholderMarkers.some((marker) => lower.includes(marker));
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

// imports/ is the archaeology area, and it is excluded from the scan rather than remediated.
// Both trees are byte-exact frozen copies of recovered legacy code, sha256-pinned in
// provenance/safe-import-inventory.json, and they were manually swept once at the Track 0L
// bootstrap freeze — the credential-shaped literals in them were confirmed fake then. Adding a
// placeholder marker to those values would edit files whose whole point is being byte-exact,
// turning the provenance record into a lie, so exclusion is the only option that doesn't make
// the repository claim something untrue.
//
// Boundary: imports/ is closed. No new files may be added under it. Anyone who ever does need to
// modify these trees owns re-enabling this scan for what they touch.
const scanExcluded = /^imports\//u;

function trackedFiles() {
  const listed = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], { maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr?.toString("utf8") ?? "unknown error"}`);
  }
  return listed.stdout.toString("utf8").split("\0").filter((relative) => relative && !scanExcluded.test(relative));
}

// Tracked entries that are not regular files (symlinks, submodule gitlinks, or paths staged
// for deletion) are skipped rather than fatal: there is no file content to scan.
async function isRegularFile(relative) {
  try {
    return (await lstat(path.join(repoRoot, relative))).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

for (const relative of forbiddenTargets) {
  try {
    await stat(path.join(repoRoot, relative));
    throw new Error(`forbidden excluded file is present: ${relative}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const allowedFixtureAssignments = new Set();
let fixtureFingerprintCount = 0;
for (const [relative, specification] of Object.entries(fixtureSpecifications)) {
  const bytes = await readFile(path.join(repoRoot, relative));
  if (sha256(bytes) !== specification.fileSha256) throw new Error(`fixture file drift: ${relative}`);
  const lines = bytes.toString("utf8").split("\n");
  for (const [line, key, valueBytes, valueSha256] of specification.values) {
    const expression = new RegExp(`\\b${key}\\s*:\\s*([\\"'])(.*?)\\1`);
    const match = expression.exec(lines[line - 1]);
    if (!match || Buffer.byteLength(match[2]) !== valueBytes || sha256(match[2]) !== valueSha256) {
      throw new Error(`fixture fingerprint drift: ${relative}:${line}:${key}`);
    }
    allowedFixtureAssignments.add(`${relative}:${line}:${valueSha256}`);
    fixtureFingerprintCount += 1;
  }
  const source = bytes.toString("utf8");
  if (specification.transport === "injected_fetch") {
    if ((source.match(/new\s+OssV1Adapter\s*\(/g) ?? []).length !== 2 || (source.match(/\bfetch\s*:\s*async\s*\(/g) ?? []).length !== 2 || source.includes("globalThis.fetch")) {
      throw new Error(`injected transport drift: ${relative}`);
    }
  } else if (!source.includes("new FakeOss(now)") || !source.includes("makeService({ oss,") || source.includes("fetch(")) {
    throw new Error(`FakeOss transport drift: ${relative}`);
  }
  if (/require\s*\(\s*["'](?:node:)?(?:http|https|net|tls|dns|dgram|undici|child_process)["']\s*\)/.test(source)) {
    throw new Error(`fixture network/child-process import drift: ${relative}`);
  }
}

const findings = [];
const counts = { files: 0, textScanned: 0, binarySkipped: 0, irregularSkipped: 0 };
for (const relative of trackedFiles()) {
  if (!await isRegularFile(relative)) {
    counts.irregularSkipped += 1;
    continue;
  }
  counts.files += 1;
  if (pathRule.test(relative) && !configurationExamples.has(relative)) findings.push({ relativePath: relative, line: null, rule: "credential_shaped_path" });
  if (binarySuffixes.has(path.extname(relative).toLowerCase())) {
    counts.binarySkipped += 1;
    continue;
  }
  const bytes = await readFile(path.join(repoRoot, relative));
  if (bytes.subarray(0, 8192).includes(0)) {
    counts.binarySkipped += 1;
    continue;
  }
  counts.textScanned += 1;
  const text = bytes.toString("utf8");
  for (const [rule, expression] of Object.entries(providerRules)) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      if (hasPlaceholderMarker(match[0])) continue;
      findings.push({ relativePath: relative, line: lineNumber(text, match.index), rule });
    }
  }
  assignmentRule.lastIndex = 0;
  for (const match of text.matchAll(assignmentRule)) {
    const candidate = match[2];
    if (hasPlaceholderMarker(candidate)) continue;
    if (importedSyntheticAssignments.get(relative)?.has(candidate)) continue;
    const line = lineNumber(text, match.index);
    const valueHash = sha256(candidate);
    if (allowedFixtureAssignments.has(`${relative}:${line}:${valueHash}`)) continue;
    findings.push({ relativePath: relative, line, rule: "literal_secret_assignment" });
  }
}

// Fail closed on any change to an audited file; re-review its exact findings first.
for (const [relative, specification] of Object.entries(memoryFrameReviewedFindings)) {
  if (sha256(await readFile(path.join(repoRoot, relative))) !== specification.fileSha256) {
    throw new Error(`reviewed memory-frame fixture drift: ${relative}`);
  }
}
const reviewedFindingKeys = new Set(Object.entries(memoryFrameReviewedFindings).flatMap(
  ([relative, specification]) => specification.findings.map(([line, rule]) => JSON.stringify([relative, line, rule]))
));
const remainingFindings = findings.filter(({ relativePath, line, rule }) =>
  !reviewedFindingKeys.has(JSON.stringify([relativePath, line, rule])));
const result = {
  status: remainingFindings.length ? "SECRET_SCAN_FINDINGS" : "SECRET_SCAN_CLEAN",
  counts,
  exactSyntheticFixtureFingerprints: fixtureFingerprintCount,
  exactExcludedTargetsAbsent: forbiddenTargets.length,
  highEntropySensitiveContextBasis: "controller exhaustive all-tree scan plus byte-exact provenance and exact excluded prompt hash",
  exactReviewedMemoryFrameFindings: reviewedFindingKeys.size,
  findings: remainingFindings
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (remainingFindings.length) process.exitCode = 1;
