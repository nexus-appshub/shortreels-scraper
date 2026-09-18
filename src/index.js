import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ReelSession } from './scraper.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const sessions = new Map();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const HEADLESS = String(process.env.HEADLESS || 'true') !== 'false';
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 4);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 900000);
const SCROLL_STEP_PX = Number(process.env.SCROLL_STEP_PX || 1100);
const SCROLL_WAIT_MS = Number(process.env.SCROLL_WAIT_MS || 900);
const MAX_REELS_PER_SESSION = Number(process.env.MAX_REELS_PER_SESSION || 500);

const DEMO_SOURCES = [
  { name: 'GoodShort', url: 'https://www.goodshort.com/', feedUrl: '/v1/feed?url=https%3A%2F%2Fwww.goodshort.com%2F&limit=10' },
  { name: 'DashReels', url: 'https://dashreels.com/', feedUrl: '/v1/feed?url=https%3A%2F%2Fdashreels.com%2F&limit=10' }
];

app.get('/', async () => ({
  ok: true,
  service: 'shortreels-scraper',
  status: 'online',
  endpoints: { health: '/health', feed: '/v1/feed?url=SOURCE_URL&limit=10', demoSources: '/demo-sources' },
  note: 'Use /demo-sources for verified public source URLs.'
}));

app.get('/demo-sources', async (req) => {
  const base = `${req.protocol}://${req.hostname}`;
  return { success: true, sources: DEMO_SOURCES.map(source => ({ ...source, testUrl: `${base}${source.feedUrl}` })) };
});

app.get('/health', async () => ({ ok: true, service: 'shortreels-scraper', sessions: sessions.size }));

app.get('/v1/feed', async (req, reply) => {
  const { url, sessionId, limit = 10 } = req.query;
  let session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    if (!url) return reply.code(400).send({ success: false, error: 'url is required for a new session' });
    if (sessions.size >= MAX_SESSIONS) return reply.code(429).send({ success: false, error: 'session capacity reached' });
    session = new ReelSession({ url, headless: HEADLESS, scrollStep: SCROLL_STEP_PX, scrollWait: SCROLL_WAIT_MS, maxItems: MAX_REELS_PER_SESSION });
    const id = crypto.randomUUID();
    sessions.set(id, session);
    try {
      const first = await session.start();
      const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
      return { success: true, sessionId: id, ...first, items: first.items.slice(-safeLimit) };
    } catch (error) {
      sessions.delete(id);
      await session.close();
      return reply.code(502).send({ success: false, error: 'failed to open source page', detail: error.message });
    }
  }
  try {
    const next = await session.advance();
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
    return { success: true, sessionId, ...next, items: next.items.slice(-safeLimit) };
  } catch (error) {
    return reply.code(502).send({ success: false, sessionId, error: 'feed advance failed', detail: error.message });
  }
});

app.delete('/v1/feed/:sessionId', async (req) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return { success: true, closed: false };
  sessions.delete(req.params.sessionId);
  await session.close();
  return { success: true, closed: true };
});

setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
      await session.close();
    }
  }
}, 60000).unref();

await app.listen({ port: PORT, host: HOST });
