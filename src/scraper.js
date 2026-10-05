import { chromium } from 'playwright';
import { dashReelsProvider } from './providers/dashreels.js';
import { goodShortProvider } from './providers/goodshort.js';
import { genericProvider } from './providers/generic.js';
import { reelShortProvider, flexTvProvider } from './providers/public-short.js';
import { mediaType, normalizeUrl, pickBetterMedia, stableId } from './utils.js';

const providers = [goodShortProvider, dashReelsProvider, reelShortProvider, flexTvProvider, genericProvider];

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

    const newItems = await this.collect(true);
    return this.snapshot(50, newItems);
  }

  async collect(deep = false) {
    this.lastActivity = Date.now();

    const before = new Set(this.items.keys());
    const provider = providers.find(p => p.name === this.provider) || genericProvider;

    const pageItems = await provider.extractPage(this.page).catch(() => []);

    for (const item of pageItems) {
      this.addItem(item, 'dom');
    }

    // Deep page resolution is expensive. Run it on initial load and only as
    // a fallback when normal scrolling did not reveal additional items.
    if (deep && this.provider === 'goodshort') {
      await this.deepScrapeGoodShort(pageItems);
    }

    if (deep && this.provider === 'dashreels') {
      await this.deepScrapeDashReels(pageItems);
    }

    if (deep && (this.provider === 'reelshort' || this.provider === 'flextv')) {
      await this.deepScrapePublicShort(pageItems);
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

  async deepScrapePublicShort(pageItems) {
    const candidateUrls = [];
    const seen = new Set();

    const addUrl = value => {
      if (!value) return;
      try {
        const u = new URL(value, this.page.url());
        const allowed =
          this.provider === 'reelshort'
            ? /(^|\.)reelshort\.com$/i.test(u.hostname)
            : /(^|\.)flextv\.cc$/i.test(u.hostname);

        if (!allowed) return;
        if (!/(movie|episode|episodes|watch|drama|dramas|reel)/i.test(u.pathname)) return;

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
        .slice(0, 300)
    ).catch(() => []);

    domLinks.forEach(addUrl);

    await this.page.locator('video').evaluateAll(videos => {
      for (const video of videos) {
        try {
          video.muted = true;
          const p = video.play();
          if (p?.catch) p.catch(() => {});
        } catch {}
      }
    }).catch(() => {});

    await this.page.waitForTimeout(Math.max(1800, this.scrollWait));

    for (const candidate of candidateUrls.slice(0, 12)) {
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

          if (/json|javascript|text/i.test(contentType)) {
            const body = await response.text().catch(() => '');
            const urls = body.match(/https?:\/\/[^\s"'\\<>]+/gi) || [];
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
          }, 'public-short-dom');
        }

        for (const media of localCandidates.values()) {
          this.networkCandidates.set(media.url, media);
          this.addItem({
            sourceUrl: candidate,
            mediaUrl: media.url,
            title: null
          }, 'public-short-network', media.type);
        }
      } catch {
        // Keep the feed alive when one public page cannot be opened.
      } finally {
        await child.close().catch(() => {});
      }
    }
  }

  async deepScrapeDashReels(pageItems) {
    const queue = [];
    const queued = new Set();

    const addSeries = value => {
      if (!value) return;

      try {
        const u = new URL(value, this.page.url());
        if (!/dashreels|dashtoon/i.test(u.hostname)) return;
        if (!/\/series\//i.test(u.pathname)) return;

        const href = u.href;
        if (queued.has(href) || this.resolvedPages.has(href)) return;

        queued.add(href);
        queue.push(href);
      } catch {}
    };

    for (const item of pageItems) addSeries(item.sourceUrl);

    const collectSeriesLinks = async page => page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(Boolean)
        .filter(href => /dashreels|dashtoon/i.test(new URL(href).hostname))
        .filter(href => /\/series\//i.test(new URL(href).pathname))
    ).catch(() => []);

    for (const href of await collectSeriesLinks(this.page)) addSeries(href);

    // Keep each deep pass bounded so /v1/feed can complete before Render's
    // reverse proxy timeout. More series are picked up by subsequent scrolls.
    const batch = queue
      .filter(url => !this.resolvedPages.has(url))
      .slice(0, 4);

    if (!batch.length) return;

    await Promise.all(batch.map(async seriesUrl => {
      this.resolvedPages.add(seriesUrl);

      const child = await this.context.newPage();
      const seriesCandidates = new Map();

      const capture = (url, contentType = '') => {
        const type = mediaType(url, contentType);
        if (!type || type === 'segment') return;

        const normalized = normalizeUrl(url, child.url() || seriesUrl);
        if (!normalized) return;

        seriesCandidates.set(normalized, {
          url: normalized,
          type,
          contentType: contentType || null,
          sourceUrl: child.url() || seriesUrl
        });
      };

      child.on('response', async response => {
        try {
          const contentType = response.headers()['content-type'] || '';
          capture(response.url(), contentType);

          if (/json|javascript|text/i.test(contentType) &&
              /dashreels|dashtoon/i.test(response.url())) {
            const body = await response.text().catch(() => '');
            const urls = body.match(/https?:\/\/[^\s"'\\<>]+/gi) || [];
            for (const raw of urls) capture(raw.replace(/\\/g, ''));
          }
        } catch {}
      });

      child.on('request', request => {
        try { capture(request.url()); } catch {}
      });

      try {
        await child.goto(seriesUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 25000
        });
        await child.waitForTimeout(900);

        const reelLinks = await child.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(Boolean)
            .filter(href => /dashreels|dashtoon/i.test(new URL(href).hostname))
            .filter(href => /\/(reel|episode|watch|video)\//i.test(new URL(href).pathname))
        ).catch(() => []);

        const reelUrl = [...new Set(reelLinks)][0];
        if (!reelUrl) return;

        await child.goto(reelUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 25000
        });
        await child.waitForTimeout(900);

        const discoveredEpisodes = await child.evaluate(() =>
          Array.from(document.querySelectorAll('button, [role="button"], a'))
            .map(node => (node.textContent || '').trim())
            .filter(text => /^\d{1,3}$/.test(text))
            .map(Number)
            .filter(n => n >= 1 && n <= 3)
        ).catch(() => []);

        const episodes = [...new Set(discoveredEpisodes)].sort((a, b) => a - b);
        const targets = (episodes.length ? episodes : [1]).slice(0, 3);

        for (const episode of targets) {
          const before = new Set(seriesCandidates.keys());

          const clicked = episode === 1
            ? true
            : await child.evaluate(n => {
                const nodes = Array.from(
                  document.querySelectorAll('button, [role="button"], a')
                );
                const node = nodes.find(
                  x => (x.textContent || '').trim() === String(n)
                );

                if (!node) return false;

                try {
                  node.scrollIntoView({ block: 'center' });
                  node.click();
                  return true;
                } catch {
                  return false;
                }
              }, episode).catch(() => false);

          if (!clicked) continue;

          await child.waitForTimeout(1800);

          await child.locator('video').evaluateAll(videos => {
            for (const video of videos) {
              try {
                video.muted = true;
                const p = video.play();
                if (p?.catch) p.catch(() => {});
              } catch {}
            }
          }).catch(() => {});

          await child.waitForTimeout(700);

          const direct = await child.locator('video').evaluateAll(videos =>
            videos.map(v => ({
              mediaUrl: v.currentSrc || v.src || null,
              thumbnailUrl: v.poster || null
            })).filter(v => v.mediaUrl)
          ).catch(() => []);

          for (const media of direct) {
            capture(media.mediaUrl);

            const type = mediaType(media.mediaUrl);
            if (type && type !== 'segment') {
              this.addItem({
                sourceUrl: reelUrl,
                mediaUrl: media.mediaUrl,
                thumbnailUrl: media.thumbnailUrl,
                title: null,
                providerId: reelUrl + '#episode-' + episode
              }, 'dashreels-episode', type);
            }
          }

          const fresh = Array.from(seriesCandidates.values())
            .filter(candidate => !before.has(candidate.url))
            .filter(candidate =>
              ['hls', 'dash', 'mp4', 'webm'].includes(candidate.type)
            );

          for (const candidate of fresh) {
            this.networkCandidates.set(candidate.url, {
              ...candidate,
              sourceUrl: reelUrl
            });

            this.addItem({
              sourceUrl: reelUrl,
              mediaUrl: candidate.url,
              title: null,
              providerId: reelUrl + '#episode-' + episode + '-' + candidate.url
            }, 'dashreels-network', candidate.type);
          }
        }
      } catch {
        // One public series can fail without blocking the other series.
      } finally {
        await child.close().catch(() => {});
      }
    }));
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

    let newItems = [];
    let attemptsWithoutProgress = 0;
    let lastHeight = 0;

    // One request advances the browser through several ordinary scroll steps.
    // This prevents the Android client from receiving an empty page after the
    // first ten items simply because the site needed more than one scroll.
    for (let attempt = 0; attempt < 6; attempt++) {
      const beforeHeight = await this.page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);

      await this.page.evaluate(step => {
        window.scrollBy({ top: step, behavior: 'instant' });
      }, this.scrollStep);

      await this.page.waitForTimeout(this.scrollWait);

      const batch = await this.collect(false);
      if (batch.length) {
        newItems = newItems.concat(batch);
        attemptsWithoutProgress = 0;
      } else {
        attemptsWithoutProgress++;
      }

      const afterHeight = await this.page.evaluate(() => document.documentElement.scrollHeight).catch(() => beforeHeight);
      lastHeight = afterHeight;

      if (newItems.length >= 10) break;
      if (attemptsWithoutProgress >= 3 && afterHeight <= beforeHeight) break;
    }

    // The SPA can reveal more show/episode links after scrolling. Run one
    // bounded deep pass whenever this advance did not collect a full batch;
    // already-resolved pages are skipped, so this only resolves newly seen
    // public links.
    if (newItems.length < 10) {
      const deepBatch = await this.collect(true);
      newItems = newItems.concat(deepBatch);
    }

    const hasMore = newItems.length > 0 || attemptsWithoutProgress < 3;
    return this.snapshot(50, newItems, hasMore);
  }

  async listEpisodes(sourceUrl) {
    if (!this.page) await this.start();

    const target = normalizeUrl(sourceUrl, this.url) || this.url;
    const child = await this.context.newPage();

    try {
      await child.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
      await child.waitForTimeout(Math.max(1000, this.scrollWait));

      const numbers = await child.evaluate(() => {
        const set = new Set();

        const add = value => {
          const n = Number(String(value || '').trim());
          if (Number.isInteger(n) && n >= 1 && n <= 500) set.add(n);
        };

        document.querySelectorAll('button, [role="button"], a').forEach(node => {
          const text = (node.textContent || '').trim();
          if (/^\d{1,3}$/.test(text)) add(text);
        });

        const body = document.body?.innerText || '';
        const range = body.match(/Episodes?\s+(\d+)\s*[–-]\s*(\d+)/i);
        if (range) {
          const first = Number(range[1]);
          const last = Number(range[2]);
          for (let n = first; n <= Math.min(last, 500); n++) set.add(n);
        }

        return Array.from(set).sort((a, b) => a - b);
      }).catch(() => []);

      return numbers;
    } finally {
      await child.close().catch(() => {});
    }
  }

  async switchEpisode(sourceUrl, episode) {
    if (!this.page) await this.start();

    if (!Number.isInteger(episode) || episode < 1 || episode > 500) {
      throw new Error('invalid episode');
    }

    const target = normalizeUrl(sourceUrl, this.url) || this.url;
    const child = await this.context.newPage();
    const localCandidates = new Map();

    const capture = (url, contentType = '') => {
      const type = mediaType(url, contentType);
      if (!type || type === 'segment') return;

      const normalized = normalizeUrl(url, target);
      if (!normalized) return;

      localCandidates.set(normalized, {
        url: normalized,
        type,
        contentType: contentType || null,
        sourceUrl: target
      });
    };

    child.on('response', async response => {
      try {
        const contentType = response.headers()['content-type'] || '';
        capture(response.url(), contentType);

        if (/json|javascript|text/i.test(contentType) &&
            /dashreels|dashtoon|goodshort/i.test(response.url())) {
          const body = await response.text().catch(() => '');
          if (body) {
            const urls = body.match(/https?:\/\/[^\s"'\\<>]+/gi) || [];
            for (const raw of urls) capture(raw.replace(/\\/g, ''));
          }
        }
      } catch {}
    });

    child.on('request', request => {
      try {
        capture(request.url());
      } catch {}
    });

    try {
      await child.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
      await child.waitForTimeout(Math.max(1200, this.scrollWait));

      const clicked = await child.evaluate(n => {
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const targetNode = nodes.find(node => {
          const text = (node.textContent || '').trim();
          return text === String(n);
        });
        if (!targetNode) return false;

        try {
          targetNode.scrollIntoView({ block: 'center' });
          targetNode.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          targetNode.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          targetNode.click();
          return true;
        } catch {
          return false;
        }
      }, episode);

      if (!clicked) throw new Error('episode button not found');

      await child.waitForTimeout(Math.max(2600, this.scrollWait + 1200));

      await child.locator('video').evaluateAll(videos => {
        for (const video of videos) {
          try {
            video.muted = true;
            const p = video.play();
            if (p?.catch) p.catch(() => {});
          } catch {}
        }
      }).catch(() => {});

      await child.waitForTimeout(1200);

      const direct = await child.locator('video').evaluateAll(videos =>
        videos.map(v => ({
          mediaUrl: v.currentSrc || v.src || null,
          thumbnailUrl: v.poster || null
        })).filter(v => v.mediaUrl)
      ).catch(() => []);

      for (const media of direct) {
        capture(media.mediaUrl);
      }

      const playable = Array.from(localCandidates.values())
        .filter(x => ['hls', 'dash', 'mp4', 'webm'].includes(x.type));

      const best = playable[playable.length - 1] || direct.find(x => x.mediaUrl);
      if (!best) {
        throw new Error('episode is not currently playable through the normal public web player');
      }

      const mediaUrl = best.url || best.mediaUrl;
      const type = best.type || mediaType(mediaUrl);

      const title = await child.locator('h1').first().textContent().catch(() => null);

      const item = {
        id: stableId([target, String(episode), mediaUrl]),
        sourceUrl: target,
        mediaUrl,
        type,
        title: title?.trim() || null,
        episode,
        thumbnailUrl: best.thumbnailUrl ? normalizeUrl(best.thumbnailUrl, target) : null,
        quality: type === 'hls' || type === 'dash' ? 'auto' : null
      };

      // Keep the selected episode in the session cache as well, without
      // disturbing the main feed page used for infinite scrolling.
      this.addItem(item, 'episode-switch', type);

      return item;
    } finally {
      await child.close().catch(() => {});
    }
  }

  snapshot(limit = 50, newItems = [], hasMore = true) {
    return {
      provider: this.provider,
      items: Array.from(this.items.values()).slice(-limit),
      newItems,
      total: this.items.size,
      revision: this.revision,
      hasMore,
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
