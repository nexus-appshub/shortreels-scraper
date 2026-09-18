export const genericProvider = {
  name: 'generic',
  matches() { return true; },
  async extractPage(page) {
    return page.evaluate(() => {
      const items = [];
      const push = (item) => {
        if (!item) return;
        const sourceUrl = item.sourceUrl || location.href;
        const title = item.title || document.title || null;
        items.push({ sourceUrl, title, thumbnailUrl: item.thumbnailUrl || null, mediaUrl: item.mediaUrl || null });
      };
      document.querySelectorAll('video').forEach(v => {
        push({ mediaUrl: v.currentSrc || v.src, thumbnailUrl: v.poster });
      });
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        if (/reel|short|video|episode/i.test(href)) push({ sourceUrl: href, title: a.textContent?.trim() });
      });
      return items.slice(0, 100);
    });
  }
};