import { readFile, writeFile } from "node:fs/promises";

const [mode = "good", command, ...args] = process.argv.slice(2);
if (command === "--version") {
  process.stdout.write(`${process.version}\n`);
  process.exit(0);
}
if (command !== "exec") process.exit(72);

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const imagePath = valueAfter("--image");
const schemaPath = valueAfter("--output-schema");
const outputPath = valueAfter("--output-last-message");

if (mode === "timeout" && imagePath) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 10_000);
} else if (mode === "unavailable") {
  process.exit(69);
} else {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
  const [image, schema] = await Promise.all([imagePath ? readFile(imagePath) : Promise.resolve(null),
    readFile(schemaPath, "utf8").then(JSON.parse)]);
  const forbiddenEnvironment = Object.keys(process.env).filter((key) =>
    /(?:AUTH|KEY|PASSWORD|SECRET|SOCK|TOKEN)/u.test(key));
  const chunkTypes = [];
  for (let offset = 8; image && offset < image.length;) {
    const length = image.readUInt32BE(offset);
    chunkTypes.push(image.subarray(offset + 4, offset + 8).toString("ascii"));
    offset += length + 12;
  }
  if (mode === "followup-context" && image && (!prompt.includes("untrusted quoted conversation data") ||
    !prompt.includes("散场后我把名字卡夹进蓝色笔记本") || !prompt.includes("上一轮问过的问题"))) process.exit(71);
  if (image && (image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    chunkTypes.some((type) => ["eXIf", "iTXt", "tEXt", "zTXt", "tIME"].includes(type)) ||
    image.includes(Buffer.from("UNSEEN_PRIVATE_EXIF_GPS"))) || forbiddenEnvironment.length > 0) process.exit(70);
  const dto = image && schema.properties.modelVisibleFacts ? {
    modelVisibleFacts: ["桌面上放着一张手写卡片"],
    question: "拍下照片时，这张卡片是谁放在这里的？",
    questionIntent: "photo_context"
  } : image ? { intent: schema.properties.intent.enum[0], visibleFacts: schema.properties.visibleFacts.items.enum } :
    { status: "ready" };
  await writeFile(outputPath, mode === "invalid-dto" && image ? JSON.stringify({ extra: true }) : JSON.stringify(dto));
  process.stdout.write(`${JSON.stringify({ type: "thread.started" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  if ((mode === "tool" && image) || (mode === "preflight-tool" && !image)) {
    process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "command_execution" } })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } })}\n`);
}
