export function normalizeUrl(value, baseUrl) {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

export function mediaType(url = '', contentType = '') {
  const u = url.toLowerCase();
  const ct = contentType.toLowerCase();
  if (u.includes('.m3u8') || ct.includes('mpegurl')) return 'hls';
  if (u.includes('.mpd') || ct.includes('dash+xml')) return 'dash';
  if (/\.mp4(?:$|[?#])/i.test(u) || ct.includes('video/mp4')) return 'mp4';
  if (/\.webm(?:$|[?#])/i.test(u) || ct.includes('video/webm')) return 'webm';
  if (/\.ts(?:$|[?#])/i.test(u) || ct.includes('mp2t')) return 'segment';
  return null;
}

export function isManifest(url, contentType = '') {
  const type = mediaType(url, contentType);
  return type === 'hls' || type === 'dash';
}

export function stableId(parts) {
  const input = parts.filter(Boolean).join('|');
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function pickBetterMedia(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  const rank = { hls: 5, dash: 4, mp4: 3, webm: 2, segment: 1 };
  return (rank[candidate.type] || 0) > (rank[current.type] || 0) ? candidate : current;
}