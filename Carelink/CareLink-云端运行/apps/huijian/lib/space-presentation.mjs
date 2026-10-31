import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authenticateMoment } from './moment-http.mjs';
import { worldCanonical } from './world-account-http.mjs';

const fail = (code, status = 422) => Object.assign(new Error(code), { code, status });
const themes = new Set(['sea', 'wedding', 'travel', 'night', 'campus']);
export function validatePresentation(body) {
  const keys = ['version', 'theme', 'startDate', 'endDate', 'place', 'coverPhotoId'];
  if (!body || Object.keys(body).some(key => !keys.includes(key)) || !Number.isSafeInteger(body.version) || body.version < 0 || !themes.has(body.theme)) throw fail('space_details_invalid');
  const date = value => typeof value === 'string' && (value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  if (!date(body.startDate) || !date(body.endDate) || body.endDate && (!body.startDate || body.endDate < body.startDate) || typeof body.place !== 'string' || body.place.length > 120 || typeof body.coverPhotoId !== 'string' || !/^[A-Za-z0-9_-]{0,128}$/.test(body.coverPhotoId)) throw fail('space_details_invalid');
  return { theme: body.theme, startDate: body.startDate, endDate: body.endDate, place: body.place.trim(), coverPhotoId: body.coverPhotoId };
}
export function createSpacePresentationHttp({ directory = join(process.env.STATE_DIRECTORY || '.state', 'space-presentation'), authenticate = authenticateMoment, canonical = worldCanonical, readBody, send } = {}) {
  const pending = new Map();
  async function serialized(id, run) {
    const previous = pending.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(run); pending.set(id, next);
    try { return await next; } finally { if (pending.get(id) === next) pending.delete(id); }
  }
  const read = async id => { try { return JSON.parse(await readFile(join(directory, id + '.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  return async (req, res, pathname) => {
    const match = /^\/api\/space-presentation\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
    if (!match) return false;
    try {
      if (!['GET', 'PUT'].includes(req.method)) throw fail('method_not_allowed',405);
      if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fail('origin_not_allowed',403);
      const { accountId } = await authenticate(req), spaceId = match[1];
      const owned = async () => {
        const data = await canonical(req, `/v1/spaces/${spaceId}/management`);
        // The operable API exposes ownership at the top level; the canonical API nests it.
        const owner = data.isOwner ?? data.space?.owner;
        if (owner !== true || data.space?.spaceLifecycle !== 'active') throw fail('resource_unavailable',403);
        return data;
      };
      if (req.method === 'GET') {
        // Viewer authorization controls reads; an account alone does not grant access.
        await canonical(req, `/v1/viewer/spaces/${spaceId}`);
        const row = await read(spaceId);
        send(res,200,{accountId, presentation:row ? {...row,owner:undefined} : {version:0,theme:'sea',startDate:'',endDate:'',place:'',coverPhotoId:''}});
      } else {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail('json_required',415);
        await owned();
        const body = await readBody(req), fields = validatePresentation(body);
        const row = await serialized(spaceId,async () => {
          const previous = await read(spaceId);
          if ((previous?.version || 0) !== body.version) {
            if (previous && Object.entries(fields).every(([key,value]) => previous[key] === value)) { await owned(); return previous; }
            throw fail('version_conflict',409);
          }
          if (fields.coverPhotoId) { const view = await canonical(req,`/v1/viewer/spaces/${spaceId}`); if (!view.photos?.some(p => (p.id || p.photoId) === fields.coverPhotoId && !p.video)) throw fail('cover_photo_unavailable'); }
          await owned();
          const next = {...fields,owner:accountId,version:(previous?.version || 0) + 1};
          await mkdir(directory,{recursive:true,mode:0o700});
          const temp = join(directory,`${spaceId}.${randomUUID()}.tmp`);
          await writeFile(temp,JSON.stringify(next),{mode:0o600});
          await rename(temp,join(directory,spaceId+'.json'));
          return next;
        });
        send(res,200,{accountId,presentation:{...row,owner:undefined}});
      }
    } catch (error) { send(res,error.status || 503,{error:error.code || 'space_details_unavailable'}); }
    return true;
  };
}
