// V2 is a presentation over canonical spaces, never a second store of photos.
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function photoRows(spaceId, photos = []) {
  const seen = new Set();
  return photos
    .filter((p) => {
      const id = p.id || p.photoId;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return !p.video;
    })
    .map((p) => ({
      ...p,
      id: p.id || p.photoId,
      url: `/v1/viewer/spaces/${encodeURIComponent(spaceId)}/photos/${encodeURIComponent(p.id || p.photoId)}/album-media`,
    }));
}
export function frameWindow(length, position) {
  const current = Math.max(
    0,
    Math.min(Math.max(0, length - 1), Math.round(Number(position) || 0)),
  );
  const start = Math.max(0, Math.min(current - 3, length - 7));
  return {
    current,
    indices: Array.from({ length: Math.min(7, length) }, (_, i) => start + i),
  };
}
export function positionKey(account, space) {
  return `unseen.v2.position.${encodeURIComponent(account)}:${encodeURIComponent(space)}`;
}
export const sources = [
  ["photos", "一组照片", "先留下照片，即刻打开照片走廊。"],
  ["panorama", "全景照片", "保存完整全景，在同一个空间环顾现场。"],
  ["phone", "手机视频", "视频重建尚未开放，可以先收集照片。"],
  [
    "panoramic",
    "全景视频 / 多位置全景",
    "现场处理尚未开放，原片请先留在设备中。",
  ],
  ["empty", "暂时没有素材", "先留一个私密空间，邀请同行者补上视角。"],
];
export function versionStatus(job) {
  return (
    {
      submitting: "现场提交待确认",
      unknown: "现场结果待核对",
      processing: "现场正在生成",
      complete: job?.importedSpaceId
        ? "现场版本已保存"
        : "现场已生成，等待确认加入",
      failed: "现场生成失败",
      rejected: "现场生成未受理",
    }[job?.status] || "现场状态待核对"
  );
}
