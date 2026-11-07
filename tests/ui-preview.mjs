/**
 * Isolated UI fixture server. No database, audio files, or external services.
 * All mutations affect this process's memory only; restarting resets everything.
 * Run: node tests/ui-preview.mjs [--port=8765] [--empty] [--auth]
 * This is development/test tooling and is never loaded by the production UI.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const staticRoot = fileURLToPath(new URL('../app/static/', import.meta.url));
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] || 8765);
const empty = process.argv.includes('--empty');
const authRequired = process.argv.includes('--auth');
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
  message: '测试样本已就绪 · 未扫描真实文件', error: '', created_at: now - 3600,
  result: JSON.stringify({ scanned: tracks.length, added: tracks.length, updated: 0, skipped: 0, removed: 0 }),
}];
const plans = new Map();
const albumText = value => String(value || '').replace(/^ +| +$/g, '');

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
    const number = value => {
      const part = albumText(String(value || '').split('/')[0]);
      return /^[0-9]{1,9}$/.test(part) ? Number(part) : null;
    };
    const direction = params.get('order') === 'desc' ? -1 : 1;
    result.sort((a, b) => {
      const disc = ((number(a.disc) ?? 1) - (number(b.disc) ?? 1)) * direction;
      const aTrack = number(a.track), bTrack = number(b.track);
      return disc || (aTrack === null ? bTrack === null ? 0 : 1 : bTrack === null ? -1 : (aTrack - bTrack) * direction) || a.id - b.id;
    });
    return result;
  }
  const key = { indexed: 'indexed_at', edited: 'edited_at' }[params.get('sort')] || params.get('sort') || 'artist';
  result.sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || ''), 'zh-CN', { numeric: true }));
  if (params.get('order') === 'desc') result.reverse();
  return result;
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
  let items = [...grouped].map(([key, rows]) => {
    const [album, album_artist] = JSON.parse(key);
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
  });
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

function preview(payload) {
  const fields = payload.fields || {};
  const items = tracks.filter(t => (payload.ids || []).includes(t.id)).map(t => {
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
  return { fields, items, changed_fields: items.reduce((n, item) => n + item.count, 0), truncated: false };
}

function makeJob(kind, result) {
  const job = { id: `fixture-${kind}-${jobs.length + 1}`, kind, state: 'done', done: tracks.length, total: tracks.length, created_at: now, message: '测试操作完成（仅内存模拟）', error: '', result: JSON.stringify(result) };
  jobs.unshift(job);
  return { job_id: job.id };
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method || 'GET';
  const payload = ['POST', 'PUT'].includes(method) ? await bodyOf(req) : {};
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
  if (route === '/api/tracks') {
    const filtered = filterTracks(url.searchParams);
    const pageSize = Math.min(1000, Math.max(1, Number(url.searchParams.get('page_size')) || 100));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
    return json(res, { total: filtered.length, page, page_size: pageSize, pages, items: filtered.slice((page - 1) * pageSize, page * pageSize) });
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
  if (route === '/api/tracks/preview') return json(res, preview(payload));
  if (route === '/api/tracks/apply') {
    const selected = tracks.filter(t => (payload.ids || []).includes(t.id));
    // Full row payloads are fixture setup/restore operations used by browser
    // tests, including empty tags and index-only flags; no real API calls use it.
    if (payload.fields?.id !== undefined) {
      selected.forEach(t => Object.assign(t, payload.fields));
      return json(res, { written: selected.length, failed: [], fields: Object.keys(payload.fields), skipped: 0 });
    }
    const plan = preview(payload);
    const items = plan.items.map(item => {
      const track = selected.find(t => t.id === item.track_id);
      Object.assign(track, item.effective_fields);
      const lyrics = Object.hasOwn(item.effective_fields, 'lyrics');
      if (lyrics) track.has_lyrics = 1;
      return { track_id: item.track_id, written: Object.keys(item.effective_fields), skipped: item.skipped, file_changed: item.count > 0, cover: false, lyrics };
    });
    return json(res, { written: items.filter(item => item.file_changed).length, skipped: items.filter(item => !item.file_changed).length, failed: [], items, fields: [...new Set(items.flatMap(item => item.written))].sort() });
  }
  if (route.startsWith('/api/aliases/')) {
    const kind = route.split('/').at(-1);
    if (!(kind in aliases)) return json(res, { detail: '未知测试别名类型' }, 404);
    if (method === 'PUT') { aliases[kind] = payload.items || []; return json(res, { saved: aliases[kind].length }); }
    return json(res, { items: aliases[kind] });
  }
  if (route === '/api/jobs') return json(res, { jobs });
  if (route.startsWith('/api/jobs/')) return json(res, jobs.find(job => job.id === route.split('/').at(-1)) || { detail: '未知测试任务' });
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
    const plan = preview({ ids: [track.id], fields, overwrite: payload.overwrite }).items[0];
    const changes = plan.changes;
    Object.assign(track, plan.effective_fields);
    const cover = Boolean(payload.write_cover && payload.candidate?.cover && (payload.overwrite !== false || !track.has_cover));
    const lyrics = Boolean(payload.write_lyrics && payload.candidate?.lyrics && track.lyrics !== payload.candidate.lyrics);
    if (cover) track.has_cover = 1;
    if (lyrics) { track.has_lyrics = 1; track.lyrics = payload.candidate.lyrics; }
    return json(res, { written: Object.keys(plan.effective_fields), changes, cover, lyrics, file_changed: plan.count > 0 || cover || lyrics, skipped: plan.skipped });
  }
  if (route === '/api/scrape/batch') return json(res, makeJob('scrape', { applied: 0, skipped: (payload.ids || []).length, failed: 0, details: [] }));
  if (route === '/api/template/test') {
    const track = tracks.find(t => t.id === Number(url.searchParams.get('track_id'))) || tracks[0];
    if (!track) return json(res, { detail: '测试曲库为空' }, 400);
    return json(res, { track, source: track.path, target: `/fixture-music/${track.language}/${track.artist}/${track.album}/${track.filename}`, warnings: [] });
  }
  if (route === '/api/move/preview') {
    const selected = (payload.ids ? tracks.filter(t => payload.ids.includes(t.id)) : tracks).slice(0, payload.limit || tracks.length);
    const token = `fixture-plan-${plans.size + 1}`;
    const plan = { token, total: selected.length, planned: selected.length, counts: { move: selected.length }, conflict_policy: payload.conflict_policy, template_warnings: [], display_truncated: false,
      items: selected.map(t => ({ track_id: t.id, source: t.path, target: `/fixture-music/整理预览/${t.filename}`, action: 'move', reason: '', warning: '' })) };
    plans.set(token, plan);
    return json(res, plan);
  }
  if (route.startsWith('/api/move/plan/')) return json(res, plans.get(route.split('/').at(-1)) || { detail: '未知测试计划' });
  if (route === '/api/move/execute') return json(res, makeJob('move', { moved: 0, skipped: tracks.length, failed: 0, dry_run: true, details: [] }));
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
    json(res, { detail: error.code === 'ENOENT' ? 'Fixture resource not found' : error.message }, error.code === 'ENOENT' ? 404 : 500);
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Metatidy UI FIXTURE: http://127.0.0.1:${port}/ (${tracks.length} example tracks${authRequired ? '; test password: fixture' : ''})`);
  console.log('Development only. No real audio, database, external requests or filesystem mutations.');
});
