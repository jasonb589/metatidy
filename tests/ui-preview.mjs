/**
 * Isolated UI fixture server. No database, audio files, or external services.
 * All mutations affect this process's memory only; restarting resets everything.
 * Run: node tests/ui-preview.mjs [--port=8765] [--empty] [--auth]
 * This is development/test tooling and is never loaded by the production UI.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { jpeg as portraitJpeg, avif as portraitAvif } from './portrait-image-fixtures.mjs';
import { createCollectionsFixture } from './collections-fixture.mjs';

const staticRoot = fileURLToPath(new URL('../app/static/', import.meta.url));
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] || 8765);
const empty = process.argv.includes('--empty');
const authRequired = process.argv.includes('--auth');
// A quiet, generated PCM WAV keeps media acceptance independent of real music/codecs.
const audioFixture = (() => {
  const rate = 8000, frames = rate * 12, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index++) bytes.writeInt16LE(Math.round(200 * Math.sin(index * 2 * Math.PI * 220 / rate)), 44 + index * 2);
  return bytes;
})();
const now = Math.floor(Date.now() / 1000);
const sourceLabels = [
  ['musicbrainz', 'MusicBrainz'], ['netease', '网易云音乐'], ['qq', 'QQ音乐'],
  ['kugou', '酷狗音乐'], ['kuwo', '酷我音乐'], ['itunes', 'iTunes'], ['deezer', 'Deezer'],
  ['lastfm', 'Last.fm'], ['theaudiodb', 'TheAudioDB'], ['spotify', 'Spotify'],
  ['genius', 'Genius'], ['ytmusic', 'YouTube Music'], ['discogs', 'Discogs'],
];
const sources = sourceLabels.map(([name, label], index) => ({
  name, label, status: '内置', needs_key: index === 9 ? 'SPOTIFY_CLIENT_ID+SPOTIFY_CLIENT_SECRET' : null,
  default_on: index < 3 || name === 'itunes',
}));
const fixtureRows = [
  ['晴天', '周杰伦', '叶惠美', '2003', '中文', 'Pop', 269],
  ['七里香', '周杰伦', '七里香', '2004', '中文', 'Pop', 299],
  ['稻香', '周杰伦', '魔杰座', '2008', '中文', 'Pop', 223],
  ['红豆', '王菲', '唱游', '1998', '中文', 'Pop', 255],
  ['小半', '陈粒', '小梦大半', '2016', '中文', 'Folk', 297],
  ['起风了', '买辣椒也用券', '起风了', '2018', '中文', 'Pop', 325],
  ['海阔天空', 'Beyond', '乐与怒', '1993', '粤语', 'Rock', 326],
  ['富士山下', '陈奕迅', 'What’s Going On…?', '2006', '粤语', 'Pop', 259],
  ['Holocene', 'Bon Iver', 'Bon Iver', '2011', '英文', 'Indie Folk', 337],
  ['The Night We Met', 'Lord Huron', 'Strange Trails', '2015', '英文', 'Indie Folk', 208],
  ['Dreams', 'Fleetwood Mac', 'Rumours', '1977', '英文', 'Rock', 257],
  ['Everything In Its Right Place', 'Radiohead', 'Kid A', '2000', '英文', 'Alternative', 251],
  ['One Summer’s Day', '久石让', '千と千尋の神隠し', '2001', '日文', 'Soundtrack', 189],
  ['花火', 'aiko', '桜の木の下', '2000', '日文', 'Pop', 280],
  ['夜空中最亮的星', '逃跑计划', '世界', '2011', '中文', 'Rock', 252],
  ['山海', '草东没有派对', '丑奴儿', '2016', '中文', 'Rock', 255],
  ['青石巷（未标注歌手）', '', '晚间收藏', '2024', '中文', 'Instrumental', 187],
  ['雨后的车站', '林间来信', '', '2025', '中文', 'Ambient', 194],
];
const tracks = empty ? [] : fixtureRows.map((row, index) => {
  const [title, artist, album, year, language, genre, duration] = row;
  const ext = index % 4 === 1 ? 'mp3' : index % 7 === 2 ? 'm4a' : 'flac';
  const dir = `/fixture-music/${language}/${artist || '未标注'}/${album || '待整理'}`;
  const filename = `${String(index + 1).padStart(2, '0')} - ${title}.${ext}`;
  return {
    id: index + 1, title, artist, album, year, language, genre, duration, ext, dir, filename,
    path: `${dir}/${filename}`, albumartist: artist, track: String(index + 1), disc: '1',
    albumtype: index === 5 ? '单曲' : '专辑', size: 25000000 + index * 420000,
    has_cover: index % 5 !== 3 ? 1 : 0, has_lyrics: index % 4 !== 0 ? 1 : 0,
    tags_loaded: true, path_derived: false, indexed_at: now - 3600, edited_at: now - 7200,
    mtime: now - 86400, scraped_at: 0, file_exists: true, composer: '', lyricist: '',
    copyright: '', comment: 'UI 测试样本；未连接真实音乐文件', mb_artist_id: '', release_group_id: '',
  };
});
if (!empty && process.argv.includes('--duplicates')) {
  tracks.push(...tracks.slice(0, 6).map((row, index) => ({ ...row, id: 1001 + index, ext: 'mp3', size: 9500000 + index * 80000, album: `${row.album} · 精选`, path: `/fixture-music/精选/${row.artist}/${row.title}.mp3`, filename: `${row.title}.mp3`, duration: row.duration + index * 2, has_cover: 0 })));
}
const collections = createCollectionsFixture(tracks, { seed: !empty });
let values = {
  dir_template: '{language?}/{artist}/{album}', filename_template: '{track:02} - {title}',
  conflict_policy: 'rename', unknown_artist: '未知艺术家', unknown_album: '未知专辑', unknown_other: '未知',
  normalize_artist_ampersand: true, enabled_sources: ['netease', 'qq', 'musicbrainz', 'itunes'],
  write_cover: false, write_lyrics: true, overwrite_existing: true,
};
const placeholders = [
  ['artist', '歌手'], ['albumartist', '专辑艺术家'], ['album', '专辑'], ['title', '标题'],
  ['track', '音轨号，支持补零'], ['disc', '碟号'], ['year', '年份'], ['genre', '流派'],
  ['language', '语言'], ['albumtype', '专辑类型'], ['mb_artist_id', 'MusicBrainz ID'],
  ['release_group_id', '发行组 ID'], ['ext', '扩展名'], ['original', '原文件名'],
].map(([key, desc]) => ({ key, desc }));
const aliases = { artist: [{ from: 'Jay Chou', to: '周杰伦' }], album: [] };
const jobs = empty ? [] : [{
  id: 'fixture-scan-001', kind: 'scan', state: 'done', total: tracks.length, done: tracks.length,
  message: '测试样本已就绪 · 未扫描真实文件', error: '', created_at: now - 3600, updated_at: now - 3600,
  result: JSON.stringify({ scanned: tracks.length, added: tracks.length, updated: 0, skipped: 0, removed: 0 }),
}];
const plans = new Map();
const portraitCache = new Map();
const portraitSyncs = new Map();
const portraitTarget = { id: 'fixture-artist-1', name: '周杰伦', album_count: 3, song_count: 3, mbid: '', uploaded_image: null, updated_at: '2026-01-01T00:00:00Z', image_hash: '' };
const albumText = value => String(value || '').replace(/^ +| +$/g, '');

function discTrackSort(rows, descending = false) {
  const number = value => {
    const part = albumText(String(value || '').split('/')[0]);
    return /^[0-9]{1,9}$/.test(part) ? Number(part) : null;
  };
  const direction = descending ? -1 : 1;
  return rows.sort((a, b) => {
    const disc = ((number(a.disc) ?? 1) - (number(b.disc) ?? 1)) * direction;
    const aTrack = number(a.track), bTrack = number(b.track);
    return disc || (aTrack === null ? bTrack === null ? 0 : 1 : bTrack === null ? -1 : (aTrack - bTrack) * direction) || a.id - b.id;
  });
}

function albumSummary([album, album_artist], rows) {
  const covers = rows.filter(t => t.has_cover).map(t => t.id);
  const years = [...new Set(rows.map(t => albumText(t.year)).filter(Boolean))].sort();
  return {
    album, album_artist, track_count: rows.length,
    disc_count: new Set(rows.map(t => albumText(t.disc) || '1')).size,
    duration: rows.reduce((total, t) => total + Math.max(0, Number(t.duration) || 0), 0),
    bytes: rows.reduce((total, t) => total + Math.max(0, Number(t.size) || 0), 0),
    missing_cover: rows.filter(t => !t.has_cover).length,
    missing_lyrics: rows.filter(t => !t.has_lyrics).length,
    not_loaded: rows.filter(t => !t.tags_loaded).length,
    cover_track_id: covers.length ? Math.min(...covers) : null,
    year: years.length === 1 ? years[0] : '',
    indexed_at: Math.max(...rows.map(t => Number(t.indexed_at) || 0)),
  };
}

function normalizedAlbumGroup(raw) {
  if (!Array.isArray(raw) || raw.length !== 2 || raw.some(value => typeof value !== 'string')) throw fixtureError('专辑分组须为数组 [专辑名, 专辑艺术家]');
  const group = raw.map(albumText);
  if (!group[0] || group.some(value => [...value].length > 4000)) throw fixtureError('专辑名不能为空且每项最多4000字');
  return group;
}

function albumMembers(raw) {
  const group = normalizedAlbumGroup(raw);
  const rows = tracks.filter(track => albumText(track.album) === group[0] && (albumText(track.albumartist) || albumText(track.artist)) === group[1]);
  if (!rows.length) throw fixtureError('专辑分组已不存在，请刷新专辑收藏', 404);
  const revision = createHash('md5').update(JSON.stringify([...rows].sort((a, b) => a.id - b.id).map(track => [track.id, track.disc, track.track]))).digest('hex');
  return { group, revision, rows: discTrackSort(rows) };
}

function albumDetail(params) {
  let raw;
  try { raw = JSON.parse(params.get('album_group')); } catch { throw fixtureError('专辑分组须为JSON数组'); }
  const { group, revision, rows } = albumMembers(raw);
  const size = integerBody(params.get('page_size'), 100), requested = integerBody(params.get('page'), 1);
  if (size < 1n || size > 200n) throw fixtureError('每页专辑曲目数须为1–200');
  const pageSize = Number(size), pages = Math.ceil(rows.length / pageSize);
  const page = requested < 1n ? 1 : requested > BigInt(pages) ? pages : Number(requested);
  return { group, summary: albumSummary(group, rows), revision, total: rows.length, page, page_size: pageSize, pages,
    items: rows.slice((page - 1) * pageSize, page * pageSize).map(lightTrack) };
}

function albumSelection(payload) {
  const group = normalizedAlbumGroup(payload.album_group);
  if (typeof payload.revision !== 'string' || !/^[a-f\d]{32}$/i.test(payload.revision)) throw fixtureError('请提供专辑详情返回的32位版本标识');
  const { revision, rows } = albumMembers(group);
  if (revision !== payload.revision.toLowerCase()) throw fixtureError('专辑成员或曲序已变化，请刷新详情后重新加入已选', 409);
  return { group, revision, total: rows.length, ids: rows.map(track => track.id), selected_at: Date.now() / 1000 };
}

function stats() {
  return {
    tracks: tracks.length, artists: new Set(tracks.map(t => t.artist).filter(Boolean)).size,
    albums: new Set(tracks.map(t => albumText(t.album)).filter(Boolean)).size,
    missing_cover: tracks.filter(t => !t.has_cover).length, missing_lyrics: tracks.filter(t => !t.has_lyrics).length,
    no_artist: tracks.filter(t => !t.artist).length, no_album: tracks.filter(t => !albumText(t.album)).length,
    bytes: tracks.reduce((total, t) => total + t.size, 0), not_loaded: 0,
    languages: [...new Set(tracks.map(t => t.language))], albumtypes: [...new Set(tracks.map(t => t.albumtype))],
  };
}

function filterTracks(params) {
  let result = [...tracks];
  const folder = params.get('folder');
  if (folder) {
    const recursive = !['0', 'false'].includes(params.get('folder_recursive'));
    result = result.filter(track => track.dir === folder || (recursive && track.dir.startsWith(`${folder}/`)));
  }
  if (params.has('album_group')) {
    const group = JSON.parse(params.get('album_group'));
    if (!Array.isArray(group) || group.length !== 2 || group.some(value => typeof value !== 'string')) throw new Error('album_group must contain an album and album artist');
    result = result.filter(t => albumText(t.album) === albumText(group[0]) && (albumText(t.albumartist) || albumText(t.artist)) === albumText(group[1]));
  }
  const q = (params.get('q') || '').toLowerCase();
  if (q) result = result.filter(t => [t.title, t.artist, t.album, t.filename, t.path, t.genre, t.year].some(v => v.toLowerCase().includes(q)));
  for (const field of ['language', 'albumtype', 'genre', 'year', 'artist', 'album']) {
    if (params.get(field)) result = result.filter(t => t[field] === params.get(field));
  }
  for (const [flag, field] of [['missing_cover', 'has_cover'], ['missing_lyrics', 'has_lyrics'], ['no_artist', 'artist'], ['no_album', 'album']]) {
    if (['1', 'true'].includes(params.get(flag))) result = result.filter(t => !(field === 'album' ? albumText(t[field]) : t[field]));
  }
  if (['1', 'true'].includes(params.get('not_loaded'))) result = result.filter(t => !t.tags_loaded);
  if (params.get('sort') === 'disc_track') {
    return discTrackSort(result, params.get('order') === 'desc');
  }
  const key = { indexed: 'indexed_at', edited: 'edited_at' }[params.get('sort')] || params.get('sort') || 'artist';
  result.sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || ''), 'zh-CN', { numeric: true }));
  if (params.get('order') === 'desc') result.reverse();
  return result;
}

function folderPage(params) {
  const root = '/fixture-music', current = params.get('folder') || root;
  if (current !== root && !current.startsWith(`${root}/`) || current.includes('\0') || current.includes('//') || current.split('/').some(part => part === '.' || part === '..') || current.endsWith('/')) throw fixtureError('目录位置无效', 400);
  const rows = tracks.filter(track => track.dir === current || track.dir.startsWith(`${current}/`));
  if (current !== root && !rows.length) throw fixtureError('目录没有索引记录', 404);
  const groups = new Map();
  for (const track of rows) {
    if (track.dir === current) continue;
    const name = track.dir.slice(current.length + 1).split('/')[0], folder = `${current}/${name}`;
    if (!groups.has(folder)) groups.set(folder, { name, path: folder, track_count: 0, direct_tracks: 0, bytes: 0 });
    const item = groups.get(folder); item.track_count++; item.direct_tracks += Number(track.dir === folder); item.bytes += track.size;
  }
  const q = (params.get('q') || '').trim().toLowerCase();
  const all = [...groups.values()].filter(item => item.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const pageSize = Math.max(1, Math.min(100, Number(params.get('page_size')) || 50)), pages = Math.ceil(all.length / pageSize), page = Math.max(1, Math.min(Number(params.get('page')) || 1, pages || 1));
  const breadcrumbs = [{ name: 'fixture-music', path: root }];
  for (const name of current.slice(root.length + 1).split('/').filter(Boolean)) breadcrumbs.push({ name, path: `${breadcrumbs.at(-1).path}/${name}` });
  return { root, current, parent: breadcrumbs.length > 1 ? breadcrumbs.at(-2).path : null, breadcrumbs, total: all.length, page, page_size: pageSize, pages, total_tracks: rows.length, direct_tracks: rows.filter(track => track.dir === current).length, bytes: rows.reduce((sum, track) => sum + track.size, 0), items: all.slice((page - 1) * pageSize, page * pageSize), scan_root: current, can_scan: true };
}

function albumPage(params) {
  const grouped = new Map();
  for (const track of tracks) {
    const album = albumText(track.album);
    if (!album) continue;
    const albumArtist = albumText(track.albumartist) || albumText(track.artist);
    const key = JSON.stringify([album, albumArtist]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(track);
  }
  let items = [...grouped].map(([key, rows]) => albumSummary(JSON.parse(key), rows));
  const query = (params.get('q') || '').trim().toLowerCase();
  if (query) items = items.filter(item => [item.album, item.album_artist].some(value => value.toLowerCase().includes(query)));
  if (['1', 'true'].includes(params.get('incomplete'))) items = items.filter(item => item.missing_cover || item.missing_lyrics || item.not_loaded);
  const compare = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true });
  const order = params.get('sort');
  items.sort((a, b) => (order === 'recent' ? b.indexed_at - a.indexed_at : order === 'artist' ? compare(a.album_artist, b.album_artist) : 0) || compare(a.album, b.album) || compare(a.album_artist, b.album_artist));
  const pageSize = Math.min(100, Math.max(1, Number(params.get('page_size')) || 24));
  const pages = Math.ceil(items.length / pageSize);
  const page = Math.min(Math.max(1, pages), Math.max(1, Number(params.get('page')) || 1));
  return { total: items.length, page, page_size: pageSize, pages, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Metatidy-UI-Fixture': 'true' });
  res.end(JSON.stringify(data));
}

async function bodyOf(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error('Fixture request body too large');
  }
  return body ? JSON.parse(body) : {};
}

function coverSvg(id) {
  const palettes = [['#284c49', '#c5c9ab'], ['#c7b491', '#6e7259'], ['#29465f', '#aac4ce'], ['#bd7760', '#e3cfaa'], ['#68775a', '#ded7b8'], ['#4e3f4b', '#bf9a9c']];
  const [bg, fg] = palettes[(id - 1) % palettes.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="${bg}"/><circle cx="110" cy="45" r="39" fill="${fg}" opacity=".7"/><path d="M0 126L50 58l40 46 37-51 33 71v36H0z" fill="${fg}" opacity=".45"/><path d="M0 139l58-31 44 29 58-24v47H0z" fill="${bg}"/><path d="M16 22h37M16 27h23" stroke="${fg}" stroke-width="2"/><text x="16" y="146" fill="${fg}" font-family="sans-serif" font-size="7" letter-spacing="3">ARCHIVE · ${String(id).padStart(2, '0')}</text></svg>`;
}

function fixtureError(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

function integerBody(value, fallback) {
  if (value == null && fallback !== undefined) return BigInt(fallback);
  if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'number' && !Number.isInteger(value)
      || typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim())) throw fixtureError('参数须为整数');
  const number = BigInt(typeof value === 'string' ? value.trim() : value);
  if (number < -(2n ** 63n) || number > 2n ** 63n - 1n) throw fixtureError('整数超出范围');
  return number;
}

function selectionIds(payload) {
  if (payload.ids == null) return [];
  if (!Array.isArray(payload.ids)) throw fixtureError('ids 须为整数数组');
  const ids = new Map();
  for (const value of payload.ids) {
    const id = integerBody(value);
    if (!ids.has(String(id))) ids.set(String(id), Number(id));
  }
  return [...ids.values()];
}

function lightTrack(track) {
  const keys = ['id', 'path', 'dir', 'filename', 'ext', 'title', 'artist', 'album', 'albumartist', 'genre', 'year', 'track', 'disc',
    'language', 'albumtype', 'has_cover', 'has_lyrics', 'duration', 'indexed_at', 'edited_at', 'scraped_at', 'mtime', 'size', 'tags_loaded', 'path_derived'];
  return Object.fromEntries(keys.map(key => [key, track[key]]));
}

function selectionPage(payload) {
  const ids = selectionIds(payload);
  const size = integerBody(payload.page_size, 100);
  const requested = integerBody(payload.page, 1);
  if (size < 1n || size > 200n) throw fixtureError('每页已选曲目数须为 1–200');
  const pageSize = Number(size);
  const pages = Math.ceil(ids.length / pageSize);
  const page = requested < 1n ? 1 : requested > BigInt(pages || 1) ? pages || 1 : Number(requested);
  const indexed = new Map(tracks.filter(track => track.id > 0).map(track => [track.id, track]));
  const found = ids.filter(id => indexed.has(id)).length;
  const items = ids.slice((page - 1) * pageSize, page * pageSize).map(id => {
    const track = indexed.get(id);
    return { id, status: track ? 'found' : 'missing', track: track ? lightTrack(track) : null };
  });
  return { total: ids.length, selected_total: ids.length, found_total: found, missing_total: ids.length - found, page, page_size: pageSize, pages, items };
}

function preview(payload, limit = 500, allowEmptyFields = false) {
  const fields = payload.fields || {};
  const ids = selectionIds(payload);
  if (!ids.length) throw fixtureError('至少选择一首', 400);
  if (!allowEmptyFields && !Object.keys(fields).length) throw fixtureError('没有可编辑的字段', 400);
  const indexed = new Map(tracks.filter(track => track.id > 0).map(track => [track.id, track]));
  const indexMissing = ids.filter(id => !indexed.has(id));
  const items = ids.slice(0, limit).map(id => {
    const t = indexed.get(id);
    if (!t || t.file_exists === false) return { track_id: id, path: t?.path || '', filename: t?.filename || '',
      current: { error: t ? '读取标签失败：测试音乐文件不可访问' : '索引里没有这条曲目' }, file_exists: false, changes: {}, count: 0, effective_fields: {}, skipped: [] };
    const effective_fields = {};
    const skipped = [];
    for (const [field, value] of Object.entries(fields)) {
      const next = String(value ?? '').trim();
      const current = String(t[field] ?? '').trim();
      const reason = !next ? 'blank' : current === next ? 'unchanged' : payload.overwrite === false && current && field !== 'lyrics' ? 'existing' : null;
      if (reason) skipped.push({ field, reason });
      else effective_fields[field] = next;
    }
    const changes = Object.fromEntries(Object.entries(effective_fields).map(([key, value]) => [key, { old: t[key] || '', new: value }]));
    return { track_id: t.id, path: t.path, filename: t.filename, current: t, file_exists: true, changes, count: Object.keys(changes).length, effective_fields, skipped };
  });
  return { fields, items, changed_fields: items.reduce((n, item) => n + item.count, 0), truncated: ids.length > limit,
    selected_total: ids.length, previewed_total: items.length, index_missing_total: indexMissing.length, index_missing_ids: indexMissing };
}

function makeJob(kind, result, total = tracks.length) {
  const timestamp = Date.now() / 1000;
  const job = { id: `fixture-${kind}-${jobs.length + 1}`, kind, state: 'done', done: total, total, created_at: timestamp, updated_at: timestamp, message: '测试操作完成（仅内存模拟）', error: '', result: JSON.stringify(result) };
  jobs.unshift(job);
  return { job_id: job.id };
}

const jobSummaryKeys = ['added', 'updated', 'skipped', 'removed', 'failed', 'scanned', 'parsed', 'total_seconds', 'seconds',
  'trigger', 'root', 'fast_mode', 'applied', 'search_only', 'moved', 'renamed', 'details_total', 'details_truncated'];
const jobNewestFirst = (a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id);
const jobPercent = job => job.total ? Math.round(job.done / job.total * 1000) / 10 : 0;

function jobResult(job) {
  try { return JSON.parse(job.result || 'null'); } catch { return null; }
}

function jobSummary(job) {
  const parsed = jobResult(job);
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const summary = Object.fromEntries(jobSummaryKeys.filter(key => ['string', 'number', 'boolean'].includes(typeof result[key])).map(key => [key, result[key]]));
  const { result: saved, ...row } = job;
  const hasErrors = Boolean(job.error) || typeof result.failed === 'number' && result.failed > 0
    || ['errors', 'failures'].some(key => Array.isArray(result[key]) && result[key].length > 0)
    || Array.isArray(result.details) && result.details.some(item => item && typeof item.error === 'string' && item.error.length > 0);
  return { ...row, percent: jobPercent(job), has_result: Boolean(saved && saved !== 'null'), has_errors: Boolean(hasErrors), summary };
}

function recentJobs() {
  const ordered = [...jobs].sort(jobNewestFirst);
  const active = ordered.filter(job => job.state === 'running').reverse();
  const watch = ordered.filter(job => job.kind === 'scan' && job.state === 'done' && jobResult(job)?.trigger === 'watch')
    .sort((a, b) => b.updated_at - a.updated_at || b.id.localeCompare(a.id))[0];
  return { jobs: ordered.slice(0, 20),
    counts: { total: jobs.length, ...Object.fromEntries(['running', 'done', 'error'].map(state => [state, jobs.filter(job => job.state === state).length])) },
    active: active.slice(0, 10).map(jobSummary), active_total: active.length, active_limit: 10,
    latest_completed_watch: watch ? { id: watch.id, updated_at: watch.updated_at, cursor: `fixture-watch:${watch.updated_at}:${watch.id}` } : null };
}

function historyPage(params) {
  const q = (params.get('q') || '').trim();
  const kind = (params.get('kind') || '').trim();
  const state = (params.get('state') || '').trim();
  const integer = (key, fallback) => {
    if (!params.has(key)) return BigInt(fallback);
    const value = params.get(key).trim();
    if (!/^[+-]?\d+$/.test(value)) return null;
    const parsed = BigInt(value);
    return parsed < -(2n ** 63n) || parsed > 2n ** 63n - 1n ? null : parsed;
  };
  const requestedPage = integer('page', 1);
  const requestedSize = integer('page_size', 20);
  if ([...q].length > 500 || kind && !['scan', 'scrape', 'move'].includes(kind) || state && !['running', 'done', 'error'].includes(state)
      || requestedPage === null || requestedSize === null || requestedSize < 1n || requestedSize > 100n) return null;
  const matching = [...jobs].filter(job => (!kind || job.kind === kind) && (!state || job.state === state)
    && (!q || ['id', 'kind', 'message', 'error'].some(key => String(job[key] || '').toLowerCase().includes(q.toLowerCase())))).sort(jobNewestFirst);
  const pageSize = Number(requestedSize);
  const pages = Math.ceil(matching.length / pageSize);
  const page = requestedPage < 1n ? 1 : requestedPage > BigInt(pages || 1) ? pages || 1 : Number(requestedPage);
  return { items: matching.slice((page - 1) * pageSize, page * pageSize).map(jobSummary), total: matching.length, page, page_size: pageSize, pages, q, kind, state };
}

function jobReport(job) {
  const parsed = jobResult(job);
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const count = key => Array.isArray(result[key]) ? result[key].length : null;
  return { report_type: 'job_result', report_scope: 'saved_result', generated_at: Date.now() / 1000,
    job: { ...job, percent: jobPercent(job) }, parsed_result: parsed,
    completeness: { scope: 'saved_result', details_saved: count('details'), details_total: Number.isSafeInteger(result.details_total) && result.details_total >= 0 ? result.details_total : null,
      details_truncated: typeof result.details_truncated === 'boolean' ? result.details_truncated : null,
      errors_saved: count('errors'), failures_saved: count('failures'), note: '只包含任务已保存的结果；未保存的逐项明细不能从报告恢复。' } };
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method || 'GET';
  const payload = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await bodyOf(req) : {};
  const authenticated = !authRequired || (req.headers.cookie || '').includes('fixture-session=1');
  if (route === '/api/session') return json(res, { required: authRequired, authenticated, session_days: 30, warning: '本地 UI 测试服务：仅包含示例数据' });
  if (route === '/api/login') {
    if (payload.password !== 'fixture') return json(res, { detail: '测试密码为 fixture' }, 401);
    res.setHeader('Set-Cookie', 'fixture-session=1; HttpOnly; SameSite=Strict; Path=/');
    return json(res, { required: true, authenticated: true, session_days: 30 });
  }
  if (route === '/api/logout') {
    res.setHeader('Set-Cookie', 'fixture-session=; Max-Age=0; Path=/');
    return json(res, { ok: true });
  }
  if (route === '/api/health') return json(res, { ok: true, fixture: true });
  if (!authenticated) return json(res, { detail: '请先登录' }, 401);
  if (route === '/api/collections' || route.startsWith('/api/collections/')) return json(res, collections.handle(route, method, url.searchParams, payload));
  if (route === '/api/duplicates' || route === '/api/duplicates/detail' || route === '/api/duplicates/selection') {
    const groups = new Map();
    for (const row of tracks) {
      if (!row.tags_loaded || row.path_derived || !albumText(row.artist) || !albumText(row.title)) continue;
      const group = [albumText(row.artist).toLowerCase(), albumText(row.title).toLowerCase()], key = JSON.stringify(group);
      if (!groups.has(key)) groups.set(key, { group, artist: row.artist, title: row.title, rows: [] });
      groups.get(key).rows.push(row);
    }
    const candidates = [...groups.values()].filter(item => item.rows.length >= 2).sort((a, b) => JSON.stringify(a.group).localeCompare(JSON.stringify(b.group)));
    if (route === '/api/duplicates') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const items = candidates.filter(item => `${item.artist} ${item.title}`.toLowerCase().includes(q)).map(({ group, artist, title, rows }) => ({ group, artist, title, track_count: rows.length }));
      const size = Math.max(1, Math.min(50, Number(url.searchParams.get('page_size')) || 20)), pages = Math.ceil(items.length / size), page = Math.max(1, Math.min(pages || 1, Number(url.searchParams.get('page')) || 1));
      return json(res, { items: items.slice((page - 1) * size, page * size), total: items.length, pages, page, page_size: size });
    }
    const key = JSON.stringify(route.endsWith('/selection') ? payload.group : JSON.parse(url.searchParams.get('group') || 'null'));
    const found = candidates.find(item => JSON.stringify(item.group) === key);
    const suppliedRevision = route.endsWith('/selection') ? payload.revision : url.searchParams.get('revision');
    if (!found) throw fixtureError('分组不存在或成员已经变化', suppliedRevision ? 409 : 404);
    const rows = [...found.rows].sort((a, b) => a.id - b.id), revision = createHash('md5').update(JSON.stringify(rows)).digest('hex');
    if (suppliedRevision && suppliedRevision !== revision) throw fixtureError('分组资料已变化，请刷新核对', 409);
    if (route.endsWith('/selection')) {
      const track = rows.find(item => item.id === payload.track_id);
      if (!suppliedRevision || !track) throw fixtureError('选择的曲目不属于当前分组版本', 409);
      return json(res, { group: found.group, revision, total: rows.length, track, selected_at: Date.now() / 1000 });
    }
    const size = Math.max(1, Math.min(100, Number(url.searchParams.get('page_size')) || 50)), pages = Math.ceil(rows.length / size), wanted = Number(url.searchParams.get('page')) || 1, page = Math.max(1, Math.min(pages, wanted));
    if (wanted > 1 && !suppliedRevision) throw fixtureError('翻页需要当前分组版本', 422);
    const durations = rows.map(row => row.duration).filter(value => Number.isFinite(value) && value > 0);
    return json(res, { group: found.group, revision, total: rows.length, pages, page, page_size: size, items: rows.slice((page - 1) * size, page * size), summary: { bytes: rows.reduce((sum, row) => sum + row.size, 0), duration_min: durations.length ? Math.min(...durations) : null, duration_max: durations.length ? Math.max(...durations) : null, formats: [...new Set(rows.map(row => row.ext.toLowerCase()))].sort(), missing_cover: rows.filter(row => !row.has_cover).length, missing_lyrics: rows.filter(row => !row.has_lyrics).length } });
  }
  if (route === '/api/artists') {
    const grouped = new Map();
    for (const row of tracks) {
      const name = albumText(row.artist); if (!name) continue;
      if (!grouped.has(name)) grouped.set(name, { name, track_count: 0, albums: new Set() });
      const item = grouped.get(name); item.track_count++; if (albumText(row.album)) item.albums.add(albumText(row.album));
    }
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const items = [...grouped.values()].filter(item => item.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).map(({ name, track_count, albums }) => ({ name, track_count, album_count: albums.size }));
    const size = Math.max(1, Math.min(100, Number(url.searchParams.get('page_size')) || 50)), pages = Math.ceil(items.length / size), page = Math.max(1, Math.min(pages || 1, Number(url.searchParams.get('page')) || 1));
    return json(res, { items: items.slice((page - 1) * size, page * size), total: items.length, page, page_size: size, pages });
  }
  if (route === '/api/artist-portraits/status') return json(res, { lastfm: { busy: false, cooldown: false, retry_at: null, retry_after_seconds: null, reason: null, min_interval_seconds: 5 }, navidrome: { configured: true, url: 'http://navidrome.example.test', min_version: '0.61.0' }, cache_days: 7 });
  if (route === '/api/artist-portraits/library' || route === '/api/artist-portraits/history') {
    const history = route.endsWith('/history');
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const state = url.searchParams.get('state') || '';
    const all = history ? [...portraitSyncs.values()].filter(item => item.submitted_at).map(item => ({ token: item.token, portrait_id: item.portrait.id, artist: item.portrait.artist, target: { id: item.target.id, name: item.target.name }, state: item.state, message: item.message || '', created_at: item.created_at, updated_at: item.updated_at })) : [...portraitCache.values()];
    const items = all.filter(item => `${item.artist} ${item.target?.name || ''}`.toLowerCase().includes(q) && (!history || !state || state === 'all' || item.state === state)).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const size = Math.max(1, Math.min(history ? 50 : 48, Number(url.searchParams.get('page_size')) || (history ? 10 : 12))), pages = Math.ceil(items.length / size), page = Math.max(1, Math.min(pages || 1, Number(url.searchParams.get('page')) || 1));
    return json(res, { items: items.slice((page - 1) * size, page * size), total: items.length, page, page_size: size, pages });
  }
  if (route === '/api/artist-portraits/fetch') {
    const artist = String(payload.artist || '').trim(); if (!artist || [...artist].length > 200) throw fixtureError('请填写歌手名', 400);
    const key = JSON.stringify([artist, payload.image_url || null]), cached = portraitCache.has(key);
    if (!cached) {
      const id = `00000000-0000-4000-8000-${String(portraitCache.size + 1).padStart(12, '0')}`;
      portraitCache.set(key, { id, artist, source_page: `https://www.last.fm/music/${encodeURIComponent(artist)}`, source_image: payload.image_url || 'https://lastfm.freetls.fastly.net/i/u/770x0/1234567890abcdef1234567890abcdef.jpg', width: 512, height: 384, created_at: now, preview_url: `/api/artist-portraits/${id}/preview`, preview_format: 'avif', upload_format: 'jpeg' });
    }
    return json(res, { portrait: portraitCache.get(key), cached });
  }
  if (route === '/api/navidrome/test') return json(res, { connected: true, user: { name: 'fixture', is_admin: false }, server_version: '0.64.2', supports_upload: true, min_version: '0.61.0', message: '本地示例服务，未连接真实 Navidrome' });
  if (route === '/api/navidrome/artists') {
    const q = (url.searchParams.get('q') || '').trim(); const items = !q || portraitTarget.name.includes(q) ? [portraitTarget] : [];
    return json(res, { items, total: items.length, page: 1, pages: items.length ? 1 : 0, page_size: 50 });
  }
  if (route === '/api/artist-portraits/sync-preview') {
    const portrait = [...portraitCache.values()].find(item => item.id === payload.portrait_id);
    if (!portrait || payload.artist_id !== portraitTarget.id) throw fixtureError('来源或目标不存在', 404);
    const token = `00000000-0000-4000-9000-${String(portraitSyncs.size + 1).padStart(12, '0')}`;
    const record = { token, portrait, portrait_id: portrait.id, artist: portrait.artist, target: { ...portraitTarget }, sync_state: 'ready', state: 'ready', created_at: Date.now() / 1000, updated_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 600, target_image_url: `/api/artist-portraits/sync/${token}/target-image` };
    portraitSyncs.set(token, record); return json(res, record);
  }
  if (route === '/api/artist-portraits/sync') {
    const record = portraitSyncs.get(payload.token); if (!record) throw fixtureError('同步记录不存在', 404);
    if (record.state !== 'ready') throw fixtureError('同步已提交', 409);
    record.state = 'uploaded'; record.submitted_at = record.updated_at = Date.now() / 1000; record.message = '仅更新内存示例；未同步真实服务'; return json(res, record);
  }
  const portraitStatus = route.match(/^\/api\/artist-portraits\/sync\/([^/]+)$/);
  if (portraitStatus) { const record = portraitSyncs.get(portraitStatus[1]); if (!record) throw fixtureError('同步记录不存在', 404); return json(res, record); }
  const portraitFile = route.match(/^\/api\/artist-portraits\/([0-9a-f-]{36})\/(preview|image|download)$/);
  if (portraitFile) {
    const portrait = [...portraitCache.values()].find(item => item.id === portraitFile[1]);
    if (!portrait) throw fixtureError('本地头像缓存不存在', 404);
    const format = portraitFile[2] === 'preview' ? 'avif' : portraitFile[2] === 'image' ? 'jpeg' : url.searchParams.has('format') ? url.searchParams.get('format') : 'jpeg';
    if (!['jpeg', 'avif'].includes(format)) throw fixtureError('不支持的头像格式', 422);
    res.writeHead(200, { 'Content-Type': `image/${format}`, 'Content-Disposition': `${portraitFile[2] === 'download' ? 'attachment' : 'inline'}; filename="portrait-${portrait.id}.${format === 'jpeg' ? 'jpg' : 'avif'}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(format === 'jpeg' ? portraitJpeg : portraitAvif);
  }
  if (/^\/api\/artist-portraits\/sync\/[^/]+\/target-image$/.test(route)) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); return res.end(coverSvg(route.endsWith('target-image') ? 3 : 1));
  }
  const portraitDetail = route.match(/^\/api\/artist-portraits\/([0-9a-f-]{36})$/);
  if (portraitDetail) {
    const portrait = [...portraitCache.values()].find(item => item.id === portraitDetail[1]);
    if (!portrait) throw fixtureError('本地头像缓存不存在', 404);
    return json(res, { portrait });
  }
  if (route === '/api/status') return json(res, {
    version: '0.4.1-ui-fixture', engine: 'fixture', postgres: true, redis: true, music_dir_exists: true,
    music_dir: '/fixture-music', library_root: '/fixture-music', data_dir: '/fixture-data', db_path: 'memory-only',
    supported_formats: ['flac', 'mp3', 'm4a', 'ogg', 'opus'], docker: false, stats: stats(), tracks: tracks.length,
    scraper: { available: true, sources: sources.map(s => s.name), count: sources.length },
    auto_scan: { enabled: true, watching: true, fast: false, debounce_secs: 10, pending_scopes: 0,
      state: 'watching', error: '', last_job_id: null, last_scan_at: now - 3600, overflow_count: 0 },
  });
  if (route === '/api/storage' || route === '/api/storage/check') {
    const checked = route.endsWith('/check') && method === 'POST';
    const paths = ['/fixture-data', '/fixture-data/covers', '/fixture-data/thumbs'];
    return json(res, {
      checked_at: now, database: { engine: 'PostgreSQL', connected: true, stores: ['曲库索引', '应用设置', '别名', '任务记录'] },
      music: { path: '/fixture-music', exists: true },
      cache: { root: '/fixture-data', format: 'AVIF', on_demand: true,
        originals: { path: paths[1], exists: true, files: 2, bytes: 204800, truncated: false, error: '' },
        thumbnails: { path: paths[2], exists: true, files: 15, bytes: 78600, truncated: false, error: '' } },
      runtime: { container: false },
      write_checks: checked ? paths.map(path => ({ path, state: 'ok', error: '' })) : null,
    });
  }
  if (route === '/api/settings') {
    if (method === 'PUT') { values = { ...values, ...payload.values }; return json(res, { saved: payload.values, warnings: [] }); }
    return json(res, { values, placeholders });
  }
  if (route === '/api/sources') return json(res, { sources });
  if (route === '/api/albums') return json(res, albumPage(url.searchParams));
  if (route === '/api/albums/detail') return json(res, albumDetail(url.searchParams));
  if (route === '/api/albums/selection') return json(res, albumSelection(payload));
  if (route === '/api/folders') return json(res, folderPage(url.searchParams));
  if (route === '/api/tracks') {
    const filtered = filterTracks(url.searchParams);
    const pageSize = Math.min(1000, Math.max(1, Number(url.searchParams.get('page_size')) || 100));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
    return json(res, { total: filtered.length, page, page_size: pageSize, pages, items: filtered.slice((page - 1) * pageSize, page * pageSize) });
  }
  const audioMatch = route.match(/^\/api\/tracks\/(\d+)\/audio$/);
  if (audioMatch) {
    if (!tracks.some(track => track.id === Number(audioMatch[1]))) return json(res, { detail: '没有这条测试曲目' }, 404);
    const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': audioFixture.length }); return res.end(); }
    let start = 0, end = audioFixture.length - 1, code = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${audioFixture.length}` }); return res.end(); }
      if (!match[1]) start = Math.max(0, audioFixture.length - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (start > end || start >= audioFixture.length || (!match[1] && Number(match[2]) <= 0)) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${audioFixture.length}` }); return res.end(); }
      code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${audioFixture.length}`;
    }
    res.writeHead(code, { ...headers, 'Content-Length': end - start + 1 }); return res.end(audioFixture.subarray(start, end + 1));
  }
  const trackMatch = route.match(/^\/api\/tracks\/(\d+)(?:\/(cover|lyrics))?$/);
  if (trackMatch) {
    const track = tracks.find(t => t.id === Number(trackMatch[1]));
    if (!track) return json(res, { detail: '没有这条测试曲目' }, 404);
    if (trackMatch[2] === 'cover') {
      if (!track.has_cover) return json(res, { detail: '无测试封面' }, 404);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(coverSvg(track.id));
    }
    if (trackMatch[2] === 'lyrics') {
      const lyrics = track.has_lyrics ? '[00:00.00] UI 测试歌词\n[00:03.00] 此内容仅用于验证排版和编辑预览。' : '';
      return json(res, { lyrics, has_lyrics: Boolean(lyrics), lines: lyrics ? 2 : 0, chars: lyrics.length });
    }
    return json(res, track);
  }
  if (route === '/api/tracks/selection') return json(res, selectionPage(payload));
  if (route === '/api/tracks/preview') return json(res, preview(payload));
  if (route === '/api/tracks/apply') {
    const ids = selectionIds(payload);
    const selected = ids.map(id => tracks.find(track => track.id === id && id > 0)).filter(Boolean);
    // Full row payloads are fixture setup/restore operations used by browser
    // tests, including empty tags and index-only flags; no real API calls use it.
    if (payload.fields?.id !== undefined) {
      selected.forEach(t => Object.assign(t, payload.fields));
      return json(res, { written: selected.length, failed: [], fields: Object.keys(payload.fields), skipped: 0 });
    }
    const plan = preview(payload, Infinity);
    const failed = plan.items.filter(item => item.current.error).map(item => ({ track_id: item.track_id, error: item.current.error,
      stage: selected.some(track => track.id === item.track_id) ? 'read' : 'lookup', file_changed: false }));
    const items = plan.items.filter(item => !item.current.error).map(item => {
      const track = selected.find(t => t.id === item.track_id);
      Object.assign(track, item.effective_fields);
      const lyrics = Object.hasOwn(item.effective_fields, 'lyrics');
      if (lyrics) track.has_lyrics = 1;
      return { track_id: item.track_id, written: Object.keys(item.effective_fields), skipped: item.skipped, file_changed: item.count > 0, cover: false, lyrics };
    });
    return json(res, { written: items.filter(item => item.file_changed).length, skipped: items.filter(item => !item.file_changed).length, failed, items, fields: [...new Set(items.flatMap(item => item.written))].sort() });
  }
  if (route.startsWith('/api/aliases/')) {
    const kind = route.split('/').at(-1);
    if (!(kind in aliases)) return json(res, { detail: '未知测试别名类型' }, 404);
    if (method === 'PUT') { aliases[kind] = payload.items || []; return json(res, { saved: aliases[kind].length }); }
    return json(res, { items: aliases[kind] });
  }
  if (route === '/api/jobs') return json(res, recentJobs());
  if (route === '/api/jobs/history') {
    const page = historyPage(url.searchParams);
    return page ? json(res, page) : json(res, { detail: '任务历史筛选参数无效' }, 422);
  }
  const jobRoute = route.match(/^\/api\/jobs\/([^/]+)(?:\/(report))?$/);
  if (jobRoute) {
    const job = jobs.find(item => item.id === decodeURIComponent(jobRoute[1]));
    if (!job) return json(res, { detail: '未知测试任务' }, 404);
    if (!jobRoute[2]) return json(res, { ...job, percent: jobPercent(job) });
    if ((url.searchParams.get('format') || 'json') !== 'json') return json(res, { detail: '报告格式无效' }, 422);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="metatidy-job-${job.id}.json"`, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(jobReport(job), null, 2));
  }
  if (route === '/api/scan') return json(res, makeJob('scan', { scanned: tracks.length, added: 0, updated: 0, skipped: tracks.length, removed: 0 }));
  if (route === '/api/search') {
    const track = tracks.find(t => t.id === payload.track_id) || tracks[0];
    const chosenSources = (payload.sources || []).slice(0, 4);
    const candidates = track ? chosenSources.map((source, index) => ({
      ...track, source, title: payload.keyword || track.title, artist: payload.artist_hint || track.artist,
      score: 152 - index * 19, confidence: index < 2 ? '高' : '中',
      cover: track.has_cover ? `/api/tracks/${track.id}/cover` : '', lyrics: '',
      context: '本地测试候选 · 未请求外部数据源',
    })) : [];
    return json(res, { track: track || null, candidates, source_status: chosenSources.map(source => ({ source, count: track ? 1 : 0 })) });
  }
  if (route === '/api/lyrics/preview') return json(res, { lyrics: '[00:00.00] UI 测试歌词\n[00:03.00] 此内容仅用于排版验收。', source: 'fixture' });
  if (route === '/api/scrape/apply') {
    const track = tracks.find(t => t.id === payload.track_id);
    if (!track) return json(res, { detail: '没有这条测试曲目' }, 404);
    const fields = Object.fromEntries((payload.fields || []).filter(field => payload.candidate?.[field] !== undefined && payload.candidate[field] !== '').map(field => [field, payload.candidate[field]]));
    const plan = preview({ ids: [track.id], fields, overwrite: payload.overwrite }, 500, true).items[0];
    const changes = plan.changes;
    Object.assign(track, plan.effective_fields);
    const cover = Boolean(payload.write_cover && payload.candidate?.cover && (payload.overwrite !== false || !track.has_cover));
    const lyrics = Boolean(payload.write_lyrics && payload.candidate?.lyrics && track.lyrics !== payload.candidate.lyrics);
    if (cover) track.has_cover = 1;
    if (lyrics) { track.has_lyrics = 1; track.lyrics = payload.candidate.lyrics; }
    return json(res, { written: Object.keys(plan.effective_fields), changes, cover, lyrics, file_changed: plan.count > 0 || cover || lyrics, skipped: plan.skipped });
  }
  if (route === '/api/scrape/batch') {
    const ids = selectionIds(payload);
    if (!ids.length) throw fixtureError('至少选择一首', 400);
    const missing = ids.filter(id => !tracks.some(track => track.id === id && id > 0));
    const details = ids.map(id => missing.includes(id)
      ? { track_id: id, status: '失败', stage: 'lookup', error: '索引里没有这条曲目', file_changed: false }
      : { track_id: id, status: '无候选' });
    return json(res, makeJob('scrape', { applied: 0, skipped: ids.length - missing.length, failed: missing.length,
      search_only: Number(payload.auto_apply_min_score ?? 0) <= 0, details: details.slice(0, 500), details_total: details.length, details_truncated: details.length > 500 }, ids.length));
  }
  if (route === '/api/template/test') {
    const track = tracks.find(t => t.id === Number(url.searchParams.get('track_id'))) || tracks[0];
    if (!track) return json(res, { detail: '测试曲库为空' }, 400);
    return json(res, { track, source: track.path, target: `/fixture-music/${track.language}/${track.artist}/${track.album}/${track.filename}`, warnings: [] });
  }
  if (route === '/api/move/preview') {
    const ids = selectionIds(payload);
    const matched = ids.length ? ids.map(id => tracks.find(t => t.id === id && id > 0)).filter(Boolean) : tracks;
    if (ids.length !== matched.length && ids.length) throw fixtureError('已选曲目中存在索引缺失项', 400);
    if (!matched.length) throw fixtureError('没有匹配到曲目', 400);
    const selected = matched.slice(0, payload.limit || tracks.length);
    const token = `fixture-plan-${plans.size + 1}`;
    const plan = { token, total: matched.length, planned: selected.length, counts: { move: selected.length }, conflict_policy: payload.conflict_policy || values.conflict_policy,
      library_root: '/fixture-music', dir_template: payload.dir_template || values.dir_template, filename_template: payload.filename_template || values.filename_template,
      truncated: selected.length < matched.length, template_warnings: [], display_truncated: selected.length > 500, executed: false,
      items: selected.map(t => ({ track_id: t.id, filename: t.filename, artist: t.artist, title: t.title, source: t.path, target: `/fixture-music/整理预览/${t.filename}`, action: 'move', reason: '', warning: '' })) };
    plans.set(token, plan);
    return json(res, { ...plan, items: plan.items.slice(0, 500) });
  }
  const planRoute = route.match(/^\/api\/move\/plan\/([^/]+)(?:\/(items|export))?$/);
  if (planRoute) {
    const plan = plans.get(planRoute[1]);
    if (!plan) return json(res, { detail: '未知测试计划' }, 404);
    if (!planRoute[2]) return json(res, { ...plan, _executed: plan.executed, _token: plan.token });
    const q = (url.searchParams.get('q') || '').trim();
    const action = (url.searchParams.get('action') || '').trim();
    const pageSize = Number(url.searchParams.get('page_size') || 100);
    if (q.length > 500 || action && !['move', 'in_place', 'conflict_rename', 'conflict_skip', 'conflict_overwrite', 'invalid'].includes(action)
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) return json(res, { detail: '计划筛选参数无效' }, 422);
    const items = plan.items.map((item, index) => ({ ...item, ordinal: index + 1 })).filter(item => (!action || item.action === action)
      && (!q || ['source', 'target', 'filename', 'title', 'artist', 'reason', 'warning', 'track_id'].some(key => String(item[key] || '').toLowerCase().includes(q.toLowerCase()))));
    const report = { ...plan, q, action, filtered_total: items.length, items };
    if (planRoute[2] === 'items') {
      const pages = Math.ceil(items.length / pageSize);
      const page = Math.max(1, Math.min(pages || 1, Number(url.searchParams.get('page')) || 1));
      return json(res, { ...report, page, pages, page_size: pageSize, items: items.slice((page - 1) * pageSize, page * pageSize) });
    }
    const format = url.searchParams.get('format') || 'csv';
    if (!['csv', 'json'].includes(format)) return json(res, { detail: '报告格式无效' }, 422);
    report.report_type = 'move_plan'; report.report_scope = q || action ? 'filtered' : 'complete';
    let content = JSON.stringify(report, null, 2);
    if (format === 'csv') {
      const fields = ['ordinal', 'track_id', 'source', 'target', 'action', 'reason', 'filename', 'artist', 'title', 'warning'];
      const cell = value => {
        const text = String(value ?? '');
        return `"${(/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\s]*[\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
      };
      content = '\uFEFF' + ['report_type,plan_token,' + fields.join(','), ...items.map(item => ['move_plan', plan.token, ...fields.map(key => item[key])].map(cell).join(','))].join('\r\n');
    }
    res.writeHead(200, { 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="metatidy-move-plan-${plan.token}.${format}"`, 'Cache-Control': 'no-store' });
    return res.end(content);
  }
  if (route === '/api/move/execute') {
    const plan = plans.get(payload.token);
    if (!plan) return json(res, { detail: '未知测试计划' }, 404);
    const summary = { moved: 0, skipped: plan.planned, failed: 0, renamed: 0, failures: [] };
    if (payload.dry_run) return json(res, summary);
    if (plan.executed) return json(res, { detail: '计划已提交' }, 409);
    plan.executed = true;
    return json(res, makeJob('move', summary));
  }
  return json(res, { detail: `UI fixture does not implement ${method} ${route}` }, 404);
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).slice(1);
    const file = path.resolve(staticRoot, relative);
    if (!file.startsWith(path.resolve(staticRoot) + path.sep)) return json(res, { detail: 'Forbidden' }, 403);
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch (error) {
    json(res, { detail: error.code === 'ENOENT' ? 'Fixture resource not found' : error.message }, error.code === 'ENOENT' ? 404 : error.status || 500);
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Metatidy UI FIXTURE: http://127.0.0.1:${port}/ (${tracks.length} example tracks${authRequired ? '; test password: fixture' : ''})`);
  console.log('Development only. Generated WAV only; no real music, database, external requests or filesystem mutations.');
});
