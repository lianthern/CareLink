export const ROUTES = Object.freeze({
  BL01: "/labs/memories/photos/:photoId",
  BL02: "/labs/memories/:memoryId",
  BL03: "/labs/books/:bookId/contributions/:memoryId",
  BL04: "/manage/:spaceId/book-lab",
  BL05: "/manage/:spaceId/book-lab/:bookId/draft",
  BL06: "/s/:spaceId/books/:bookId/versions/:versionId"
});

export const PAGE_ACTIONS = Object.freeze({
  BL01: ["MEMORY.OPEN", "MEMORY.START_QUESTION", "MEMORY.SKIP"],
  BL02: ["MEMORY.SAVE_ANSWER_DRAFT", "MEMORY.REQUEST_FOLLOWUP", "MEMORY.CONFIRM", "MEMORY.WITHDRAW"],
  BL03: ["BOOK_MEMORY.AUTHORIZE", "BOOK_MEMORY.WITHDRAW"],
  BL04: ["BOOK.OPEN_LAB", "BOOK.CREATE", "BOOK.OPEN_DRAFT"],
  BL05: ["BOOK.GENERATE_PREVIEW", "BOOK.EDIT_TITLE", "BOOK.REMOVE_PAGE", "BOOK.REPLACE_PAGE_PHOTO", "BOOK.FREEZE", "BOOK.START_NEW_VERSION"],
  BL06: ["BOOK.OPEN_PREVIEW", "BOOK.DOWNLOAD_PDF"]
});

const matchers = [
  ["BL01", /^\/labs\/memories\/photos\/[^/]+\/?$/u],
  ["BL02", /^\/labs\/memories\/[^/]+\/?$/u],
  ["BL03", /^\/labs\/books\/[^/]+\/contributions\/[^/]+\/?$/u],
  ["BL04", /^\/manage\/[^/]+\/book-lab\/?$/u],
  ["BL05", /^\/manage\/[^/]+\/book-lab\/[^/]+\/draft\/?$/u],
  ["BL06", /^\/s\/[^/]+\/books\/[^/]+\/versions\/[^/]+\/?$/u]
];

export function resolveEntry(pathname) {
  return matchers.find(([, matcher]) => matcher.test(pathname))?.[0] ?? "BL01";
}

export function concreteRoute(entry, fixture) {
  const photo = fixture.photos[0];
  const text = fixture.manifest.authorizedMemoryTexts[0];
  return ROUTES[entry]
    .replace(":photoId", photo.photoId)
    .replace(":memoryId", text.personalMemoryId)
    .replace(":bookId", fixture.book.bookId)
    .replace(":spaceId", fixture.event.spaceId)
    .replace(":versionId", fixture.book.currentVersion.versionId);
}
