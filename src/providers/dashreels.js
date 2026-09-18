export const dashReelsProvider = {
  name: 'dashreels',
  matches(url) {
    return /dashreels/i.test(new URL(url).hostname) || /dashtoon\.ai/i.test(new URL(url).hostname);
  },
  async extractPage(page) {
    return page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const add = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        const mediaUrl = obj.mediaUrl || obj.videoUrl || obj.playbackUrl || obj.streamUrl || obj.url;
        const sourceUrl = obj.sourceUrl || obj.webUrl || obj.pageUrl || location.href;
        const id = obj.id || obj.reelId || obj.episodeId || obj.videoId;
        if (!mediaUrl && !id && !obj.title) return;
        const key = String(id || mediaUrl || sourceUrl);
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ sourceUrl, mediaUrl: mediaUrl || null, title: obj.title || obj.name || null, thumbnailUrl: obj.thumbnailUrl || obj.coverUrl || obj.poster || null, providerId: id || null });
      };
      const walk = (value, depth = 0) => {
        if (depth > 5 || value == null) return;
        if (Array.isArray(value)) return value.forEach(v => walk(v, depth + 1));
        if (typeof value !== 'object') return;
        add(value);
        Object.values(value).forEach(v => walk(v, depth + 1));
      };
      for (const s of document.scripts) {
        const text = s.textContent || '';
        if (!text || text.length > 500000) continue;
        try { walk(JSON.parse(text)); } catch {}
      }
      return out.slice(0, 250);
    });
  }
};