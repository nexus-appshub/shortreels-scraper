export const goodShortProvider = {
  name: 'goodshort',
  matches(url) {
    return /(^|\.)goodshort\.com$/i.test(new URL(url).hostname);
  },
  async extractPage(page) {
    return page.evaluate(() => {
      const out = [];
      const cards = document.querySelectorAll('a[href], article, [class*="episode"], [class*="reel"], [class*="video"]');
      for (const el of cards) {
        const a = el.matches('a[href]') ? el : el.querySelector('a[href]');
        const img = el.querySelector('img');
        const video = el.querySelector('video');
        if (!a && !video) continue;
        out.push({
          sourceUrl: a?.href || location.href,
          title: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300) || document.title,
          thumbnailUrl: img?.currentSrc || img?.src || null,
          mediaUrl: video?.currentSrc || video?.src || null
        });
      }
      return out.slice(0, 150);
    });
  }
};