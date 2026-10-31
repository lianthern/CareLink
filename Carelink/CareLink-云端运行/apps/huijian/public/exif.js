// 最小 EXIF 读取：只取 JPEG 的拍摄时间（DateTimeOriginal 0x9003，退而求其次 DateTime 0x0132）。
// 读不到就返回 null，调用方拿文件修改时间兜底。不引库，不管其他任何标签。

export function exifTimestamp(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xffd8) return null; // 不是 JPEG

    // 找 APP1/Exif 段
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      const size = view.getUint16(offset + 2);
      if (marker === 0xffe1 &&
          view.getUint32(offset + 4) === 0x45786966 /* "Exif" */) {
        return parseTiff(view, offset + 10);
      }
      if ((marker & 0xff00) !== 0xff00) return null;
      offset += 2 + size;
    }
  } catch { /* 任何解析失败都当作没有 EXIF */ }
  return null;
}

function parseTiff(view, tiff) {
  const little = view.getUint16(tiff) === 0x4949;
  const u16 = (at) => view.getUint16(at, little);
  const u32 = (at) => view.getUint32(at, little);
  if (u16(tiff + 2) !== 42) return null;

  const readIfd = (at) => {
    const entries = u16(at);
    const found = {};
    for (let index = 0; index < entries; index += 1) {
      const entry = at + 2 + index * 12;
      found[u16(entry)] = entry;
    }
    return found;
  };

  const ascii = (entry) => {
    const count = u32(entry + 4);
    const at = count > 4 ? tiff + u32(entry + 8) : entry + 8;
    let text = "";
    for (let index = 0; index < count && at + index < view.byteLength; index += 1) {
      const code = view.getUint8(at + index);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text;
  };

  const ifd0 = readIfd(tiff + u32(tiff + 4));
  let stamp = null;
  if (ifd0[0x8769]) {
    const exifIfd = readIfd(tiff + u32(ifd0[0x8769] + 8));
    if (exifIfd[0x9003]) stamp = ascii(exifIfd[0x9003]);
  }
  if (!stamp && ifd0[0x0132]) stamp = ascii(ifd0[0x0132]);
  if (!stamp) return null;

  // "YYYY:MM:DD HH:MM:SS" → 本地时间毫秒
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(stamp);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const ms = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(ms) && year > 1990 ? ms : null;
}
