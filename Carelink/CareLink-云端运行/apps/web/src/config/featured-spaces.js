import { TEMPLATE_SPACE_COVER, TEMPLATE_SPACE_NAME } from "./demo-space.js";

export const SUMMER_GATHERING_OPEN_PATH = "/open/YciUvosxbNRSuxDCqNEBmk5u0hiQuEpIoIADW6davHw";
export const ADVENTUREX_OPEN_PATH = "/open/0iM0Lj48vhMz5gAPm4h-a9pV7BANC41TiZJH1aNUyWI";

const publicSpaceCovers = Object.freeze({
  [ADVENTUREX_OPEN_PATH]: "/assets/brand/adventurex-cover.jpg",
  [SUMMER_GATHERING_OPEN_PATH]: TEMPLATE_SPACE_COVER
});

function publicOpenPath(value) {
  try { return new URL(value, "https://unseen.maxxam.xyz").pathname; }
  catch { return ""; }
}

export function coverForPublicSpaceUrl(url) {
  return publicSpaceCovers[publicOpenPath(url)] || "";
}

export function coverForCampaignId(campaignId) {
  return publicSpaceCovers[`/open/${campaignId}`] || "";
}

// Static v0 catalog for the "逛逛空间" (discover) page. Each entry is rendered as a
// cover card (see discoverPage in ui/templates.js). `url` must be validated by
// the caller (see `isAllowedFeaturedSpaceUrl` in ui/templates.js) before it is
// rendered or navigated to: only the production UNSEEN origin or a relative
// in-app path is allowed. `cover` is optional — omit it (or leave it empty) to
// fall back to the gradient placeholder.
export const featuredSpaces = [
  {
    title: TEMPLATE_SPACE_NAME,
    description: "AI 生成的夏日聚会：花园全景 + 6 张朋友随手拍，照片已回到现场",
    cover: TEMPLATE_SPACE_COVER,
    url: `https://unseen.maxxam.xyz${SUMMER_GATHERING_OPEN_PATH}`
  }
];
