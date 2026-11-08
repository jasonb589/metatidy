/** In-memory collection routes shared by the local preview and browser acceptance. */
import { randomUUID } from 'node:crypto';

const failure = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fields = ['id', 'path', 'dir', 'filename', 'ext', 'title', 'artist', 'album', 'albumartist', 'genre', 'year', 'track', 'disc', 'language', 'albumtype', 'has_cover', 'has_lyrics', 'duration', 'indexed_at', 'edited_at', 'scraped_at', 'mtime', 'size', 'tags_loaded', 'path_derived'];
const light = row => Object.fromEntries(fields.map(key => [key, row[key] ?? (['id', 'duration', 'size', 'mtime', 'indexed_at', 'edited_at', 'scraped_at'].includes(key) ? 0 : '')]));
function nameOf(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 120 || value.includes('\0')) failure('清单名称须为 1–120 个字符');
  return value.trim();
}
function idsOf(value) {
  if (!Array.isArray(value) || value.length > 20000 || value.some(id => !Number.isSafeInteger(id) || id <= 0)) failure('清单曲目编号无效或超过 20000 首');
  return [...new Set(value)];
}
function pagination(params, total, max = 100, fallback = 20) {
  const size = Number(params.get('page_size') || fallback), requested = Number(params.get('page') || 1);
  if (!Number.isSafeInteger(size) || size < 1 || size > max || !Number.isSafeInteger(requested)) failure('分页参数无效');
  const pages = Math.ceil(total / size), page = Math.max(1, Math.min(requested, pages || 1));
  return { total, page, page_size: size, pages };
}
export function createCollectionsFixture(tracks, { seed = false } = {}) {
  const records = new Map();
  const current = id => tracks.find(row => row.id === id);
  const summary = row => ({ id: row.id, name: row.name, revision: row.revision, track_count: row.members.length,
    missing_count: row.members.filter(item => !current(item.id)).length, created_at: row.created_at, updated_at: row.updated_at });
  const touch = row => { row.revision = randomUUID(); row.updated_at = Date.now() / 1000; };
  function add(name, ids, id = randomUUID()) {
    const time = Date.now() / 1000;
    const members = ids.map((trackId, index) => ({ id: trackId, position: index + 1,
      snapshot: light(current(trackId) || { id: trackId, title: '暂缺索引的收藏', artist: '旧收藏', path: `/fixture-music/旧收藏/${trackId}.flac`, filename: `${trackId}.flac` }) }));
    const row = { id, name, revision: randomUUID(), created_at: time, updated_at: time, members, creation: JSON.stringify({ name, ids }) };
    records.set(id, row); return row;
  }
  if (seed && tracks.length) {
    add('周末待整理', tracks.slice(0, 6).map(row => row.id));
    add('喜欢的声音', tracks.slice(6, 12).map(row => row.id));
    add('旧收藏待核对', [tracks[0].id, 9001]);
  }
  function handle(path, method, params = new URLSearchParams(), payload = {}) {
    const match = path.match(/^\/api\/collections(?:\/([^/]+)(?:\/(members|selection))?)?$/);
    if (!match) failure('没有该清单接口', 404);
    if (!match[1]) {
      if (method === 'GET') {
        const q = (params.get('q') || '').trim(); if ([...q].length > 500 || q.includes('\0')) failure('查询过长');
        const all = [...records.values()].filter(row => row.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
        const page = pagination(params, all.length);
        return { ...page, items: all.slice((page.page - 1) * page.page_size, page.page * page.page_size).map(summary) };
      }
      if (method !== 'POST') failure('不支持的方法', 405);
      if (!uuid(payload.id)) failure('清单编号无效');
      const name = nameOf(payload.name), ids = idsOf(payload.ids), old = records.get(payload.id);
      if (old) {
        if (old.creation !== JSON.stringify({ name, ids })) failure('此创建编号已用于不同内容', 409);
        return { collection: summary(old) };
      }
      if (ids.some(id => !current(id))) failure('部分曲目已不在索引中，请重新核对选择', 409);
      return { collection: summary(add(name, ids, payload.id)) };
    }
    if (!uuid(match[1])) failure('清单编号无效');
    const row = records.get(match[1]); if (!row) failure('清单不存在', 404);
    const revision = method === 'GET' ? params.get('revision') : payload.revision;
    if (method !== 'GET' || revision !== null) {
      if (!uuid(revision)) failure('清单版本无效');
      if (revision !== row.revision) failure('清单已在其他页面更新，请刷新后重试', 409);
    }
    if (method === 'GET' && !match[2]) {
      const page = pagination(params, row.members.length, 200, 100);
      return { collection: summary(row), ...page, items: row.members.slice((page.page - 1) * page.page_size, page.page * page.page_size).map(item => {
        const track = current(item.id); return { ...item, status: track ? 'found' : 'missing', track: track ? light(track) : null };
      }) };
    }
    if (method === 'PATCH' && !match[2]) {
      const name = nameOf(payload.name); if (name !== row.name) { row.name = name; touch(row); }
      return { collection: summary(row) };
    }
    if (method === 'DELETE' && !match[2]) { records.delete(row.id); return { deleted: true, id: row.id }; }
    if (method === 'POST' && match[2] === 'selection') return { collection: summary(row), ids: row.members.map(item => item.id) };
    if (method === 'POST' && match[2] === 'members') {
      const ids = idsOf(payload.ids); let added = 0, removed = 0;
      if (payload.action === 'append') {
        const pending = ids.filter(id => !row.members.some(item => item.id === id));
        if (row.members.length + pending.length > 20000 || pending.some(id => !current(id))) failure('曲目缺失或清单超过 20000 首', 409);
        let position = Math.max(0, ...row.members.map(item => item.position));
        row.members.push(...pending.map(id => ({ id, position: ++position, snapshot: light(current(id)) }))); added = pending.length;
      } else if (payload.action === 'remove') {
        const before = row.members.length; row.members = row.members.filter(item => !ids.includes(item.id)); removed = before - row.members.length;
        row.members.forEach((item, index) => { item.position = index + 1; });
      } else failure('成员操作无效');
      if (added || removed) touch(row);
      return { collection: summary(row), added, removed };
    }
    failure('不支持的方法', 405);
  }
  return { handle, records, add, touch, summary };
}
