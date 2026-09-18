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

      const add = (el) => {
        const a = el.matches?.('a[href]') ? el : el.querySelector?.('a[href]');
        const href = a?.href || null;
        const video = el.querySelector?.('video');
        const img = el.querySelector?.('img');

        if (!href && !video) return;

        const key = href || video?.currentSrc || video?.src;
        if (!key || seen.has(key)) return;
        seen.add(key);

        out.push({
          sourceUrl: href || location.href,
          title: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300) || document.title,
          thumbnailUrl: img?.currentSrc || img?.src || null,
          mediaUrl: video?.currentSrc || video?.src || null,
          kind: href && /\/(episode|episodes|drama)\//i.test(href) ? 'episode' : 'page'
        });
      };

      document.querySelectorAll('a[href]').forEach(a => add(a));
      document.querySelectorAll('article, [class*="episode"], [class*="reel"], [class*="video"], [class*="playlet"]').forEach(add);
      document.querySelectorAll('video').forEach(add);

      return out.slice(0, 200);
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
