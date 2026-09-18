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
      return { success: true, sessionId: id, ...first, items: first.items.slice(-Number(limit)) };
    } catch (error) {
      sessions.delete(id);
      await session.close();
      return reply.code(502).send({ success: false, error: 'failed to open source page', detail: error.message });
    }
  }
  try {
    const next = await session.advance();
    return { success: true, sessionId, ...next, items: next.items.slice(-Number(limit)) };
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