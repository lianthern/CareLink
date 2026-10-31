export const JELLY_PRESETS = Object.freeze({
  soft: Object.freeze({
    label: "软糯",
    stiffness: 72,
    damping: 12,
    radius: 0.46,
    pull: 0.76,
    wobble: 0.56,
    pitch: 0.86
  }),
  bounce: Object.freeze({
    label: "Q 弹",
    stiffness: 132,
    damping: 7.4,
    radius: 0.37,
    pull: 0.9,
    wobble: 1,
    pitch: 1.08
  }),
  sticky: Object.freeze({
    label: "黏稠",
    stiffness: 44,
    damping: 15.5,
    radius: 0.54,
    pull: 1.02,
    wobble: 0.34,
    pitch: 0.68
  })
});

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function stepSpring(position, velocity, target, preset, deltaSeconds) {
  const delta = clamp(deltaSeconds, 0, 1 / 30);
  const acceleration = (target - position) * preset.stiffness;
  const nextVelocity = (velocity + acceleration * delta) * Math.exp(-preset.damping * delta);
  return {
    position: position + nextVelocity * delta,
    velocity: nextVelocity
  };
}

export function releaseEnergy(offsetX, offsetY, velocityX, velocityY) {
  const distance = Math.hypot(offsetX, offsetY);
  const speed = Math.hypot(velocityX, velocityY);
  return clamp(distance * 0.36 + speed * 0.045, 0.08, 1);
}

export function fitPhoto(aspect, viewWidth, viewHeight) {
  const safeAspect = clamp(aspect, 0.58, 2.1);
  let height = Math.min(4.18, viewHeight * 0.7);
  let width = height * safeAspect;
  const maxWidth = viewWidth * 0.84;
  if (width > maxWidth) {
    width = maxWidth;
    height = width / safeAspect;
  }
  return { width, height, aspect: safeAspect };
}
