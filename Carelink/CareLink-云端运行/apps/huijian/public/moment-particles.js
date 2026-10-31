const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
const TAU = Math.PI * 2;

/** Geometry is shared by the photo and every sampled particle. */
export function photoCoverRect(imageWidth, imageHeight, width, height) {
  const scale = Math.max(width / Math.max(1, imageWidth), height / Math.max(1, imageHeight));
  const drawnWidth = imageWidth * scale;
  const drawnHeight = imageHeight * scale;
  return { x: (width - drawnWidth) / 2, y: (height - drawnHeight) / 2, width: drawnWidth, height: drawnHeight };
}

/**
 * A dependency-free photo field. The canvas paints the original photo plus
 * particles sampled from it; it never changes the source supplied to the API.
 * Provide a CSS width AND height/aspect-ratio on the canvas or its parent.
 */
export function mountMomentParticles({
  canvas, src, mode = "reveal", progress = 0, reducedMotion,
  document: page = globalThis.document,
  window: windowTarget = globalThis.window,
  Image: ImageClass = globalThis.Image,
  ResizeObserver: Resize = globalThis.ResizeObserver,
  requestAnimationFrame: requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelAnimationFrame: cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  onError = () => {}
} = {}) {
  let dead = false;
  let image = null;
  let loaded = false;
  let width = 1;
  let height = 1;
  let frame = null;
  let lastFrame = -Infinity;
  let level = 0;
  let envelope = 0;
  let activeMode = mode === "clear" ? "clear" : "reveal";
  let targetProgress = clamp(progress);
  let visibleProgress = targetProgress;
  let particles = [];
  let sharpLayer = null;
  let mistLayer = null;
  let isVisible = true;
  const motionQuery = windowTarget?.matchMedia?.("(prefers-reduced-motion: reduce)");
  let motionReduced = reducedMotion ?? motionQuery?.matches ?? false;
  const context = canvas?.getContext?.("2d", { alpha: false });
  const lowPower = (globalThis.navigator?.hardwareConcurrency ?? 8) <= 4;
  const frameInterval = lowPower ? 50 : 1000 / 30;
  const dpr = () => clamp(windowTarget?.devicePixelRatio ?? 1, 1, 2);
  const running = () => !dead && loaded && !page?.hidden && isVisible;
  const createCanvas = (w, h) => {
    const layer = page.createElement("canvas");
    layer.width = Math.max(1, Math.round(w));
    layer.height = Math.max(1, Math.round(h));
    return layer;
  };

  function resize() {
    if (dead || !context || !image || !loaded) return;
    const bounds = canvas.getBoundingClientRect?.() ?? {};
    const parentBounds = canvas.parentElement?.getBoundingClientRect?.() ?? {};
    width = Math.max(1, Math.round(bounds.width || parentBounds.width || canvas.width || 400));
    height = Math.max(1, Math.round(bounds.height || parentBounds.height || width * .8));
    canvas.width = Math.round(width * dpr());
    canvas.height = Math.round(height * dpr());
    context.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    const rect = photoCoverRect(image.naturalWidth || image.width, image.naturalHeight || image.height, width, height);
    sharpLayer = createCanvas(canvas.width, canvas.height);
    const sharp = sharpLayer.getContext("2d", { alpha: false });
    sharp.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    sharp.drawImage(image, rect.x, rect.y, rect.width, rect.height);

    // Blur once when the layout changes, never on each animation frame.
    const tiny = createCanvas(Math.min(42, width / 9), Math.min(42, height / 9));
    tiny.getContext("2d", { alpha: false }).drawImage(sharpLayer, 0, 0, tiny.width, tiny.height);
    mistLayer = createCanvas(canvas.width, canvas.height);
    const mist = mistLayer.getContext("2d", { alpha: false });
    mist.filter = `blur(${Math.max(7, width * .025) * dpr()}px)`;
    const bleed = Math.max(16, width * .04) * dpr();
    mist.drawImage(tiny, -bleed, -bleed, mistLayer.width + bleed * 2, mistLayer.height + bleed * 2);
    mist.filter = "none";

    const sample = createCanvas(64, 64);
    const sampleContext = sample.getContext("2d", { willReadFrequently: true });
    sampleContext.drawImage(sharpLayer, 0, 0, 64, 64);
    let pixels = null;
    try { pixels = sampleContext.getImageData(0, 0, 64, 64).data; } catch { /* cross-origin images keep a legible photo and a neutral field */ }
    const count = Math.min(lowPower ? 200 : 420, Math.max(100, Math.round(width * height / 950)));
    particles = Array.from({ length: count }, (_, index) => {
      // Stable low-discrepancy positions, so resizing doesn't randomly flicker.
      const u = ((index + .5) * .61803398875) % 1;
      const v = ((index + .5) * .754877666) % 1;
      const offset = (Math.min(63, Math.floor(v * 64)) * 64 + Math.min(63, Math.floor(u * 64))) * 4;
      const red = pixels?.[offset] ?? 236;
      const green = pixels?.[offset + 1] ?? 220;
      const blue = pixels?.[offset + 2] ?? 199;
      return { u, v, color: `rgb(${red},${green},${blue})`, phase: (index * 2.39996323) % TAU, radius: .8 + (index % 7) * .23 };
    });
    draw(now(), true);
    schedule();
  }

  function draw(time, immediate = false) {
    if (!context || !image || dead || !sharpLayer || !mistLayer) return;
    if (immediate || motionReduced) visibleProgress = targetProgress;
    else visibleProgress += (targetProgress - visibleProgress) * .065;
    envelope += (level - envelope) * .18;
    const reveal = activeMode === "clear" ? 1 : visibleProgress;
    context.globalAlpha = 1;
    context.drawImage(mistLayer, 0, 0, width, height);
    context.globalAlpha = activeMode === "clear" ? 1 : .12 + reveal * .88;
    context.drawImage(sharpLayer, 0, 0, width, height);
    context.globalAlpha = (1 - reveal) * .12;
    context.fillStyle = "#e6dbea";
    context.fillRect(0, 0, width, height);
    const seconds = motionReduced ? 0 : time / 1000;
    const movement = motionReduced ? 0 : (1.5 + (1 - reveal) * 8 + envelope * 10);
    for (const particle of particles) {
      const driftX = Math.sin(seconds * .42 + particle.phase) * movement;
      const driftY = Math.cos(seconds * .33 + particle.phase * 1.3) * movement * .65;
      const x = particle.u * width + driftX;
      const y = particle.v * height + driftY;
      const pulse = motionReduced ? .6 : .55 + .45 * Math.sin(seconds * .7 + particle.phase);
      const radius = particle.radius * (1 + (1 - reveal) * .8 + envelope * .6);
      context.globalAlpha = (.2 + (1 - reveal) * .4 + envelope * .12) * (.55 + pulse * .45);
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(x, y, radius, 0, TAU);
      context.fill();
      // A small soft glint separates the field from the source photo at rest.
      if (particle.phase < 1.25) {
        context.globalAlpha *= .48;
        context.fillStyle = "#fff9e9";
        context.beginPath();
        context.arc(x, y, radius * .45, 0, TAU);
        context.fill();
      }
    }
    context.globalAlpha = 1;
  }

  function tick(time) {
    frame = null;
    if (!running() || motionReduced) return;
    if (time - lastFrame >= frameInterval) { draw(time); lastFrame = time; }
    schedule();
  }
  function schedule() {
    if (frame == null && running() && !motionReduced && requestFrame) frame = requestFrame(tick);
  }
  function pause() {
    if (frame != null) cancelFrame?.(frame);
    frame = null;
  }
  const visibility = () => { if (!running()) pause(); else { draw(now(), true); schedule(); } };
  const motionChanged = () => {
    if (reducedMotion !== undefined) return;
    motionReduced = motionQuery.matches;
    if (motionReduced) pause();
    draw(now(), true);
    schedule();
  };
  const observer = typeof Resize === "function" ? new Resize(resize) : null;
  if (canvas) observer?.observe(canvas);
  const Intersection = windowTarget?.IntersectionObserver ?? globalThis.IntersectionObserver;
  const intersection = typeof Intersection === "function" ? new Intersection((entries) => {
    isVisible = entries[0]?.isIntersecting ?? true;
    visibility();
  }) : null;
  if (canvas) intersection?.observe(canvas);
  page?.addEventListener?.("visibilitychange", visibility);
  windowTarget?.addEventListener?.("resize", resize);
  motionQuery?.addEventListener?.("change", motionChanged);

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  if (!context || !src || typeof ImageClass !== "function" || !page?.createElement) {
    resolveReady(false);
  } else {
    const candidate = new ImageClass();
    image = candidate;
    candidate.decoding = "async";
    // Blob/data URLs and authenticated same-origin image URLs need no CORS mode.
    candidate.onload = () => {
      if (dead) return;
      loaded = true;
      try { resize(); resolveReady(true); }
      catch { loaded = false; onError({ code: "render-failed" }); resolveReady(false); }
    };
    candidate.onerror = () => { if (!dead) onError({ code: "image-unavailable" }); resolveReady(false); };
    candidate.src = src;
  }

  return {
    ready,
    setProgress(value) { targetProgress = clamp(value); if (motionReduced || !requestFrame) draw(now(), true); else schedule(); },
    setMode(value) { activeMode = value === "clear" ? "clear" : "reveal"; draw(now(), true); schedule(); },
    setLevel(value) { level = clamp(value); if (!motionReduced) schedule(); },
    destroy() {
      if (dead) return;
      dead = true;
      pause();
      observer?.disconnect();
      intersection?.disconnect();
      page?.removeEventListener?.("visibilitychange", visibility);
      windowTarget?.removeEventListener?.("resize", resize);
      motionQuery?.removeEventListener?.("change", motionChanged);
      if (image) { image.onload = image.onerror = null; image.src = ""; }
      image = sharpLayer = mistLayer = null;
      particles = [];
      context?.clearRect(0, 0, width, height);
      resolveReady(false);
    }
  };
}
