import { actionApi, actionRegistry, strings } from "./generated/contracts.js";

export const actionDefinitions = Object.freeze(Object.fromEntries(actionRegistry.actions.map((action) => [action.id, Object.freeze({
  ...action,
  api: Object.freeze(actionApi[action.id]),
  phases: Object.freeze(Object.fromEntries(actionRegistry.phases.map((phase) => [phase, strings.actions[action.id]?.[phase] ?? null])))
})])));

export function requireAction(actionId) {
  const definition = actionDefinitions[actionId];
  if (!definition) throw new Error(`Unregistered product action: ${actionId}`);
  return definition;
}

export function exactManagementSpaceIfMatch(management, routePath, selectedSpaceId) {
  const routeSpaceId = /^\/manage\/([^/]+)$/.exec(routePath)?.[1];
  if (!routeSpaceId || routeSpaceId !== selectedSpaceId || management?.space?.id !== routeSpaceId) return undefined;
  return management.space.ifMatch || undefined;
}
