// Membership is authoritative. An old import mapping never grants access.
export function mergeAccountSpaces(spaces = [], imports = []) {
  const bySpace = new Map();
  for (const imported of imports) if (imported?.spaceId) {
    const prior = bySpace.get(imported.spaceId);
    if (!prior || String(imported.createdAt || '') > String(prior.createdAt || '')) bySpace.set(imported.spaceId, imported);
  }
  const seen = new Set();
  return spaces.filter(space => {
    if (!space?.spaceId || seen.has(space.spaceId) || space.spaceLifecycle !== 'active') return false;
    if (!space.owner && !space.effectiveCanView && !space.effectiveCanUpload) return false;
    seen.add(space.spaceId); return true;
  }).map(space => {
    const imported = bySpace.get(space.spaceId);
    return {...space, title: space.name, importId: imported?.id || null,
      panorama: space.effectiveCanView ? imported?.panorama || null : null,
      depth: space.effectiveCanView ? imported?.depth || null : null,
      route: `shared-space/${encodeURIComponent(space.spaceId)}?tab=${space.effectiveCanView ? 'scene' : 'upload'}`};
  });
}
