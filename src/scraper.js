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
    this.page = null;
    this.items = new Map();
    this.networkCandidates = new Map();
    this.provider = providers.find(p => p.matches(url))?.name || 'generic';
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.revision = 0;
  }

  async start() {
    this.browser = await chromium.launch({ headless: this.headless });
    const context = await this.browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'ShortReelsScraper/0.2 (+public-media-resolver)'
    });
    this.page = await context.newPage();

    this.page.on('response', async response => {
      try {
        const url = response.url();
        const headers = response.headers();
        const type = mediaType(url, headers['content-type'] || '');
        if (!type || type === 'segment') return;
        const normalized = normalizeUrl(url, this.url);
        if (!normalized) return;
        this.networkCandidates.set(normalized, {
          url: normalized,
          type,
          contentType: headers['content-type'] || null
        });
      } catch {}
    });

    this.page.on('request', request => {
      const url = request.url();
      const type = mediaType(url);
      if (type && type !== 'segment') {
        this.networkCandidates.set(url, { url, type, contentType: null });
      }
    });

    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.waitForTimeout(this.scrollWait);
    const newItems = await this.collect();
    return this.snapshot(50, newItems);
  }

  async collect() {
    this.lastActivity = Date.now();
    const before = new Set(this.items.keys());
    const provider = providers.find(p => p.name === this.provider) || genericProvider;
    const pageItems = await provider.extractPage(this.page).catch(() => []);
    for (const item of pageItems) this.addItem(item, 'dom');

    for (const candidate of this.networkCandidates.values()) {
      this.addItem(
        { sourceUrl: this.url, mediaUrl: candidate.url, title: null },
        'network',
        candidate.type
      );
    }

    return Array.from(this.items.values()).filter(item => !before.has(item.id));
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
    this.page = null;
  }
}