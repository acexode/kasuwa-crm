#!/usr/bin/env node
/**
 * DEMO ONLY: a localhost front door that gives the browser a session.
 *
 * Why it exists. The web app signs a user in for real (P01/1, P01/2: password,
 * then a TOTP code), and the API answers the second factor with a session
 * token. But the web app does not yet keep that token anywhere: there is no
 * session cookie and no BFF, so every CRM screen's same-origin `/api/v1` call
 * goes out with no identity and the API answers 401. The e2e harness gets
 * round this by adding the stub identity headers in Playwright
 * (`extraHTTPHeaders`). A presenter in a real browser cannot.
 *
 * So this proxy sits in front of `next dev` (http://localhost:3100 -> :3000)
 * and does, for the demo only, what the missing session layer will do:
 *
 *   - Real sign-in. When `POST /api/v1/auth/mfa` answers 200, it keeps the
 *     `accessToken` in an HttpOnly cookie and from then on sends it as
 *     `Authorization: Bearer` on every `/api/v1` call. The API resolves the
 *     session from the database exactly as it would in production.
 *   - Quick switch. `/__demo` lists the seeded users; `/__demo/as/<role>`
 *     sends the stub identity headers (ADR-0007) instead, so the presenter can
 *     change user without typing a TOTP code. This only works while the API
 *     runs with KASUWA_AUTH_MODE=stub, which @kasuwa/config refuses under
 *     NODE_ENV=production.
 *
 * Neither path grants scope. Both only say WHO the caller is; the API still
 * reads `user_programme` on every request (CLAUDE.md rule 2). Scope headers
 * from the browser are passed through untouched, so the API still rejects them.
 *
 * It refuses to listen anywhere but loopback, and refuses an upstream that is
 * not loopback. No dependencies: node:http only.
 *
 *   node tools/demo-proxy.mjs            # :3100 -> http://127.0.0.1:3000
 *   DEMO_PORT=3200 DEMO_UPSTREAM=http://127.0.0.1:3000 node tools/demo-proxy.mjs
 */
import { request as httpRequest, createServer } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const port = Number(process.env.DEMO_PORT ?? '3100');
const upstream = new URL(process.env.DEMO_UPSTREAM ?? 'http://127.0.0.1:3000');

if (!LOOPBACK.has(upstream.hostname) || upstream.protocol !== 'http:') {
  console.error('demo-proxy: refusing a non-loopback upstream. This is a local demo tool.');
  process.exit(1);
}

/**
 * The seeded identities (packages/db/src/fixtures.ts). Ids only: these are
 * fixture uuids, not credentials, and the stub path needs nothing else.
 */
const TENANT_A = '11111111-0000-4000-8000-000000000001';
const TENANT_B = '22222222-0000-4000-8000-000000000002';
const DEMO_IDENTITIES = {
  admin: {
    label: 'Musa Bello: tenant admin and supervisor, Sahel BPO, both programmes',
    tenantId: TENANT_A,
    userId: '11111111-0000-4000-8000-0000000d0003',
  },
  agent: {
    label: 'Tunde Adeyemi: agent, Sahel BPO, Bank X Collections only',
    tenantId: TENANT_A,
    userId: '11111111-0000-4000-8000-0000000d0001',
  },
  agent2: {
    label: 'Ngozi Okeke: agent, Sahel BPO, Telco Y Care only',
    tenantId: TENANT_A,
    userId: '11111111-0000-4000-8000-0000000d0002',
  },
  unassigned: {
    label: 'Emeka Nwosu: Sahel BPO user in no programme (sees nothing)',
    tenantId: TENANT_A,
    userId: '11111111-0000-4000-8000-0000000d0004',
  },
  tenantb: {
    label: 'Wanjiru Kamau: tenant admin, Rift Valley Contact (another tenant)',
    tenantId: TENANT_B,
    userId: '22222222-0000-4000-8000-0000000d0005',
  },
};

const TOKEN_COOKIE = 'kasuwa_demo_token';
const AS_COOKIE = 'kasuwa_demo_as';
const LANDING = '/contacts';

function parseCookies(header) {
  const jar = new Map();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      jar.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
    }
  }
  return jar;
}

/** The Cookie header with the demo's own cookies removed: they stay here. */
function forwardedCookieHeader(jar) {
  const kept = [...jar].filter(([name]) => name !== TOKEN_COOKIE && name !== AS_COOKIE);
  return kept.length === 0
    ? undefined
    : kept.map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('; ');
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, 'set-cookie': cookies, 'cache-control': 'no-store' });
  res.end();
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function switcherPage(current) {
  const rows = Object.entries(DEMO_IDENTITIES)
    .map(
      ([role, identity]) =>
        `<li><a href="/__demo/as/${role}">${escapeHtml(role)}</a> ${escapeHtml(identity.label)}${
          role === current ? ' <strong>(current)</strong>' : ''
        }</li>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kasuwa demo switcher</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 16px}li{margin:.4rem 0}</style></head>
<body><h1>Kasuwa demo: who am I?</h1>
<p>Local demo tool (tools/demo-proxy.mjs). Pick a seeded user to act as, or <a href="/">sign in for real</a>.
Neither choice grants scope: the API reads programme membership from the database on every request.</p>
<ul>${rows}</ul>
<p><a href="/__demo/signout">Sign out</a> (clears the demo session).</p></body></html>`;
}

function handleDemoRoute(req, res, url, jar) {
  if (url.pathname === '/__demo' || url.pathname === '/__demo/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(switcherPage(jar.get(AS_COOKIE)));
    return;
  }
  if (url.pathname === '/__demo/signout') {
    redirect(res, '/', [cookie(TOKEN_COOKIE, '', 0), cookie(AS_COOKIE, '', 0)]);
    return;
  }
  const match = /^\/__demo\/as\/([a-z0-9]+)$/.exec(url.pathname);
  if (match !== null && Object.hasOwn(DEMO_IDENTITIES, match[1])) {
    const next = url.searchParams.get('next');
    const target = next !== null && next.startsWith('/') && !next.startsWith('//') ? next : LANDING;
    redirect(res, target, [cookie(TOKEN_COOKIE, '', 0), cookie(AS_COOKIE, match[1], 60 * 60 * 12)]);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('unknown demo route');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://demo.local');
  const jar = parseCookies(req.headers.cookie);

  if (url.pathname.startsWith('/__demo')) {
    handleDemoRoute(req, res, url, jar);
    return;
  }

  const token = jar.get(TOKEN_COOKIE);
  const role = jar.get(AS_COOKIE);
  const signedIn =
    token !== undefined || (role !== undefined && Object.hasOwn(DEMO_IDENTITIES, role));

  // There is no home screen yet (P03 is unbuilt), and P01/2 lands on `/` after
  // the second factor, which is the sign-in form. A signed-in demo user goes
  // to the contacts list instead.
  if (url.pathname === '/' && signedIn && req.method === 'GET') {
    redirect(res, LANDING);
    return;
  }

  const headers = { ...req.headers, host: upstream.host };
  delete headers.cookie;
  const forwardedCookies = forwardedCookieHeader(jar);
  if (forwardedCookies !== undefined) {
    headers.cookie = forwardedCookies;
  }
  delete headers.authorization;
  delete headers['x-kasuwa-tenant-id'];
  delete headers['x-kasuwa-user-id'];

  const isApi = url.pathname.startsWith('/api/v1/');
  if (
    isApi &&
    !url.pathname.startsWith('/api/v1/auth/sign-in') &&
    !url.pathname.startsWith('/api/v1/auth/mfa')
  ) {
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    } else if (role !== undefined && Object.hasOwn(DEMO_IDENTITIES, role)) {
      headers['x-kasuwa-tenant-id'] = DEMO_IDENTITIES[role].tenantId;
      headers['x-kasuwa-user-id'] = DEMO_IDENTITIES[role].userId;
    }
  }

  const captureSession = isApi && req.method === 'POST' && url.pathname === '/api/v1/auth/mfa';
  const isSignOut = isApi && req.method === 'POST' && url.pathname === '/api/v1/auth/sign-out';

  const outgoing = httpRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      if (!captureSession || upstreamRes.statusCode !== 200) {
        if (isSignOut) {
          responseHeaders['set-cookie'] = [cookie(TOKEN_COOKIE, '', 0), cookie(AS_COOKIE, '', 0)];
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
        return;
      }
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const body = Buffer.concat(chunks);
        const cookies = [];
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          if (typeof parsed.accessToken === 'string') {
            cookies.push(
              cookie(TOKEN_COOKIE, parsed.accessToken, 60 * 60 * 12),
              cookie(AS_COOKIE, '', 0),
            );
          }
        } catch {
          // Not JSON: pass it through untouched.
        }
        delete responseHeaders['content-length'];
        delete responseHeaders['transfer-encoding'];
        if (cookies.length > 0) {
          responseHeaders['set-cookie'] = cookies;
        }
        res.writeHead(200, { ...responseHeaders, 'content-length': body.length });
        res.end(body);
      });
    },
  );
  outgoing.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end(
      'demo-proxy: the web app is not answering on the upstream port. Is `pnpm dev` running?',
    );
  });
  req.pipe(outgoing);
});

// Next's dev server keeps a websocket open for hot reload; pass upgrades through.
server.on('upgrade', (req, socket, head) => {
  const outgoing = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: upstream.host },
  });
  outgoing.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 101 Switching Protocols`];
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  outgoing.on('error', () => socket.destroy());
  outgoing.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`demo-proxy: http://localhost:${port}  (-> ${upstream.origin})`);
  console.log(`demo-proxy: switch user at http://localhost:${port}/__demo`);
});
