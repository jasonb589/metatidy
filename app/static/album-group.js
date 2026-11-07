/** Album scope uses the same two values as the PostgreSQL grouping key. */
export function normalizeAlbumGroup(value) {
  if (typeof value !== "string" || !value || value.length > 64000) return "";
  try {
    const parts = JSON.parse(value);
    if (!Array.isArray(parts) || parts.length !== 2 || parts.some((part) => typeof part !== "string")) return "";
    // PostgreSQL BTRIM(text) removes ASCII spaces, not every Unicode whitespace.
    const [album, artist] = parts.map((part) => part.replace(/^ +| +$/g, ""));
    if ([...album].length > 4000 || [...artist].length > 4000) return "";
    return album ? JSON.stringify([album, artist]) : "";
  } catch { return ""; }
}

export function albumGroupLabel(value) {
  const group = normalizeAlbumGroup(value);
  if (!group) return "";
  const [album, artist] = JSON.parse(group);
  return `${album} · ${artist || "未知专辑艺术家"}`;
}
