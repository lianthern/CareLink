import { createDemoMemoryField } from "./spatial-memory-field.js";

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createResizeController({ isActive, field, onState = () => {} }) {
  let timer = 0;
  return {
    schedule() {
      onState(false);
      field.stop({ keepWanted: true });
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        if (isActive()) onState(field.resize());
      }, 140);
    },
    clear() {
      clearTimeout(timer);
      timer = 0;
    }
  };
}

export function createSpatialPhoto({
  stage,
  image,
  canvas,
  onStatus = () => {},
  onAvailabilityChange = () => {},
  createField = createDemoMemoryField
}) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };
  const host = canvas?.parentElement ?? stage;
  const structurallySupported = Boolean(stage && host && image && canvas);
  let enabled = false;
  const setFieldVisible = (visible) => stage?.classList?.toggle("has-memory-field", Boolean(visible));
  const field = createField({
    host,
    image,
    canvas,
    reducedMotion,
    onSettled: () => {
      if (enabled) onStatus("照片已经成型，仍在轻轻流动。", { transient: true });
    },
    onSupportChange: (available) => {
      if (!available) setFieldVisible(false);
      onAvailabilityChange(Boolean(available));
    }
  });
  const resize = createResizeController({ isActive: () => enabled, field, onState: setFieldVisible });
  const available = () => structurallySupported && field.isSupported();

  function clearInteraction() {
    field.clearPointer();
  }

  function startField({ replay = false, forceRebuild = false } = {}) {
    if (reducedMotion.matches) {
      field.stop({ keepWanted: true });
      setFieldVisible(false);
      onStatus("已按减少动态效果显示原始照片。", { transient: true });
      return false;
    }
    const started = replay ? field.replay() : field.start({ forceRebuild });
    setFieldVisible(started);
    onStatus(
      started ? "照片正在重新聚拢；成型后粒子会持续流动。" : "当前设备会保持原始照片。",
      { transient: true }
    );
    return started;
  }

  function setEnabled(next) {
    if (next && !available()) {
      onStatus("当前设备会保持原始照片。", { transient: true });
      onAvailabilityChange(false);
      return false;
    }
    enabled = Boolean(next);
    stage.classList.toggle("is-spatial", enabled);
    clearInteraction();
    if (enabled) startField();
    else {
      resize.clear();
      stage.classList.toggle("is-listening", false);
      setFieldVisible(false);
      field.setListening(false);
      field.setAudioLevel(0);
      field.stop();
      onStatus("");
    }
    return enabled;
  }

  const handlePointerMove = (event) => {
    if (!enabled || reducedMotion.matches || event.pointerType === "touch") return;
    field.setPointer(event.clientX, event.clientY, true);
  };
  const handlePointerExit = () => {
    if (enabled) clearInteraction();
  };
  const handleImageLoad = () => {
    if (enabled) startField({ forceRebuild: true });
  };
  const pauseField = () => {
    if (!enabled) return;
    clearInteraction();
    setFieldVisible(false);
    field.stop({ keepWanted: true });
  };
  const resumeField = () => {
    if (enabled && !document.hidden && !reducedMotion.matches) setFieldVisible(field.start());
  };
  const handleVisibility = () => document.hidden ? pauseField() : resumeField();
  const handleMotionChange = () => {
    pauseField();
    if (!reducedMotion.matches) resumeField();
    onAvailabilityChange(available());
  };

  stage.addEventListener("pointermove", handlePointerMove);
  stage.addEventListener("pointerleave", handlePointerExit);
  image.addEventListener("load", handleImageLoad);
  window.addEventListener?.("blur", pauseField);
  window.addEventListener?.("focus", resumeField);
  window.addEventListener?.("scroll", handlePointerExit, { passive: true });
  window.addEventListener?.("beforeprint", pauseField);
  window.addEventListener?.("afterprint", resumeField);
  window.addEventListener?.("resize", resize.schedule, { passive: true });
  document.addEventListener?.("visibilitychange", handleVisibility);
  if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", handleMotionChange);
  else reducedMotion.addListener?.(handleMotionChange);

  return {
    setEnabled,
    replay() {
      if (!enabled) return setEnabled(true);
      clearInteraction();
      return startField({ replay: true });
    },
    setListening(active) {
      const listening = enabled && Boolean(active);
      stage.classList.toggle("is-listening", listening);
      field.setListening(listening);
    },
    setAudioLevel(level) {
      field.setAudioLevel(enabled ? clamp(Number(level) || 0) : 0);
    },
    isEnabled: () => enabled,
    isAvailable: available,
    reset() {
      resize.clear();
      field.reset();
      enabled = false;
      stage.classList.toggle("is-listening", false);
      stage.classList.toggle("is-spatial", false);
      setFieldVisible(false);
    }
  };
}

export function createSpatialResultField({
  stage,
  image,
  canvas,
  createField = createDemoMemoryField
}) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };
  const host = canvas?.parentElement ?? stage;
  const isActive = () => stage?.dataset?.shape === "spatial" && document.body?.dataset?.screen === "result";
  const setFieldVisible = (visible) => stage?.classList?.toggle("has-memory-field", Boolean(visible));
  const field = createField({
    host,
    image,
    canvas,
    reducedMotion,
    onSupportChange: (available) => {
      if (!available) setFieldVisible(false);
    }
  });
  const resize = createResizeController({ isActive, field, onState: setFieldVisible });

  const syncField = ({ forceRebuild = false } = {}) => {
    if (isActive() && !reducedMotion.matches) setFieldVisible(field.start({ forceRebuild }));
    else {
      setFieldVisible(false);
      field.stop({ keepWanted: isActive() });
    }
  };
  const clearInteraction = () => field.clearPointer();
  const handlePointerMove = (event) => {
    if (!isActive() || reducedMotion.matches || event.pointerType === "touch") return;
    field.setPointer(event.clientX, event.clientY, true);
  };
  const pauseField = () => {
    clearInteraction();
    if (isActive()) {
      setFieldVisible(false);
      field.stop({ keepWanted: true });
    }
  };
  const resumeField = () => {
    if (isActive() && !document.hidden && !reducedMotion.matches) setFieldVisible(field.start());
  };
  const handleVisibility = () => document.hidden ? pauseField() : resumeField();
  const handleMotionChange = () => {
    pauseField();
    syncField();
  };
  const handleImageLoad = () => syncField({ forceRebuild: true });

  stage.addEventListener("pointermove", handlePointerMove);
  stage.addEventListener("pointerleave", clearInteraction);
  image?.addEventListener?.("load", handleImageLoad);
  window.addEventListener?.("blur", pauseField);
  window.addEventListener?.("focus", resumeField);
  window.addEventListener?.("scroll", clearInteraction, { passive: true });
  window.addEventListener?.("beforeprint", pauseField);
  window.addEventListener?.("afterprint", resumeField);
  window.addEventListener?.("resize", resize.schedule, { passive: true });
  document.addEventListener?.("visibilitychange", handleVisibility);
  if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", handleMotionChange);
  else reducedMotion.addListener?.(handleMotionChange);

  const observer = typeof MutationObserver === "function"
    ? new MutationObserver(() => {
      if (!isActive()) clearInteraction();
      syncField();
    })
    : null;
  observer?.observe(stage, { attributes: true, attributeFilter: ["data-shape"] });
  if (document.body) observer?.observe(document.body, { attributes: true, attributeFilter: ["data-screen"] });
  syncField();

  return {
    reset: clearInteraction,
    resetSession() {
      resize.clear();
      setFieldVisible(false);
      field.reset();
      clearInteraction();
    },
    destroy() {
      resize.clear();
      observer?.disconnect();
      stage.removeEventListener("pointermove", handlePointerMove);
      stage.removeEventListener("pointerleave", clearInteraction);
      image?.removeEventListener?.("load", handleImageLoad);
      window.removeEventListener?.("blur", pauseField);
      window.removeEventListener?.("focus", resumeField);
      window.removeEventListener?.("scroll", clearInteraction);
      window.removeEventListener?.("beforeprint", pauseField);
      window.removeEventListener?.("afterprint", resumeField);
      window.removeEventListener?.("resize", resize.schedule);
      document.removeEventListener?.("visibilitychange", handleVisibility);
      if (reducedMotion.removeEventListener) reducedMotion.removeEventListener("change", handleMotionChange);
      else reducedMotion.removeListener?.(handleMotionChange);
      setFieldVisible(false);
      field.destroy();
    }
  };
}

export { clamp };
