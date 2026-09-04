'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sign, verify, parseCookies, serializeCookie } = require('./session');
const { hasRequiredRole, safeResolve, contentType, escapeHtml } = require('./access');

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'xw_session';
const STATE_COOKIE = 'xw_oauth';

// ---- Discord OAuth2 calls (overridable through `deps` for tests) ----

async function defaultExchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  return res.json();
}

async function defaultFetchUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`user lookup failed (${res.status})`);
  return res.json();
}

/**
 * Role-gated website. Visitors log in with Discord; the bot checks whether they hold one of the
 * required roles on the configured server; only then are files from web/protected served.
 *
 * @param {object} p
 * @param {object} p.web            config.web
 * @param {string} p.clientId       Discord application id
 * @param {string} p.sessionSecret  secret used to sign session cookies
 * @param {(userId: string) => Promise<{isMember: boolean, roleIds: string[]}>} p.checkMember
 * @param {() => string[]} [p.roleNames]  human names of the required roles (for the denied page)
 * @param {object} [p.deps]         { exchangeCode, fetchUser } overrides
 * @param {object} [p.log]
 */
function createWebServer({ web, clientId, sessionSecret, checkMember, roleNames = () => [], deps = {}, log = console }) {
  const exchangeCode = deps.exchangeCode || defaultExchangeCode;
  const fetchUser = deps.fetchUser || defaultFetchUser;
  const publicDir = path.join(web.dir, 'public');
  const protectedDir = path.join(web.dir, 'protected');
  const sessionMs = web.sessionHours * 60 * 60 * 1000;
  const recheckMs = web.recheckMinutes * 60 * 1000;

  // ---- helpers ----

  function publicUrl(req) {
    if (web.publicUrl) return web.publicUrl;
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${web.port}`).split(',')[0].trim();
    return `${proto}://${host}`;
  }
  const isSecure = (req) => publicUrl(req).startsWith('https://');
  const redirectUri = (req) => `${publicUrl(req)}/callback`;

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }
  function redirect(res, location, headers = {}) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
    res.end();
  }
  function page(name, vars = {}) {
    let html = fs.readFileSync(path.join(publicDir, name), 'utf8');
    for (const [key, value] of Object.entries(vars)) html = html.split(`{{${key}}}`).join(escapeHtml(value));
    return html;
  }
  const sessionCookie = (req, payload) =>
    serializeCookie(SESSION_COOKIE, sign(payload, sessionSecret), { maxAge: sessionMs / 1000, secure: isSecure(req) });
  const clearSessionCookie = (req) => serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isSecure(req) });
  const clearStateCookie = (req) => serializeCookie(STATE_COOKIE, '', { maxAge: 0, secure: isSecure(req) });

  async function isAllowed(userId) {
    const m = await checkMember(userId);
    return !!(m && m.isMember && hasRequiredRole(m.roleIds, web.roleIds));
  }

  function serveFile(res, file) {
    let stat;
    try {
      stat = fs.statSync(file);
      if (stat.isDirectory()) {
        file = path.join(file, 'index.html');
        stat = fs.statSync(file);
      }
    } catch {
      return send(res, 404, page('denied.html', { REASON: 'Page not found.', ROLES: roleNames().join(', ') || '—' }));
    }
    res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return undefined;
  }

  // ---- routes ----

  function handleLogin(req, res) {
    const state = crypto.randomBytes(16).toString('hex');
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri(req));
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'none');
    redirect(res, url.toString(), {
      'Set-Cookie': serializeCookie(STATE_COOKIE, state, { maxAge: 600, secure: isSecure(req) }),
    });
  }

  async function handleCallback(req, res, url) {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookies = parseCookies(req.headers.cookie);
    const clear = [clearStateCookie(req)];

    if (!code || !state || !cookies[STATE_COOKIE] || cookies[STATE_COOKIE] !== state) {
      return redirect(res, '/denied?r=state', { 'Set-Cookie': clear });
    }
    try {
      const token = await exchangeCode({ clientId, clientSecret: web.clientSecret, code, redirectUri: redirectUri(req) });
      const user = await fetchUser(token.access_token);
      if (!user || !user.id) throw new Error('no user id');
      if (!(await isAllowed(user.id))) {
        log.log(`[35xw] web: ${user.username || user.id} denied (missing role)`);
        return redirect(res, '/denied?r=role', { 'Set-Cookie': [...clear, clearSessionCookie(req)] });
      }
      const now = Date.now();
      const payload = { id: user.id, u: user.username || '', chk: now, exp: now + sessionMs };
      log.log(`[35xw] web: ${user.username || user.id} logged in`);
      return redirect(res, '/', { 'Set-Cookie': [...clear, sessionCookie(req, payload)] });
    } catch (err) {
      log.warn(`[35xw] web: login failed: ${err.message}`);
      return redirect(res, '/denied?r=error', { 'Set-Cookie': clear });
    }
  }

  function handleDenied(req, res, url) {
    const r = url.searchParams.get('r');
    const reason =
      r === 'role'
        ? 'You do not have the required role on the Discord server.'
        : r === 'state'
          ? 'Your login attempt expired. Please try again.'
          : r === 'error'
            ? 'Something went wrong while signing you in. Please try again.'
            : 'Access denied.';
    send(res, r === 'role' ? 403 : 400, page('denied.html', { REASON: reason, ROLES: roleNames().join(', ') || '—' }));
  }

  async function handleProtected(req, res, url) {
    const cookies = parseCookies(req.headers.cookie);
    let session = verify(cookies[SESSION_COOKIE], sessionSecret);
    if (!session || !session.id) {
      return send(res, 200, page('login.html', { ROLES: roleNames().join(', ') || '—' }), {
        'Set-Cookie': clearSessionCookie(req),
      });
    }

    // Re-check the role now and then so someone who lost the role also loses access.
    const headers = {};
    if (Date.now() - (session.chk || 0) > recheckMs) {
      if (!(await isAllowed(session.id))) {
        return redirect(res, '/denied?r=role', { 'Set-Cookie': clearSessionCookie(req) });
      }
      session = { ...session, chk: Date.now() };
      headers['Set-Cookie'] = sessionCookie(req, session);
    }

    const file = safeResolve(protectedDir, url.pathname);
    if (!file) return send(res, 404, 'Not found', headers);
    if (Object.keys(headers).length) {
      // set the refreshed cookie before streaming the file
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    }
    return serveFile(res, file);
  }

  async function handler(req, res) {
    const url = new URL(req.url, publicUrl(req));
    const p = url.pathname;

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (p === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (p === '/login') return handleLogin(req, res);
    if (p === '/callback') return handleCallback(req, res, url);
    if (p === '/logout') return redirect(res, '/', { 'Set-Cookie': clearSessionCookie(req) });
    if (p === '/denied') return handleDenied(req, res, url);
    if (p.startsWith('/public/')) {
      const file = safeResolve(publicDir, p.slice('/public'.length));
      return file ? serveFile(res, file) : send(res, 404, 'Not found');
    }
    return handleProtected(req, res, url);
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      log.error('[35xw] web error:', err);
      try {
        send(res, 500, 'Internal error');
      } catch {
        /* ignore */
      }
    });
  });

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(web.port, web.host, () => resolve({ port: server.address().port }));
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { createWebServer, SESSION_COOKIE, STATE_COOKIE };
