function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth && image.naturalHeight
      ? resolve(image)
      : reject(new Error("export_image_failed"));
    image.onerror = () => reject(new Error("export_image_failed"));
    image.src = src;
  });
}

export function wrapText(context, text, maxWidth) {
  const lines = [];
  const segmenter = globalThis.Intl?.Segmenter
    ? new Intl.Segmenter("zh-CN", { granularity: "grapheme" })
    : null;
  for (const paragraph of String(text ?? "").split(/\r?\n/u)) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    const characters = segmenter
      ? Array.from(segmenter.segment(paragraph), ({ segment }) => segment)
      : Array.from(paragraph);
    for (const character of characters) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

const EXPORT_LAYOUT = Object.freeze({
  width: 1240,
  padding: 64,
  photoTop: 56,
  photoHeight: 760,
  afterPhoto: 82,
  afterDate: 78,
  afterTitle: 86,
  promptLineHeight: 38,
  promptGap: 16,
  answerLineHeight: 52,
  answerGap: 34,
  blockDivider: 40,
  footerRoom: 86,
  minimumHeight: 1754
});

const POSTER_STYLES = Object.freeze({
  "evening-paper": Object.freeze({ background: "#fff9ea", ink: "#26333d", accent: "#b64942", frame: "#fff9ea" }),
  "black-fragments": Object.freeze({ background: "#0c0c0c", ink: "#fff9ea", accent: "#f2c55c", frame: "#262626" }),
  "quiet-white": Object.freeze({ background: "#f7f7f2", ink: "#26333d", accent: "#8a8f92", frame: "#ffffff" })
});

const MEMORY_STYLES = Object.freeze({
  "evening-paper": Object.freeze({
    background: "#fff9ea",
    ink: "#26333d",
    accent: "#b64942",
    prompt: "rgba(38, 51, 61, .64)",
    divider: "rgba(38, 51, 61, .18)",
    footer: "rgba(38, 51, 61, .56)"
  }),
  "black-fragments": Object.freeze({
    background: "#0c0c0c",
    ink: "#fff9ea",
    accent: "#f2c55c",
    prompt: "rgba(255, 249, 234, .58)",
    divider: "rgba(255, 249, 234, .18)",
    footer: "rgba(242, 197, 92, .78)"
  }),
  "quiet-white": Object.freeze({
    background: "#ffffff",
    ink: "#26333d",
    accent: "#6f7477",
    prompt: "rgba(38, 51, 61, .62)",
    divider: "rgba(38, 51, 61, .14)",
    footer: "rgba(38, 51, 61, .52)"
  })
});

export function resolveMemoryExportStyle(styleId) {
  return MEMORY_STYLES[styleId] ?? MEMORY_STYLES["evening-paper"];
}

export function calculateMemoryCanvasHeight(layout) {
  let cursor = EXPORT_LAYOUT.photoTop + EXPORT_LAYOUT.photoHeight + EXPORT_LAYOUT.afterPhoto;
  cursor += EXPORT_LAYOUT.afterDate + EXPORT_LAYOUT.afterTitle;
  layout.forEach((block, index) => {
    if (index > 0) cursor += EXPORT_LAYOUT.blockDivider;
    cursor += block.promptLines.length * EXPORT_LAYOUT.promptLineHeight + EXPORT_LAYOUT.promptGap;
    cursor += block.answerLines.length * EXPORT_LAYOUT.answerLineHeight + EXPORT_LAYOUT.answerGap;
  });
  return Math.max(EXPORT_LAYOUT.minimumHeight, Math.ceil(cursor + EXPORT_LAYOUT.footerRoom));
}

function drawCover(context, image, x, y, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function drawLines(context, lines, x, y, lineHeight) {
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

export function posterWords(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .map((pair) => typeof pair?.answer === "string" ? pair.answer : "")
    .filter((answer) => answer.trim())
    .join("\n\n");
}

export function calculatePosterCanvasHeight(lineCount) {
  const lines = Number.isInteger(lineCount) && lineCount > 0 ? lineCount : 1;
  return Math.max(1754, 1240 + lines * 60 + 250);
}

export async function renderMemoryPng({ photoSrc, date, title, pairs, styleId = "evening-paper" }) {
  const image = await loadImage(photoSrc);
  await document.fonts?.ready;

  const { width, padding, photoTop, photoHeight } = EXPORT_LAYOUT;
  const contentWidth = width - padding * 2;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = 100;
  let context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("export_canvas_failed");

  const bodyFont = '"PingFang SC", "Microsoft YaHei", sans-serif';
  const titleFont = '"Kaiti SC", "STKaiti", "KaiTi", serif';
  const colors = resolveMemoryExportStyle(styleId);
  const layout = [];
  context.font = `32px ${bodyFont}`;
  for (const pair of pairs) {
    context.font = `25px ${bodyFont}`;
    const promptLines = wrapText(context, pair.question, contentWidth);
    context.font = `32px ${bodyFont}`;
    const answerLines = wrapText(context, pair.answer, contentWidth);
    layout.push({ promptLines, answerLines });
  }

  canvas.height = calculateMemoryCanvasHeight(layout);
  context = canvas.getContext("2d", { alpha: false });

  context.fillStyle = colors.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawCover(context, image, padding, photoTop, contentWidth, photoHeight);

  let cursor = photoTop + photoHeight + EXPORT_LAYOUT.afterPhoto;
  context.fillStyle = colors.accent;
  context.font = `600 25px ${bodyFont}`;
  context.fillText(date, padding, cursor);
  cursor += EXPORT_LAYOUT.afterDate;

  context.fillStyle = colors.ink;
  context.font = `700 58px ${titleFont}`;
  context.fillText(title, padding, cursor);
  cursor += EXPORT_LAYOUT.afterTitle;

  layout.forEach((block, index) => {
    if (index > 0) {
      context.strokeStyle = colors.divider;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(padding, cursor);
      context.lineTo(width - padding, cursor);
      context.stroke();
      cursor += EXPORT_LAYOUT.blockDivider;
    }
    context.fillStyle = colors.prompt;
    context.font = `25px ${bodyFont}`;
    cursor = drawLines(context, block.promptLines, padding, cursor, EXPORT_LAYOUT.promptLineHeight)
      + EXPORT_LAYOUT.promptGap;
    context.fillStyle = colors.ink;
    context.font = `32px ${bodyFont}`;
    cursor = drawLines(context, block.answerLines, padding, cursor, EXPORT_LAYOUT.answerLineHeight)
      + EXPORT_LAYOUT.answerGap;
  });

  context.fillStyle = colors.footer;
  context.font = `24px ${bodyFont}`;
  context.textAlign = "right";
  context.fillText("回见 · 阿见陪你留下一页", width - padding, canvas.height - 56);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("export_encode_failed")), "image/png");
  });
}

export async function renderPosterPng({ photoSrc, date, pairs, title = "", styleId = "evening-paper" }) {
  const image = await loadImage(photoSrc);
  await document.fonts?.ready;

  const width = 1240;
  const padding = 72;
  const photoTop = 72;
  const photoHeight = 920;
  const contentWidth = width - padding * 2;
  const colors = POSTER_STYLES[styleId] ?? POSTER_STYLES["evening-paper"];
  const words = [title,posterWords(pairs)].filter(Boolean).join("\n\n");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = 100;
  let context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("export_canvas_failed");

  const bodyFont = '"PingFang SC", "Microsoft YaHei", sans-serif';
  context.font = `38px ${bodyFont}`;
  const lines = wrapText(context, words, contentWidth - 48);
  canvas.height = calculatePosterCanvasHeight(lines.length);
  context = canvas.getContext("2d", { alpha: false });

  context.fillStyle = colors.background;
  context.fillRect(0, 0, width, canvas.height);
  context.fillStyle = colors.frame;
  context.fillRect(padding - 12, photoTop - 12, contentWidth + 24, photoHeight + 24);
  drawCover(context, image, padding, photoTop, contentWidth, photoHeight);

  let cursor = photoTop + photoHeight + 82;
  context.fillStyle = colors.accent;
  context.font = `600 25px ${bodyFont}`;
  context.fillText(date, padding, cursor);
  cursor += 72;

  context.fillStyle = colors.ink;
  context.font = `38px ${bodyFont}`;
  cursor = drawLines(context, lines, padding, cursor, 60);

  context.fillStyle = colors.accent;
  context.font = `700 28px ${bodyFont}`;
  context.textAlign = "right";
  context.fillText("回见", width - padding, Math.max(cursor + 96, canvas.height - 64));

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("export_encode_failed")), "image/png");
  });
}

export function downloadBlob(blob, filename, persistentAnchor = null) {
  const url = URL.createObjectURL(blob);
  const anchor = persistentAnchor ?? document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  if (!persistentAnchor) document.body.append(anchor);
  else anchor.hidden = false;
  anchor.click();
  if (!persistentAnchor) {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return url;
}
