import test from "node:test";
import assert from "node:assert/strict";
import { albumPage, photoPage } from "../src/ui/templates.js";

// Video upload v0: photoPage() renders a native <video> (poster + controls, zero player
// dependency per the brief) for a video-backed photo, and keeps the existing <img> path
// untouched for a plain photo. See services/api/src/viewer-media-service.mjs's photoDetail()
// for where photo.mediaType/photo.videoAsset come from on the wire.

function withStubbedGlobals(pathname, run) {
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  globalThis.document = { title: "" };
  globalThis.location = { pathname, search: "" };
  try { return run(); }
  finally { globalThis.document = priorDocument; globalThis.location = priorLocation; }
}

const baseState = { account: null, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false, uiProductizationFixture: false };

test("photoPage: a video photo with a verified video blob URL renders a native <video> with the poster as its poster attribute", () => {
  withStubbedGlobals("/s/space-1/photos/photo-1", () => {
    const photo = { id: "photo-1", title: "视频一", asset: "blob:poster-url", videoAsset: "blob:video-url",
      uploader: "林野", contentState: "visible", placementState: "confirmed", confirmationMode: "manual", mediaType: "video" };
    const html = photoPage(baseState, photo);
    assert.match(html, /<video src="blob:video-url" poster="blob:poster-url" controls playsinline preload="metadata"/);
    assert.doesNotMatch(html, /<img src="blob:poster-url"/);
  });
});

test("photoPage: a video photo whose bytes failed verification (no videoAsset yet) shows a stopped-rendering message, not a broken <video>", () => {
  withStubbedGlobals("/s/space-1/photos/photo-1", () => {
    const photo = { id: "photo-1", title: "视频一", asset: "", videoAsset: "", uploader: "林野",
      contentState: "visible", placementState: "processing", mediaType: "video" };
    const html = photoPage(baseState, photo);
    assert.match(html, /视频字节校验未通过，已停止显示/);
    assert.doesNotMatch(html, /<video/);
  });
});

test("photoPage: a plain photo (mediaType='photo' or absent) is unaffected -- still a plain <img>", () => {
  withStubbedGlobals("/s/space-1/photos/photo-1", () => {
    const photo = { id: "photo-1", title: "照片一", asset: "blob:photo-url", uploader: "林野",
      contentState: "visible", placementState: "confirmed", confirmationMode: "manual", mediaType: "photo" };
    const html = photoPage(baseState, photo);
    assert.match(html, /<img src="blob:photo-url" alt="照片一">/);
    assert.doesNotMatch(html, /<video/);
  });
});

test("photoPage: video attributes are esc()-safe against a hostile asset URL", () => {
  withStubbedGlobals("/s/space-1/photos/photo-1", () => {
    const photo = { id: "photo-1", title: "视频一", asset: '"><script>1</script>', videoAsset: '"><script>2</script>',
      uploader: "林野", contentState: "visible", placementState: "confirmed", confirmationMode: "manual", mediaType: "video" };
    const html = photoPage(baseState, photo);
    assert.doesNotMatch(html, /<script>/);
  });
});

// Album grid video corner mark (small companion task alongside the audio-track follow-up): the
// grid gave no visual cue that a tile was a video versus a still photo until you opened its
// detail page, where the mediaType==='video' branch above already switches in a <video> element.
// This adds a play-glyph badge (see ui/icons.js's "play" path) on the grid tile itself, in the
// opposite corner from the existing status badge-dot (top-right, see .photo-card-copy) and clear
// of the bottom-anchored .photo-signature scrim strip.
const baseAlbumState = { account: null, capabilities: {}, spaces: [], currentSpaceId: "space-1", debug: false, uiProductizationFixture: false };

test("albumPage: a video-backed photo gets a play-icon corner badge on its grid tile", () => {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    const viewer = { name: "Test Space", effectiveCanUpload: true, photos: [
      { id: "p-video", title: "回忆视频", asset: "/poster.jpg", placementState: "confirmed", confirmationMode: "manual", mediaType: "video" }
    ] };
    const html = albumPage(baseAlbumState, viewer);
    assert.match(html, /<span class="photo-card-video-badge" aria-hidden="true">/);
    assert.match(html, /class="icon"[^>]*><path d="M8 5v14l11-7Z"/);
  } finally { globalThis.document = priorDocument; }
});

test("albumPage: a plain photo (mediaType='photo' or absent) gets no video badge on its grid tile", () => {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    const viewer = { name: "Test Space", effectiveCanUpload: true, photos: [
      { id: "p-photo", title: "普通照片", asset: "/photo.jpg", placementState: "confirmed", confirmationMode: "manual", mediaType: "photo" },
      { id: "p-legacy", title: "无 mediaType 字段", asset: "/legacy.jpg", placementState: "confirmed", confirmationMode: "manual" }
    ] };
    const html = albumPage(baseAlbumState, viewer);
    assert.doesNotMatch(html, /photo-card-video-badge/);
  } finally { globalThis.document = priorDocument; }
});

test("albumPage: the video badge coexists with the placement status dot without replacing it", () => {
  const priorDocument = globalThis.document;
  globalThis.document = { title: "" };
  try {
    const viewer = { name: "Test Space", effectiveCanUpload: true, photos: [
      { id: "p-video-auto", title: "AI 落位的视频", asset: "/poster.jpg", placementState: "confirmed", confirmationMode: "auto", mediaType: "video" }
    ] };
    const html = albumPage(baseAlbumState, viewer);
    assert.match(html, /photo-card-video-badge/);
    assert.match(html, /badge-dot-info/);
  } finally { globalThis.document = priorDocument; }
});
