import { Env, User } from './types';
import { handleAuthRedirect, handleAuthCallback, handleAuthMe, authenticateRequest } from './auth';
import { generateDigest, runDigestForAllUsers } from './digest';
import { handleFeedback, handlePreferences, handleMute } from './feedback';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for PWA
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // --- Auth routes (no auth required) ---
      if (path === '/auth/google') {
        return handleAuthRedirect(env);
      }
      if (path === '/auth/callback') {
        return handleAuthCallback(request, env);
      }

      // --- Protected routes ---
      const user = await authenticateRequest(request, env);
      if (!user) {
        return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
      }

      // GET /auth/me
      if (path === '/auth/me' && request.method === 'GET') {
        return withCors(await handleAuthMe(user));
      }

      // GET /digest
      if (path === '/digest' && request.method === 'GET') {
        return withCors(await handleDigest(user, env));
      }

      // POST /feedback
      if (path === '/feedback' && request.method === 'POST') {
        return withCors(await handleFeedback(request, user, env));
      }

      // GET /preferences
      if (path === '/preferences' && request.method === 'GET') {
        return withCors(await handlePreferences(user, env));
      }

      // POST /mute
      if (path === '/mute' && request.method === 'POST') {
        return withCors(await handleMute(request, user, env));
      }

      return withCors(Response.json({ error: 'Not found' }, { status: 404 }));
    } catch (err) {
      console.error('Worker error:', err);
      const message = err instanceof Error ? err.message : 'Internal error';
      return withCors(Response.json({ error: message }, { status: 500 }));
    }
  },

  // Cron trigger
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runDigestForAllUsers(env);
  },
};

async function handleDigest(user: User, env: Env): Promise<Response> {
  const cards = await generateDigest(user, env);
  return Response.json({ cards, count: cards.length });
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
