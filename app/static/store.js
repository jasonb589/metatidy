/**
 * 极简状态容器 + 事件总线。
 * 只有一个可变对象 state 和一套手动重渲染：列表接口分页返回，页内最多 200 行，
 * 重建 tbody 的成本远低于框架运行时；输入类操作走防抖，避免每次按键全表刷新。
 */

const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event).delete(handler);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[metatidy] 事件 ${event} 的处理函数出错`, err);
    }
  }
}

export const state = {
  tab: "tracks",
  status: null,
  settings: null,
  placeholders: [],
  sources: [],
  /** 刮削页当前勾选的数据源 id */
  sourceChoice: new Set(),
  /** 跨页保留的多选：id -> 行快照 */
  selection: new Map(),
  /** 刮削页的「当前曲目」 */
  currentTrackId: null,

  tracks: {
    items: [],
    total: 0,
    page: 1,
    page_size: 100,
    pages: 1,
    q: "",
    sort: "artist",
    order: "asc",
    filters: {
      language: "",
      albumtype: "",
      genre: "",
      year: "",
      missing_cover: false,
      missing_lyrics: false,
      no_artist: false,
      no_album: false,
    },
    loading: false,
    error: "",
    loadedAt: 0,
  },

  edit: {
    rows: [],
    open: false,
    busy: false,
  },

  scrape: {
    pickQ: "",
    pickPage: 1,
    pickPageSize: 50,
    pickItems: [],
    pickTotal: 0,
    pickPages: 1,
    loadingPick: false,
    keyword: "",
    artistHint: "",
    searching: false,
    searched: false,
    candidates: [],
    sourceStatus: [],
    chosenIndex: -1,
    chosenFields: new Set(),
    error: "",
    result: null,
  },

  move: {
    dirTemplate: "",
    filenameTemplate: "",
    conflict: "rename",
    scope: "all",
    limit: 0,
    plan: null,
    filterAction: "",
    busy: false,
    summary: null,
    progressLabel: "",
  },
};

/* ------------------------------------------------------------------ 多选 */

export function isSelected(id) {
  return state.selection.has(Number(id));
}

/** 存入行快照，这样翻页 / 换筛选后仍能显示已选曲目信息。 */
export function rowSnapshot(row) {
  return {
    id: Number(row.id),
    title: row.title || "",
    artist: row.artist || "",
    album: row.album || "",
    filename: row.filename || "",
    path: row.path || "",
    has_cover: row.has_cover || 0,
    has_lyrics: row.has_lyrics || 0,
    language: row.language || "",
  };
}

export function toggleSelect(row, force) {
  const id = Number(row.id);
  const want = force === undefined ? !state.selection.has(id) : Boolean(force);
  if (want) state.selection.set(id, rowSnapshot(row));
  else state.selection.delete(id);
  emit("selection:changed");
  return want;
}

export function selectRows(rows, want = true) {
  rows.forEach((row) => {
    const id = Number(row.id);
    if (want) state.selection.set(id, rowSnapshot(row));
    else state.selection.delete(id);
  });
  emit("selection:changed");
}

export function clearSelection() {
  state.selection.clear();
  emit("selection:changed");
}

export function selectionIds() {
  return [...state.selection.keys()];
}

export function selectionRows() {
  return [...state.selection.values()];
}

export function selectionCount() {
  return state.selection.size;
}

export function removeFromSelection(ids) {
  let changed = false;
  ids.forEach((id) => {
    if (state.selection.delete(Number(id))) changed = true;
  });
  if (changed) emit("selection:changed");
}

export function currentTrackRow() {
  const id = state.currentTrackId;
  if (!id) return null;
  if (state.selection.has(id)) return state.selection.get(id);
  const fromTracks = state.tracks.items.find((row) => Number(row.id) === Number(id));
  if (fromTracks) return fromTracks;
  const fromPick = state.scrape.pickItems.find((row) => Number(row.id) === Number(id));
  return fromPick || null;
}

export function setCurrentTrack(row) {
  state.currentTrackId = row ? Number(row.id) : null;
  emit("current:changed", row);
}

export function statusStats() {
  return (state.status && state.status.stats) || {
    tracks: 0,
    artists: 0,
    albums: 0,
    missing_cover: 0,
    missing_lyrics: 0,
    no_artist: 0,
    no_album: 0,
    bytes: 0,
    languages: [],
    albumtypes: [],
  };
}
