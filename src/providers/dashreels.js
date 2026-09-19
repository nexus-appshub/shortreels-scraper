export const dashReelsProvider = {
  name: 'dashreels',

  matches(url) {
    return /dashreels/i.test(new URL(url).hostname) || /dashtoon\\.ai/i.test(new URL(url).hostname);
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
          obj.url;

        const sourceUrl = obj.sourceUrl || obj.webUrl || obj.pageUrl || location.href;
        const id = obj.id || obj.reelId || obj.reel_id || obj.episodeId || obj.episode_id || obj.videoId || obj.video_id;

        if (!mediaUrl && !id && !obj.title && !obj.name) return;

        const key = String(id || mediaUrl || sourceUrl);
        if (seen.has(key)) return;
        seen.add(key);

        out.push({
          sourceUrl,
          mediaUrl: typeof mediaUrl === 'string' && /^(https?:)?\\/\\//i.test(mediaUrl) ? mediaUrl : null,
          title: obj.title || obj.name || obj.showName || obj.show_name || null,
          thumbnailUrl: obj.thumbnailUrl || obj.thumbnail_url || obj.coverUrl || obj.cover_url || obj.poster || null,
          providerId: id || null
        });
      };

      const walk = (value, depth = 0) => {
        if (depth > 8 || value == null) return;
        if (Array.isArray(value)) return value.forEach(v => walk(v, depth + 1));
        if (typeof value !== 'object') return;
        add(value);
        Object.values(value).forEach(v => walk(v, depth + 1));
      };

      for (const s of document.scripts) {
        const text = s.textContent || '';
        if (!text || text.length > 1000000) continue;

        try {
          walk(JSON.parse(text));
        } catch {
          // Some SPA bundles contain escaped media URLs rather than JSON.
          const matches = text.match(/https?:\\/\\/[^"'\\\\\\s]+(?:\\.m3u8|\\.mpd|\\.mp4)(?:\\?[^"'\\\\\\s]*)?/gi) || [];
          for (const url of matches) add({ mediaUrl: url.replace(/\\\\/g, '') });
        }
      }

      document.querySelectorAll('video').forEach(v => {
        add({
          mediaUrl: v.currentSrc || v.src || null,
          thumbnailUrl: v.poster || null,
          title: document.title || null
        });
      });

      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        if (!href || !/^https?:/i.test(href)) return;
        if (!/dashreels|dashtoon/i.test(new URL(href).hostname)) return;
        if (/show|reel|episode|drama|watch|video/i.test(new URL(href).pathname)) {
          add({ sourceUrl: href, title: a.textContent?.trim() || null });
        }
      });

      return out.slice(0, 500);
    });
  }
};