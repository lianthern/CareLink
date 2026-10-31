export function resolvePagePresentation(fixture, page) {
  const text = fixture.manifest.authorizedMemoryTexts.find((item) => item.authorizedMemoryTextId === page.authorizedMemoryTextId);
  if (!text) throw new Error("authorized_memory_text_missing");
  const sourcePhoto = fixture.photos.find((item) => item.photoId === page.sourcePhotoId);
  const displayPhoto = fixture.photos.find((item) => item.photoId === page.displayPhotoId);
  if (!sourcePhoto || !displayPhoto) throw new Error("book_page_photo_missing");
  if (text.sourceProvenance.photoId !== sourcePhoto.photoId) throw new Error("source_photo_provenance_mismatch");
  return Object.freeze({ text, sourcePhoto, displayPhoto });
}
