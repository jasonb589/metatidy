/** Artist names match PostgreSQL BTRIM: only surrounding ASCII spaces fold. */
export function normalizeArtistGroup(value) {
  if (typeof value !== "string" || value.includes("\0") || [...value].length > 4000) return "";
  return value.replace(/^ +| +$/g, "");
}
