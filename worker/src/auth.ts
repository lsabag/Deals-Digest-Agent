import { Env, User } from './types';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
  'profile',
].join(' ');

function getRedirectUri(env: Env): string {
  const base = env.WORKER_URL || 'https://deals-agent.workers.dev';
  return `${base}/auth/callback`;
}

// --- JWT helpers (simple HMAC-SHA256) ---

async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const body = btoa(JSON.stringify(payload))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${header}.${body}.${sigB64}`;
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const sigBuf = Uint8Array.from(
    atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0),
  );

  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBuf, new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );

  if (!valid) return null;

  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Date.now() / 1000) return null;
  return payload;
}

// --- OAuth endpoints ---

export function handleAuthRedirect(env: Env): Response {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(env),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
}

export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return new Response(JSON.stringify({ error: 'Missing code parameter' }), { status: 400 });
  }

  // Exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: getRedirectUri(env),
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return new Response(JSON.stringify({ error: 'Token exchange failed', detail: err }), { status: 400 });
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  // Get user info
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = await userRes.json() as { sub: string; email: string };

  const tokenExpiry = Math.floor(Date.now() / 1000) + tokens.expires_in;

  // Upsert user in D1
  await env.DB.prepare(`
    INSERT INTO users (id, email, access_token, refresh_token, token_expiry)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(id) DO UPDATE SET
      email = ?2,
      access_token = ?3,
      refresh_token = COALESCE(?4, users.refresh_token),
      token_expiry = ?5
  `).bind(
    userInfo.sub,
    userInfo.email,
    tokens.access_token,
    tokens.refresh_token || null,
    tokenExpiry,
  ).run();

  // Create session JWT (7 days)
  const jwt = await signJWT(
    { user_id: userInfo.sub, email: userInfo.email, exp: Math.floor(Date.now() / 1000) + 7 * 86400 },
    env.JWT_SECRET,
  );

  // Redirect to PWA with token
  return new Response(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><title>Redirecting...</title></head>
    <body><script>
      localStorage.setItem('token', '${jwt}');
      window.location.href = '/';
    </script></body></html>
  `, { headers: { 'Content-Type': 'text/html' } });
}

export async function handleAuthMe(user: User): Promise<Response> {
  return Response.json({ id: user.id, email: user.email });
}

// --- Token refresh ---

export async function getValidAccessToken(user: User, env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (user.access_token && user.token_expiry && user.token_expiry > now + 60) {
    return user.access_token;
  }

  // Refresh
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: user.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) throw new Error('Failed to refresh Google token');

  const data = await res.json() as { access_token: string; expires_in: number };
  const newExpiry = now + data.expires_in;

  await env.DB.prepare(
    'UPDATE users SET access_token = ?1, token_expiry = ?2 WHERE id = ?3',
  ).bind(data.access_token, newExpiry, user.id).run();

  user.access_token = data.access_token;
  user.token_expiry = newExpiry;

  return data.access_token;
}

// --- Middleware: extract user from Authorization header ---

export async function authenticateRequest(request: Request, env: Env): Promise<User | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload || !payload.user_id) return null;

  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?1')
    .bind(payload.user_id as string)
    .first<User>();

  return row || null;
}
