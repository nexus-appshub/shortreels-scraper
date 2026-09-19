import { chromium } from 'playwright';
import { dashReelsProvider } from './providers/dashreels.js';
import { goodShortProvider } from './providers/goodshort.js';
import { genericProvider } from './providers/generic.js';
import { mediaType, normalizeUrl, pickBetterMedia, stableId } from './utils.js';

const providers = [goodShortProvider, dashReelsProvider, genericProvider];

export class ReelSession {
  constructor({ url, headless = true, scrollStep = 1100, scrollWait = 900, maxItems = 500 }) {
    this.url = url;
    this.headless = headless;
    this.scrollStep = scrollStep;
    this.scrollWait = scrollWait;
    this.maxItems = maxItems;

    this.browser = null;
    this.context = null;
    this.page = null;

    this.items = new Map();
    this.networkCandidates = new Map();
    this.resolvedPages = new Set();

    this.provider = providers.find(p => p.matches(url))?.name || 'generic';
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.revision = 0;
  }

  attachNetworkCapture(page, sourceUrl) {
    const capture = (url, contentType = '') => {
      const type = mediaType(url, contentType);
      if (!type || type === 'segment') return;

      const normalized = normalizeUrl(url, sourceUrl);
      if (!normalized) return;

      this.networkCandidates.set(normalized, {
        url: normalized,
        type,
        contentType: contentType || null,
        sourceUrl
      });
    };

    page.on('response', async response => {
      try {
        const contentType = response.headers()['content-type'] || '';
        capture(response.url(), contentType);

        // DashReels commonly exposes the playable URL through JSON API
        // responses. Inspect JSON bodies as well as the actual media request.
        if (/json|javascript|text/i.test(contentType) && /dashreels|dashtoon/i.test(response.url())) {
          const body = await response.text().catch(() => '');
          if (body) {
            const urls = body.match(/https?:\/\/[^\s"'\\]+/gi) || [];
            for (const raw of urls) {
              const candidate = raw.replace(/\\/g, '');
              capture(candidate);
            }
          }
        }
      } catch {}
    });

    page.on('request', request => {
      try {
        capture(request.url());
      } catch {}
    });
  }

  async start() {
    this.browser = await chromium.launch({ headless: this.headless });

    this.context = await this.browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'ShortReelsScraper/0.3 (+public-media-resolver)'
    });

    this.page = await this.context.newPage();
    this.attachNetworkCapture(this.page, this.url);

    await this.page.goto(this.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    await this.page.waitForTimeout(this.scrollWait);

    const newItems = await this.collect();
    return this.snapshot(50, newItems);
  }

  async collect() {
    this.lastActivity = Date.now();

    const before = new Set(this.items.keys());
    const provider = providers.find(p => p.name === this.provider) || genericProvider;

    const pageItems = await provider.extractPage(this.page).catch(() => []);

    for (const item of pageItems) {
      this.addItem(item, 'dom');
    }

    // GoodShort uses listing/drama/episode pages. Follow public page links
    // and observe the media requests made by the normal web player.
    if (this.provider === 'goodshort') {
      await this.deepScrapeGoodShort(pageItems);
    }

    // DashReels is a SPA: the feed API can contain the video metadata while
    // the player may not request media until a video is initialized. Trigger
    // normal browser playback and inspect public show/episode pages.
    if (this.provider === 'dashreels') {
      await this.deepScrapeDashReels(pageItems);
    }

    for (const candidate of this.networkCandidates.values()) {
      this.addItem(
        {
          sourceUrl: candidate.sourceUrl || this.url,
          mediaUrl: candidate.url,
          title: null
        },
        'network',
        candidate.type
      );
    }

    return Array.from(this.items.values()).filter(item => !before.has(item.id));
  }

  async deepScrapeDashReels(pageItems) {
    const candidateUrls = [];
    const seen = new Set();

    const addUrl = value => {
      if (!value) return;
      try {
        const u = new URL(value, this.page.url());
        if (!/dashreels|dashtoon/i.test(u.hostname)) return;
        if (!/(show|reel|episode|drama|watch|video)/i.test(u.pathname)) return;
        const href = u.href;
        if (seen.has(href)) return;
        seen.add(href);
        candidateUrls.push(href);
      } catch {}
    };

    for (const item of pageItems) addUrl(item.sourceUrl);

    const domLinks = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(Boolean)
        .slice(0, 200)
    ).catch(() => []);

    domLinks.forEach(addUrl);

    // Initialize any visible HTML5 video elements without bypassing login,
    // subscription, DRM, CAPTCHA, or other access controls.
    await this.page.locator('video').evaluateAll(videos => {
      for (const video of videos) {
        try {
          video.muted = true;
          const p = video.play();
          if (p?.catch) p.catch(() => {});
        } catch {}
      }
    }).catch(() => {});

    // Some players use a visible play button before the media request starts.
    await this.page.locator('button, [role="button"]').evaluateAll(nodes => {
      for (const node of nodes.slice(0, 30)) {
        const label = (node.getAttribute('aria-label') || node.textContent || '').trim();
        if (/^(play|watch|continue)$/i.test(label)) {
          try { node.click(); } catch {}
        }
      }
    }).catch(() => {});

    await this.page.waitForTimeout(Math.max(1800, this.scrollWait));

    for (const candidate of candidateUrls.slice(0, 6)) {
      if (this.resolvedPages.has(candidate)) continue;
      this.resolvedPages.add(candidate);

      const child = await this.context.newPage();
      const localCandidates = new Map();

      const capture = (url, contentType = '') => {
        const type = mediaType(url, contentType);
        if (!type || type === 'segment') return;
        const normalized = normalizeUrl(url, candidate);
        if (!normalized) return;
        localCandidates.set(normalized, {
          url: normalized,
          type,
          contentType: contentType || null,
          sourceUrl: candidate
        });
      };

      child.on('response', async response => {
        try {
          const contentType = response.headers()['content-type'] || '';
          capture(response.url(), contentType);

          if (/json|javascript|text/i.test(contentType) && /dashreels|dashtoon/i.test(response.url())) {
            const body = await response.text().catch(() => '');
            const urls = body.match(/https?:\/\/[^"'\\\\\\s]+/gi) || [];
            for (const raw of urls) capture(raw.replace(/\\/g, ''));
          }
        } catch {}
      });

      child.on('request', request => {
        try { capture(request.url()); } catch {}
      });

      try {
        await child.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await child.waitForTimeout(Math.max(1500, this.scrollWait));

        await child.locator('video').evaluateAll(videos => {
          for (const video of videos) {
            try {
              video.muted = true;
              const p = video.play();
              if (p?.catch) p.catch(() => {});
            } catch {}
          }
        }).catch(() => {});

        await child.waitForTimeout(2200);

        const direct = await child.locator('video').evaluateAll(videos =>
          videos.map(v => ({
            mediaUrl: v.currentSrc || v.src || null,
            thumbnailUrl: v.poster || null
          })).filter(v => v.mediaUrl)
        ).catch(() => []);

        for (const media of direct) {
          capture(media.mediaUrl);
          this.addItem({
            sourceUrl: candidate,
            mediaUrl: media.mediaUrl,
            thumbnailUrl: media.thumbnailUrl,
            title: null
          }, 'dashreels-dom');
        }

        for (const media of localCandidates.values()) {
          this.networkCandidates.set(media.url, media);
          this.addItem({
            sourceUrl: candidate,
            mediaUrl: media.url,
            title: null
          }, 'dashreels-network', media.type);
        }
      } catch {
        // Keep the feed alive if one public page cannot be opened.
      } finally {
        await child.close().catch(() => {});
      }
    }
  }

  async deepScrapeGoodShort(pageItems) {
    const candidateUrls = [];
    const seen = new Set();

    for (const item of pageItems) {
      const source = normalizeUrl(item.sourceUrl, this.page.url());
      if (!source || seen.has(source)) continue;

      // Public GoodShort drama/episode pages only. We do not bypass
      // authentication, DRM, CAPTCHA, or other access controls.
      if (!/goodshort\.com/i.test(new URL(source).hostname)) continue;
      if (!/(\/drama\/|\/episode\/|\/episodes\/)/i.test(new URL(source).pathname)) continue;

      seen.add(source);
      candidateUrls.push(source);
      if (candidateUrls.length >= 4) break;
    }

    for (const candidate of candidateUrls) {
      if (this.resolvedPages.has(candidate)) continue;
      this.resolvedPages.add(candidate);

      const child = await this.context.newPage();
      const localCandidates = new Map();

      const capture = (url, contentType = '') => {
        const type = mediaType(url, contentType);
        if (!type || type === 'segment') return;

        const normalized = normalizeUrl(url, candidate);
        if (!normalized) return;

        localCandidates.set(normalized, {
          url: normalized,
          type,
          contentType: contentType || null,
          sourceUrl: candidate
        });
      };

      child.on('response', response => {
        try {
          capture(response.url(), response.headers()['content-type'] || '');
        } catch {}
      });

      child.on('request', request => {
        try {
          capture(request.url());
        } catch {}
      });

      try {
        await child.goto(candidate, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        await child.waitForTimeout(Math.max(1200, this.scrollWait));

        // A normal player may only request its manifest after initialization.
        // Calling play() is best-effort and does not bypass access controls.
        await child.locator('video').first().evaluate(video => {
          try {
            video.muted = true;
            const result = video.play();
            if (result?.catch) result.catch(() => {});
          } catch {}
        }).catch(() => {});

        await child.waitForTimeout(1800);

        // If this is a drama/episodes index, collect its public episode links
        // and resolve a small batch of them.
        const links = await child.evaluate(() => {
          const out = [];
          const seen = new Set();

          for (const a of document.querySelectorAll('a[href]')) {
            const href = a.href;
            if (!href || !/goodshort\.com/i.test(new URL(href).hostname)) continue;
            if (!/(\/episode\/|\/episodes\/)/i.test(new URL(href).pathname)) continue;
            if (seen.has(href)) continue;
            seen.add(href);
            out.push(href);
            if (out.length >= 3) break;
          }

          return out;
        }).catch(() => []);

        for (const candidate of localCandidates.values()) {
          this.networkCandidates.set(candidate.url, candidate);
        }

        for (const episodeUrl of links) {
          if (this.resolvedPages.has(episodeUrl)) continue;
          this.resolvedPages.add(episodeUrl);
          await this.resolveGoodShortEpisode(episodeUrl);
        }
      } catch {
        // Individual pages can fail without killing the feed session.
      } finally {
        await child.close().catch(() => {});
      }
    }
  }

  async resolveGoodShortEpisode(episodeUrl) {
    const child = await this.context.newPage();
    const localCandidates = new Map();

    const capture = (url, contentType = '') => {
      const type = mediaType(url, contentType);
      if (!type || type === 'segment') return;

      const normalized = normalizeUrl(url, episodeUrl);
      if (!normalized) return;

      localCandidates.set(normalized, {
        url: normalized,
        type,
        contentType: contentType || null,
        sourceUrl: episodeUrl
      });
    };

    child.on('response', response => {
      try {
        capture(response.url(), response.headers()['content-type'] || '');
      } catch {}
    });

    child.on('request', request => {
      try {
        capture(request.url());
      } catch {}
    });

    try {
      await child.goto(episodeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await child.waitForTimeout(Math.max(1500, this.scrollWait));

      await child.locator('video').first().evaluate(video => {
        try {
          video.muted = true;
          const result = video.play();
          if (result?.catch) result.catch(() => {});
        } catch {}
      }).catch(() => {});

      await child.waitForTimeout(2200);

      // Also inspect the rendered video element in case the player exposes
      // a direct MP4/WebM source rather than HLS/DASH.
      const directMedia = await child.locator('video').evaluateAll(videos =>
        videos.map(v => ({
          mediaUrl: v.currentSrc || v.src || null,
          thumbnailUrl: v.poster || null
        })).filter(v => v.mediaUrl)
      ).catch(() => []);

      for (const media of directMedia) {
        capture(media.mediaUrl);
        this.addItem({
          sourceUrl: episodeUrl,
          mediaUrl: media.mediaUrl,
          thumbnailUrl: media.thumbnailUrl,
          title: null
        }, 'episode-dom');
      }

      for (const candidate of localCandidates.values()) {
        this.networkCandidates.set(candidate.url, candidate);
        this.addItem({
          sourceUrl: episodeUrl,
          mediaUrl: candidate.url,
          title: null
        }, 'episode-network', candidate.type);
      }
    } catch {
      // Keep the main feed alive when an individual episode cannot be opened.
    } finally {
      await child.close().catch(() => {});
    }
  }

  addItem(item, discoveredBy = 'dom', forcedType = null) {
    if (!item) return false;

    const mediaUrl = normalizeUrl(item.mediaUrl, item.sourceUrl || this.url);
    if (!mediaUrl) return false;

    const type = forcedType || mediaType(mediaUrl);
    if (!type || type === 'segment') return false;

    const id = item.providerId || stableId([
      item.sourceUrl || this.url,
      mediaUrl,
      item.title || ''
    ]);

    const existing = this.items.get(id);

    const candidate = {
      id,
      sourceUrl: normalizeUrl(item.sourceUrl || this.url, this.url),
      mediaUrl,
      type,
      title: item.title || null,
      thumbnailUrl: normalizeUrl(item.thumbnailUrl, item.sourceUrl || this.url),
      quality: type === 'hls' || type === 'dash' ? 'auto' : null,
      discoveredBy,
      discoveredAt: existing?.discoveredAt || new Date().toISOString()
    };

    if (!existing) {
      this.items.set(id, candidate);
      this.revision++;

      if (this.items.size > this.maxItems) {
        this.items.delete(this.items.keys().next().value);
      }

      return true;
    }

    const better = pickBetterMedia(existing, candidate);
    existing.mediaUrl = better.mediaUrl;
    existing.type = better.type;
    existing.title ||= candidate.title;
    existing.thumbnailUrl ||= candidate.thumbnailUrl;

    return false;
  }

  async advance() {
    if (!this.page) await this.start();

    await this.page.evaluate(step => {
      window.scrollBy({ top: step, behavior: 'instant' });
    }, this.scrollStep);

    await this.page.waitForTimeout(this.scrollWait);

    const newItems = await this.collect();
    return this.snapshot(50, newItems);
  }

  snapshot(limit = 50, newItems = []) {
    return {
      provider: this.provider,
      items: Array.from(this.items.values()).slice(-limit),
      newItems,
      total: this.items.size,
      revision: this.revision,
      hasMore: true,
      lastActivity: this.lastActivity
    };
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
