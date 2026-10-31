"use strict";

/*
 * 无外部依赖的全景几何测试夹具。
 *
 * 所有透视帧都从同一张周期连续的 2:1 等距柱状真值图生成，因此测试能够
 * 区分“只是非黑/走到 100%”和“照片真的落在正确经纬位置”。
 */

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function wrap(value, size) {
  return ((value % size) + size) % size;
}

function hash2(x, y, seed) {
  let n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function longitudeDelta(a, b) {
  return ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function truthColor(lon, lat) {
  const waves =
    0.48 +
    0.16 * Math.sin(lon * 5 + lat * 3.1) +
    0.12 * Math.cos(lon * 11 - lat * 6.3) +
    0.08 * Math.sin(lon * 19 + lat * 9.7);
  const longitudeGrid = Math.pow(Math.max(0, Math.cos(lon * 12)), 18);
  const latitudeGrid = Math.pow(Math.max(0, Math.cos((lat + Math.PI / 2) * 12)), 18);
  const cellX = Math.floor((lon + Math.PI * 2) / (Math.PI / 12));
  const cellY = Math.floor((lat + Math.PI / 2) / (Math.PI / 12));
  const cellNoise = hash2(cellX, cellY, 17) - 0.5;
  let landmarkR = 0;
  let landmarkG = 0;
  let landmarkB = 0;
  const landmarks = [
    [-2.74, 0.18, 1.0, 0.1, 0.1],
    [-1.83, -0.62, 0.1, 1.0, 0.2],
    [-0.92, 0.74, 0.1, 0.25, 1.0],
    [0.16, -0.28, 1.0, 0.85, 0.1],
    [1.17, 0.48, 0.85, 0.1, 1.0],
    [2.35, -0.73, 0.1, 1.0, 0.9],
    [3.02, 0.83, 1.0, 0.35, 0.05]
  ];
  for (const mark of landmarks) {
    const dx = longitudeDelta(lon, mark[0]) * Math.cos(mark[1]);
    const dy = lat - mark[1];
    const strength = Math.exp(-(dx * dx + dy * dy) / 0.012);
    landmarkR += strength * mark[2];
    landmarkG += strength * mark[3];
    landmarkB += strength * mark[4];
  }
  const grid = 0.17 * Math.max(longitudeGrid, latitudeGrid);
  const horizon = 0.12 * Math.cos(lat * 2);
  return [
    clamp(255 * (waves + horizon + grid + 0.16 * cellNoise + 0.42 * landmarkR), 0, 255),
    clamp(255 * (0.28 + 0.42 * waves - horizon + grid * 0.65 +
      0.12 * cellNoise + 0.42 * landmarkG), 0, 255),
    clamp(255 * (0.72 - 0.38 * waves + grid * 0.4 -
      0.1 * cellNoise + 0.42 * landmarkB), 0, 255)
  ];
}

function createTruthPanorama(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const lat = Math.PI / 2 - (y + 0.5) / height * Math.PI;
    for (let x = 0; x < width; x += 1) {
      const lon = x / width * Math.PI * 2;
      const rgb = truthColor(lon, lat);
      const i = (y * width + x) * 4;
      pixels[i] = rgb[0];
      pixels[i + 1] = rgb[1];
      pixels[i + 2] = rgb[2];
      pixels[i + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function samplePanorama(panorama, lon, lat) {
  const x = lon / (Math.PI * 2) * panorama.width - 0.5;
  const y = (Math.PI / 2 - lat) / Math.PI * panorama.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = clamp(Math.floor(y), 0, panorama.height - 1);
  const x1 = x0 + 1;
  const y1 = Math.min(panorama.height - 1, y0 + 1);
  const tx = x - Math.floor(x);
  const ty = y - Math.floor(y);
  const rgba = [0, 0, 0, 255];
  for (let channel = 0; channel < 3; channel += 1) {
    const a = panorama.pixels[(y0 * panorama.width + wrap(x0, panorama.width)) * 4 + channel];
    const b = panorama.pixels[(y0 * panorama.width + wrap(x1, panorama.width)) * 4 + channel];
    const c = panorama.pixels[(y1 * panorama.width + wrap(x0, panorama.width)) * 4 + channel];
    const d = panorama.pixels[(y1 * panorama.width + wrap(x1, panorama.width)) * 4 + channel];
    rgba[channel] =
      (a * (1 - tx) + b * tx) * (1 - ty) +
      (c * (1 - tx) + d * tx) * ty;
  }
  return rgba;
}

function renderPerspective(P, panorama, width, height, basis, fovXDeg) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const aspect = width / height;
  for (let y = 0; y < height; y += 1) {
    const ny = 1 - y / Math.max(1, height - 1) * 2;
    for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(1, width - 1) * 2 - 1;
      const dir = P.directionFromImagePoint(nx, ny, basis, fovXDeg, aspect);
      const lon = ((Math.atan2(dir[0], dir[1]) % (Math.PI * 2)) + Math.PI * 2) %
        (Math.PI * 2);
      const lat = Math.asin(clamp(dir[2], -1, 1));
      const rgba = samplePanorama(panorama, lon, lat);
      const i = (y * width + x) * 4;
      pixels[i] = rgba[0];
      pixels[i + 1] = rgba[1];
      pixels[i + 2] = rgba[2];
      pixels[i + 3] = 255;
    }
  }
  return { width, height, pixels, basis, fovXDeg };
}

function boxBlur(pixels, width, height, radius) {
  if (!radius) return new Uint8ClampedArray(pixels);
  let source = new Uint8ClampedArray(pixels);
  let target = new Uint8ClampedArray(pixels.length);
  for (let pass = 0; pass < 2; pass += 1) {
    const horizontal = pass === 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const count = radius * 2 + 1;
        const index = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          let sum = 0;
          for (let offset = -radius; offset <= radius; offset += 1) {
            const sx = horizontal ? clamp(x + offset, 0, width - 1) : x;
            const sy = horizontal ? y : clamp(y + offset, 0, height - 1);
            sum += source[(sy * width + sx) * 4 + channel];
          }
          target[index + channel] = sum / count;
        }
        target[index + 3] = 255;
      }
    }
    source = target;
    target = new Uint8ClampedArray(pixels.length);
  }
  return source;
}

function makeRng(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function perturbPixels(frame, options = {}) {
  const random = makeRng(options.seed == null ? 1 : options.seed);
  const blurred = boxBlur(frame.pixels, frame.width, frame.height, options.blurRadius || 0);
  const pixels = new Uint8ClampedArray(blurred.length);
  const gain = options.gain == null ? 1 : options.gain;
  const bias = options.bias == null ? 0 : options.bias;
  const noise = options.noise == null ? 0 : options.noise;
  for (let i = 0; i < blurred.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const jitter = (random() * 2 - 1) * noise;
      pixels[i + channel] = clamp(blurred[i + channel] * gain + bias + jitter, 0, 255);
    }
    pixels[i + 3] = 255;
  }
  return {
    width: frame.width,
    height: frame.height,
    pixels,
    basis: frame.basis,
    fovXDeg: frame.fovXDeg
  };
}

function randomNoiseFrame(width, height, seed) {
  const random = makeRng(seed);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = random() * 255;
    pixels[i + 1] = random() * 255;
    pixels[i + 2] = random() * 255;
    pixels[i + 3] = 255;
  }
  return { width, height, pixels };
}

function luma(pixels, index) {
  return pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 +
    pixels[index + 2] * 0.0722;
}

function maskedMetrics(actual, expected, weights, options = {}) {
  const minWeight = options.minWeight == null ? 0.01 : options.minWeight;
  const blockSize = options.blockSize || 12;
  let absoluteError = 0;
  let squaredError = 0;
  let count = 0;
  const width = actual.width;
  const height = actual.height;
  for (let i = 0; i < weights.length; i += 1) {
    if (weights[i] < minWeight) continue;
    const p = i * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = actual.pixels[p + channel] - expected.pixels[p + channel];
      absoluteError += Math.abs(delta);
      squaredError += delta * delta;
      count += 1;
    }
  }
  let ssimSum = 0;
  let ssimBlocks = 0;
  const c1 = 6.5025;
  const c2 = 58.5225;
  for (let by = 0; by < height; by += blockSize) {
    for (let bx = 0; bx < width; bx += blockSize) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      let n = 0;
      for (let y = by; y < Math.min(height, by + blockSize); y += 1) {
        for (let x = bx; x < Math.min(width, bx + blockSize); x += 1) {
          const pixelIndex = y * width + x;
          if (weights[pixelIndex] < minWeight) continue;
          const p = pixelIndex * 4;
          const a = luma(actual.pixels, p);
          const b = luma(expected.pixels, p);
          sumA += a;
          sumB += b;
          sumAA += a * a;
          sumBB += b * b;
          sumAB += a * b;
          n += 1;
        }
      }
      if (n < blockSize) continue;
      const meanA = sumA / n;
      const meanB = sumB / n;
      const varA = Math.max(0, sumAA / n - meanA * meanA);
      const varB = Math.max(0, sumBB / n - meanB * meanB);
      const covariance = sumAB / n - meanA * meanB;
      const ssim = ((2 * meanA * meanB + c1) * (2 * covariance + c2)) /
        ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
      ssimSum += ssim;
      ssimBlocks += 1;
    }
  }
  return {
    mae: count ? absoluteError / count : Infinity,
    rmse: count ? Math.sqrt(squaredError / count) : Infinity,
    ssim: ssimBlocks ? ssimSum / ssimBlocks : -1,
    comparedChannels: count,
    ssimBlocks
  };
}

function seamError(raster, expected) {
  let actualError = 0;
  let expectedError = 0;
  let rows = 0;
  const width = raster.width;
  for (let y = 0; y < raster.height; y += 1) {
    const left = y * width;
    const right = y * width + width - 1;
    if (raster.weights[left] <= 0 || raster.weights[right] <= 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      actualError += Math.abs(
        raster.pixels[left * 4 + channel] - raster.pixels[right * 4 + channel]
      );
      expectedError += Math.abs(
        expected.pixels[left * 4 + channel] - expected.pixels[right * 4 + channel]
      );
    }
    rows += 1;
  }
  return {
    actual: rows ? actualError / (rows * 3) : Infinity,
    expected: rows ? expectedError / (rows * 3) : Infinity,
    excess: rows ? (actualError - expectedError) / (rows * 3) : Infinity,
    rows
  };
}

module.exports = {
  createTruthPanorama,
  renderPerspective,
  perturbPixels,
  randomNoiseFrame,
  maskedMetrics,
  seamError
};
