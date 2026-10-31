// Keep the original blobs when a selection is replaced. Restoring makes an
// independent draft, so neither a saved space nor an earlier revision changes.
export async function retainSpatialRevision(store, draft, reason) {
  if (!draft.panorama && !draft.depth && !draft.metadata && !draft.photos?.length && !draft.title && !draft.prompt) return null;
  const revision = { ...structuredClone(draft), id: `history-${crypto.randomUUID()}`,
    sourceDraftId: draft.id, archivedAt: new Date().toISOString(), historyReason: reason,
    saved: false, state: 'draft', error: '' };
  await store('put', revision);
  return revision;
}

export async function restoreSpatialRevision(store, revision, { accountId = revision.accountId, id = crypto.randomUUID() } = {}) {
  if (revision.accountId !== 'guest' && revision.accountId !== accountId) throw { code: 'account_changed' };
  const draft = { ...structuredClone(revision), id, accountId, archivedAt: null,
    restoredFrom: revision.id, createdAt: new Date().toISOString(), saved: false, state: 'draft', error: '' };
  delete draft.historyReason;
  delete draft.sourceDraftId;
  await store('put', draft);
  return draft;
}
