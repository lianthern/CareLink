// Probe the provider end-to-end on a demo photo. Prints facts/question/latency only.
import { readFile } from "node:fs/promises";
import { createMiniMaxQuestionProvider } from "../lib/minimax-question-provider.mjs";
import { minimaxApiKey } from "../lib/provider-keys.mjs";

const apiKey = await minimaxApiKey();
const visionModel = process.argv[2] ?? "MiniMax-M3";

const provider = createMiniMaxQuestionProvider({
  apiKey,
  baseUrl: "https://api.minimax.chat",
  textModel: "MiniMax-Text-01",
  visionModel,
  requestTimeoutMs: 90_000,
  maxTokens: 2000,
  resolveImage: async (input) => ({
    base64: (await readFile(new URL(`../photos/${input.photoFile}`, import.meta.url))).toString("base64"),
    mimeType: "image/jpeg"
  })
});

for (const photoFile of ["demo-celebration.jpg"]) {
  try {
    const out = await provider({
      kind: "initial_question",
      signal: AbortSignal.timeout(120_000),
      model: visionModel,
      modelVersion: "probe",
      photoFile
    });
    console.log(photoFile, "->", JSON.stringify(out, null, 2));
  } catch (error) {
    console.log(photoFile, "-> FAIL", error.code ?? error.message);
  }
}
