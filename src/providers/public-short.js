function safeAbsolute(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function createPublicShortProvider({ name, hostPattern, pathPattern }) {
  return {
    name,

    matches(url) {
      try {
        return hostPattern.test(new URL(url).hostname);
      } catch {
        return false;
      }
    },

    async extractPage(page) {
      return page.evaluate(({ pathPatternSource }) => {
        const out = [];
        const seen = new Set();
        const pathPattern = new RegExp(pathPatternSource, 'i');

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

          const sourceUrl = obj.sourceUrl || obj.webUrl || obj.pageUrl || obj.href || location.href;
          const id =
            obj.id ||
            obj.reelId ||
            obj.reel_id ||
            obj.episodeId ||
            obj.episode_id ||
            obj.videoId ||
            obj.video_id ||
            null;

          if (!mediaUrl && !id && !obj.title && !obj.name && !obj.href) return;

          const source = typeof sourceUrl === 'string'
            ? (() => { try { return new URL(sourceUrl, location.href).href; } catch { return location.href; } })()
            : location.href;

          const media = typeof mediaUrl === 'string'
            ? (() => { try { return new URL(mediaUrl, location.href).href; } catch { return null; } })()
            : null;

          const key = String(id || media || source);
          if (seen.has(key)) return;
          seen.add(key);

          out.push({
            sourceUrl: source,
            mediaUrl: media,
            title: obj.title || obj.name || null,
            thumbnailUrl:
              obj.thumbnailUrl ||
              obj.thumbnail_url ||
              obj.coverUrl ||
              obj.cover_url ||
              obj.poster ||
              null,
            providerId: id || null,
            kind: pathPattern.test(new URL(source).pathname) ? 'episode' : 'page'
          });
        };

        document.querySelectorAll('a[href]').forEach(a => {
          add({
            href: a.href,
            title: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300),
            thumbnailUrl: a.querySelector('img')?.currentSrc || a.querySelector('img')?.src || null
          });
        });

        document.querySelectorAll(
          'article, [class*="episode"], [class*="reel"], [class*="video"], [class*="drama"], [class*="movie"], [class*="playlet"]'
        ).forEach(el => {
          const a = el.querySelector('a[href]');
          const video = el.querySelector('video');
          const source = el.querySelector('source');
          add({
            href: a?.href || null,
            title: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300),
            thumbnailUrl: el.querySelector('img')?.currentSrc || el.querySelector('img')?.src || null,
            mediaUrl:
              video?.currentSrc ||
              video?.src ||
              source?.src ||
              el.getAttribute('data-src') ||
              el.getAttribute('data-video') ||
              el.getAttribute('data-media') ||
              null
          });
        });

        document.querySelectorAll('video').forEach(v => {
          add({
            mediaUrl: v.currentSrc || v.src || null,
            thumbnailUrl: v.poster || null,
            title: document.title || null
          });
        });

        for (const script of document.scripts) {
          const text = script.textContent || '';
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
            add({ mediaUrl: raw.replace(/\\/g, '') });
          }
        }

        return out.slice(0, 500);
      }, { pathPatternSource: pathPattern.source });
    }
  };
}

export const reelShortProvider = createPublicShortProvider({
  name: 'reelshort',
  hostPattern: /(^|\.)reelshort\.com$/i,
  pathPattern: /\/(movie|episode|episodes|watch|drama|reel)\//
});

export const flexTvProvider = createPublicShortProvider({
  name: 'flextv',
  hostPattern: /(^|\.)flextv\.cc$/i,
  pathPattern: /\/(drama|dramas|episode|episodes|watch|movie|reel)\//
});
