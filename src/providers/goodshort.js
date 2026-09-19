const EPISODE_LINK_RE = /\/(episode|episodes|drama)\//i;

function absoluteUrl(value, base) {
  try { return new URL(value, base).href; } catch { return null; }
}

export const goodShortProvider = {
  name: 'goodshort',

  matches(url) {
    return /(^|\.)goodshort\.com$/i.test(new URL(url).hostname);
  },

  async extractPage(page) {
    return page.evaluate(() => {
      const out = [];
      const seen = new Set();

      const add = (obj = {}) => {
        if (!obj || typeof obj !== 'object') return;

        const mediaUrl =
          obj.mediaUrl ||
          obj.videoUrl ||
          obj.video_url ||
          obj.playbackUrl ||
          obj.playback_url ||
          obj.streamUrl ||
          obj.stream_url ||
          obj.hlsUrl ||
          obj.hls_url ||
          obj.manifestUrl ||
          obj.manifest_url ||
          obj.url ||
          null;

        const sourceUrl = obj.sourceUrl || obj.webUrl || obj.pageUrl || location.href;
        const id = obj.id || obj.episodeId || obj.episode_id || obj.videoId || obj.video_id || null;

        if (!mediaUrl && !id && !obj.title && !obj.name && !obj.href) return;

        const key = String(id || mediaUrl || obj.href || sourceUrl);
        if (seen.has(key)) return;
        seen.add(key);

        const absoluteMedia = typeof mediaUrl === 'string'
          ? (() => { try { return new URL(mediaUrl, location.href).href; } catch { return null; } })()
          : null;

        out.push({
          sourceUrl: obj.href ? (() => { try { return new URL(obj.href, location.href).href; } catch { return sourceUrl; } })() : sourceUrl,
          title: obj.title || obj.name || null,
          thumbnailUrl: obj.thumbnailUrl || obj.thumbnail_url || obj.coverUrl || obj.poster || null,
          mediaUrl: absoluteMedia,
          providerId: id || null,
          kind: obj.href && /\/(episode|episodes|drama)\//i.test(obj.href) ? 'episode' : 'page'
        });
      };

      const addAnchor = (a) => {
        const href = a?.href || null;
        if (!href) return;
        const img = a.querySelector?.('img');
        add({
          href,
          title: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300) || document.title,
          thumbnailUrl: img?.currentSrc || img?.src || null
        });
      };

      document.querySelectorAll('a[href]').forEach(addAnchor);

      document.querySelectorAll(
        'article, [class*="episode"], [class*="reel"], [class*="video"], [class*="playlet"]'
      ).forEach(el => {
        const a = el.querySelector?.('a[href]');
        const video = el.querySelector?.('video');
        const source = el.querySelector?.('source');
        const dataMedia =
          el.getAttribute?.('data-src') ||
          el.getAttribute?.('data-url') ||
          el.getAttribute?.('data-video') ||
          el.getAttribute?.('data-media');

        add({
          href: a?.href || null,
          title: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300) || document.title,
          thumbnailUrl: el.querySelector?.('img')?.currentSrc || el.querySelector?.('img')?.src || null,
          mediaUrl: video?.currentSrc || video?.src || source?.src || dataMedia || null
        });
      });

      document.querySelectorAll('video').forEach(v => {
        add({
          mediaUrl: v.currentSrc || v.src || null,
          thumbnailUrl: v.poster || null,
          title: document.title || null
        });
      });

      // GoodShort currently renders much of the player from JavaScript.
      // Inspect public page data/scripts for directly exposed HLS/DASH/MP4 URLs.
      for (const s of document.scripts) {
        const text = s.textContent || '';
        if (!text || text.length > 1500000) continue;

        try {
          const parsed = JSON.parse(text);
          const walk = (value, depth = 0) => {
            if (depth > 8 || value == null) return;
            if (Array.isArray(value)) {
              value.forEach(v => walk(v, depth + 1));
              return;
            }
            if (typeof value !== 'object') return;
            add(value);
            Object.values(value).forEach(v => walk(v, depth + 1));
          };
          walk(parsed);
        } catch {}

        const matches = text.match(
          /https?:\/\/[^\s"'\\<>]+(?:\.m3u8|\.mpd|\.mp4|\.webm)(?:\?[^\s"'\\<>]*)?/gi
        ) || [];

        for (const raw of matches) {
          add({ mediaUrl: raw.replace(/\\\\/g, '') });
        }
      }

      return out.slice(0, 500);
    });
  },

  async discoverEpisodeUrls(page, limit = 6) {
    const rows = await this.extractPage(page);
    const urls = [];
    const seen = new Set();

    for (const row of rows) {
      if (row.kind !== 'episode' || !row.sourceUrl) continue;
      const url = absoluteUrl(row.sourceUrl, page.url());
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= limit) break;
    }

    return urls;
  },

  isEpisodeUrl(url) {
    return EPISODE_LINK_RE.test(url);
  }
};
