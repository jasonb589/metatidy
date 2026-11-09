/** Exact, index-only artist summaries shared by preview and browser acceptance. */
import { createHash } from 'node:crypto';

const trim = value => String(value || '').replace(/^ +| +$/g, '');
const trimQuery = value => value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
const number = value => Math.max(0, Number(value) || 0);
const clone = value => structuredClone(value);
const groupOf = row => [trim(row.album), trim(row.albumartist) || trim(row.artist)];
const groupKey = row => JSON.stringify(groupOf(row));
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const failure = (code, message, status = 400) => { throw Object.assign(new Error(message), { status, detail: { code, message } }); };
const lightFields = ['id', 'path', 'dir', 'filename', 'ext', 'title', 'artist', 'album', 'albumartist', 'genre', 'year', 'track', 'disc', 'language', 'albumtype', 'has_cover', 'has_lyrics', 'duration', 'indexed_at', 'edited_at', 'scraped_at', 'mtime', 'size', 'tags_loaded', 'path_derived'];
const light = row => Object.fromEntries(lightFields.map(key => [key, row[key] ?? (['id', 'duration', 'size', 'mtime', 'indexed_at', 'edited_at', 'scraped_at'].includes(key) ? 0 : '')]));
function pageOf(params, total, fallback, limit = 100) {
  const integer = (key, defaultValue) => {
    if (!params.has(key)) return defaultValue;
    const value = params.get(key); if (!/^[+]?[0-9]+$/.test(value)) failure('invalid_request', '分页参数无效'); return Number(value);
  };
  const size = integer('page_size', fallback), wanted = integer('page', 1);
  if (!Number.isSafeInteger(size) || size < 1 || size > limit || !Number.isSafeInteger(wanted) || wanted < 1) failure('invalid_request', '分页参数无效');
  const pages = Math.ceil(total / size), page = Math.max(1, Math.min(wanted, pages || 1));
  return { total, page, page_size: size, pages };
}
function quality(rows) {
  return { duration: rows.reduce((total, row) => total + number(row.duration), 0), bytes: rows.reduce((total, row) => total + number(row.size), 0),
    missing_cover: rows.filter(row => !row.has_cover).length, missing_lyrics: rows.filter(row => !row.has_lyrics).length,
    not_loaded: rows.filter(row => row.tags_loaded === false).length, indexed_at: Math.max(0, ...rows.map(row => number(row.indexed_at))) };
}
function discTrack(rows) {
  const ordinal = value => /^[0-9]{1,9}$/.test(trim(String(value || '').split('/')[0])) ? Number(trim(String(value).split('/')[0])) : null;
  return [...rows].sort((a, b) => {
    const aTrack = ordinal(a.track), bTrack = ordinal(b.track);
    return compare(trim(a.album), trim(b.album)) || compare(groupOf(a)[1], groupOf(b)[1]) || (ordinal(a.disc) ?? 1) - (ordinal(b.disc) ?? 1)
      || (aTrack === null ? bTrack === null ? 0 : 1 : bTrack === null ? -1 : aTrack - bTrack) || a.id - b.id;
  });
}
export function createArtistsFixture(tracks) {
  const calls = [];
  function artistRows(name) { return tracks.filter(row => trim(row.artist) === name); }
  function summary(name, rows = artistRows(name)) {
    return { name, track_count: rows.length, album_count: new Set(rows.filter(row => trim(row.album)).map(groupKey)).size,
      unalbumed_count: rows.filter(row => !trim(row.album)).length, ...quality(rows) };
  }
  function albumSummary(group, rows) {
    const covers = rows.filter(row => row.has_cover).map(row => row.id), years = [...new Set(rows.map(row => trim(row.year)).filter(Boolean))];
    return { album: group[0], album_artist: group[1], track_count: rows.length,
      disc_count: new Set(rows.map(row => trim(row.disc) || '1')).size, ...quality(rows), cover_track_id: covers.length ? Math.min(...covers) : null,
      year: years.length === 1 ? years[0] : '' };
  }
  function albumsFor(name, rows = artistRows(name)) {
    const keys = [...new Set(rows.filter(row => trim(row.album)).map(groupKey))];
    return keys.map(key => ({ ...albumSummary(JSON.parse(key), tracks.filter(row => groupKey(row) === key)),
      artist_track_count: rows.filter(row => groupKey(row) === key).length }))
      .sort((a, b) => compare(a.album, b.album) || compare(a.album_artist, b.album_artist));
  }
  function revisionFor(name) {
    const members = artistRows(name), groups = new Set(members.filter(row => trim(row.album)).map(groupKey));
    const related = tracks.filter(row => trim(row.artist) === name || groups.has(groupKey(row)));
    return createHash('md5').update(JSON.stringify(related.slice().sort((a, b) => a.id - b.id))).digest('hex');
  }
  function list(params) {
    if ([...params.keys()].some(key => !['q', 'sort', 'order', 'page', 'page_size'].includes(key))) failure('invalid_request', '艺术家请求包含未知参数');
    const q = trimQuery(params.get('q') || ''), sort = params.get('sort') ?? 'name', order = params.get('order') ?? 'asc';
    if ([...q].length > 4000 || q.includes('\0') || !['name', 'tracks', 'recent'].includes(sort) || !['asc', 'desc'].includes(order)) failure('invalid_request', '艺术家搜索或排序无效');
    const names = [...new Set(tracks.map(row => trim(row.artist)).filter(Boolean))].filter(name => name.toLowerCase().includes(q.toLowerCase()));
    const items = names.map(name => summary(name)), direction = order === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      const first = sort === 'tracks' ? a.track_count - b.track_count : sort === 'recent' ? a.indexed_at - b.indexed_at : compare(a.name, b.name);
      return first * direction || compare(a.name, b.name);
    });
    const page = pageOf(params, items.length, 24);
    return { q, sort, order, ...page, items: clone(items.slice((page.page - 1) * page.page_size, page.page * page.page_size)) };
  }
  function detail(params) {
    if ([...params.keys()].some(key => !['artist_group', 'section', 'page', 'page_size', 'revision'].includes(key))) failure('invalid_request', '艺术家请求包含未知参数');
    const raw = params.get('artist_group'), name = trim(raw), section = params.get('section') ?? 'albums';
    if (raw === null || !name || [...raw].length > 4000 || name.includes('\0') || !['albums', 'tracks'].includes(section)) failure('invalid_request', '艺术家分组或详情分区无效');
    const rows = artistRows(name), wantedRevision = params.has('revision') ? params.get('revision').toLowerCase() : null;
    if (wantedRevision !== null && !/^[a-f\d]{32}$/.test(wantedRevision)) failure('invalid_request', '艺术家版本编号无效');
    if (!rows.length) failure('artist_missing', '艺术家分组已不存在，请刷新艺术家列表', 404);
    const revision = revisionFor(name);
    if (wantedRevision && wantedRevision !== revision) failure('artist_changed', '艺术家曲目或关联专辑已变化，请刷新详情', 409);
    const items = section === 'albums' ? albumsFor(name, rows) : discTrack(rows).map(light), page = pageOf(params, items.length, section === 'albums' ? 24 : 50, section === 'albums' ? 100 : 200);
    return { name, summary: summary(name, rows), revision, section, ...page,
      items: clone(items.slice((page.page - 1) * page.page_size, page.page * page.page_size)) };
  }
  function albumDetail(params) {
    let group; try { group = JSON.parse(params.get('album_group')); } catch { failure('invalid_query', '专辑分组无效'); }
    if (!Array.isArray(group) || group.length !== 2 || group.some(value => typeof value !== 'string')) failure('invalid_query', '专辑分组无效');
    group = group.map(trim); const rows = discTrack(tracks.filter(row => groupKey(row) === JSON.stringify(group)));
    if (!rows.length) failure('album_missing', '专辑分组已不存在', 404);
    const page = pageOf(params, rows.length, 100, 200);
    return { group, summary: albumSummary(group, rows), revision: createHash('md5').update(JSON.stringify(rows)).digest('hex'), ...page,
      items: rows.slice((page.page - 1) * page.page_size, page.page * page.page_size).map(light) };
  }
  function handle(path, method, params = new URLSearchParams()) {
    calls.push({ path, method, query: Object.fromEntries(params) });
    if (method !== 'GET') failure('invalid_query', '艺术家浏览只接受 GET', 405);
    if (path === '/api/library/artists') return list(params);
    if (path === '/api/library/artists/detail') return detail(params);
    failure('not_found', '不存在的艺术家接口', 404);
  }
  return { handle, list, detail, summary, albumsFor, artistRows, revisionFor, albumDetail, calls };
}
