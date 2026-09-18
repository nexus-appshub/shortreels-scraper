import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ReelSession } from './scraper.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const sessions = new Map();
const sourceSessions = new Map();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const HEADLESS = String(process.env.HEADLESS || 'true') !== 'false';
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 2);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 900000);
const SCROLL_STEP_PX = Number(process.env.SCROLL_STEP_PX || 1100);
const SCROLL_WAIT_MS = Number(process.env.SCROLL_WAIT_MS || 900);
const MAX_REELS_PER_SESSION = Number(process.env.MAX_REELS_PER_SESSION || 500);

const DEMO_SOURCES = [
  {
    name: 'GoodShort',
    url: 'https://www.goodshort.com/dramas/playlets?openCategory=1',
    feedUrl: '/v1/feed?url=https%3A%2F%2Fwww.goodshort.com%2Fdramas%2Fplaylets%3FopenCategory%3D1&limit=10'
  },
  {
    name: 'DashReels',
    url: 'https://dashreels.com/',
    feedUrl: '/v1/feed?url=https%3A%2F%2Fdashreels.com%2F&limit=10'
  }
];

const safeLimit = value => Math.min(50, Math.max(1, Number(value) || 10));

const sourceKey = value => {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
};

async function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return false;

  sessions.delete(id);

  for (const [key, value] of sourceSessions) {
    if (value === id) sourceSessions.delete(key);
  }

  await session.close();
  return true;
}

app.get('/', async () => ({
  ok: true,
  service: 'shortreels-scraper',
  status: 'online',
  endpoints: {
    health: '/health',
    feed: '/v1/feed?url=SOURCE_URL&limit=10',
    demoSources: '/demo-sources',
    resetSessions: 'POST /v1/reset-sessions'
  },
  note: 'Use /demo-sources for verified public source URLs.'
}));

app.get('/demo-sources', async (req) => {
  const base = `${req.protocol}://${req.hostname}`;

  return {
    success: true,
    sources: DEMO_SOURCES.map(source => ({
      ...source,
      testUrl: `${base}${source.feedUrl}`
    }))
  };
});

app.get('/health', async () => ({
  ok: true,
  service: 'shortreels-scraper',
  sessions: sessions.size
}));

app.post('/v1/reset-sessions', async () => {
  const ids = [...sessions.keys()];
  for (const id of ids) await destroySession(id);

  return {
    success: true,
    closed: ids.length
  };
});

app.get('/v1/feed', async (req, reply) => {
  const { url, sessionId, limit = 10, newSession } = req.query;
  const safe = safeLimit(limit);

  // Explicit sessionId always wins: this is the continuous-scroll path.
  let session = sessionId ? sessions.get(sessionId) : null;

  if (session) {
    try {
      const next = await session.advance();

      return {
        success: true,
        sessionId,
        ...next,
        items: next.items.slice(-safe)
      };
    } catch (error) {
      await destroySession(sessionId);

      return reply.code(502).send({
        success: false,
        sessionId,
        error: 'feed advance failed',
        detail: error.message
      });
    }
  }

  if (!url) {
    return reply.code(400).send({
      success: false,
      error: 'url is required for a new session'
    });
  }

  const key = sourceKey(url);

  if (!key) {
    return reply.code(400).send({
      success: false,
      error: 'invalid source url'
    });
  }

  // Prevent refreshes/duplicate initial requests from creating multiple
  // Chromium sessions for the same source.
  if (newSession !== 'true') {
    const existingId = sourceSessions.get(key);
    const existing = existingId ? sessions.get(existingId) : null;

    if (existing) {
      existing.lastActivity = Date.now();

      return {
        success: true,
        sessionId: existingId,
        ...existing.snapshot(safe),
        reused: true
      };
    }
  }

  if (sessions.size >= MAX_SESSIONS) {
    return reply.code(429).send({
      success: false,
      error: 'session capacity reached',
      hint: 'POST /v1/reset-sessions or reuse the returned sessionId'
    });
  }

  session = new ReelSession({
    url: key,
    headless: HEADLESS,
    scrollStep: SCROLL_STEP_PX,
    scrollWait: SCROLL_WAIT_MS,
    maxItems: MAX_REELS_PER_SESSION
  });

  const id = crypto.randomUUID();

  sessions.set(id, session);
  sourceSessions.set(key, id);

  try {
    const first = await session.start();

    return {
      success: true,
      sessionId: id,
      ...first,
      items: first.items.slice(-safe)
    };
  } catch (error) {
    await destroySession(id);

    return reply.code(502).send({
      success: false,
      error: 'failed to open source page',
      detail: error.message
    });
  }
});

app.delete('/v1/feed/:sessionId', async (req) => {
  const closed = await destroySession(req.params.sessionId);

  return {
    success: true,
    closed
  };
});

setInterval(async () => {
  const now = Date.now();

  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      await destroySession(id);
    }
  }
}, 60000).unref();

await app.listen({
  port: PORT,
  host: HOST
});
