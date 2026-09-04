'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sign, verify, parseCookies, serializeCookie } = require('../src/web/session');
const { hasRequiredRole, safeResolve, contentType, escapeHtml } = require('../src/web/access');

const SECRET = 'test-secret';

test('session: sign/verify round-trips and rejects tampering, wrong secret and expiry', () => {
  const payload = { id: '42', u: 'matija', chk: 1000, exp: 5000 };
  const token = sign(payload, SECRET);
  assert.deepEqual(verify(token, SECRET, 1000), payload);

  // expired
  assert.equal(verify(token, SECRET, 5000), null);
  // wrong secret
  assert.equal(verify(token, 'other', 1000), null);
  // tampered body (same signature)
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...payload, id: '1' })).toString('base64url') + '.' + mac;
  assert.equal(verify(forged, SECRET, 1000), null);
  // garbage
  assert.equal(verify('nonsense', SECRET), null);
  assert.equal(verify(body, SECRET), null);
  assert.equal(verify(undefined, SECRET), null);
});

test('cookies: parse and serialize', () => {
  assert.deepEqual(parseCookies('a=1; xw_session=abc%2Edef; b = 2'), { a: '1', xw_session: 'abc.def', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
  const c = serializeCookie('xw_session', 'v.1', { maxAge: 60, secure: true });
  assert.equal(c, 'xw_session=v.1; Path=/; SameSite=Lax; Max-Age=60; HttpOnly; Secure');
  assert.equal(serializeCookie('x', '', { maxAge: 0 }), 'x=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly');
});

test('hasRequiredRole: any required role is enough; none configured means nobody', () => {
  assert.equal(hasRequiredRole(['a', 'b'], ['b']), true);
  assert.equal(hasRequiredRole(['a', 'b'], ['c', 'b']), true);
  assert.equal(hasRequiredRole(['a'], ['b']), false);
  assert.equal(hasRequiredRole(['a'], []), false);
  assert.equal(hasRequiredRole(undefined, ['a']), false);
});

test('safeResolve: serves inside the root, defaults to index.html, blocks escapes', () => {
  const root = path.resolve('/srv/site');
  assert.equal(safeResolve(root, '/'), path.join(root, 'index.html'));
  assert.equal(safeResolve(root, '/docs/'), path.join(root, 'docs', 'index.html'));
  assert.equal(safeResolve(root, '/css/app.css?x=1'), path.join(root, 'css', 'app.css'));
  assert.equal(safeResolve(root, '/../../etc/passwd'), path.join(root, 'etc', 'passwd')); // normalized, stays inside
  assert.equal(safeResolve(root, '/%2e%2e/%2e%2e/etc/passwd'), path.join(root, 'etc', 'passwd'));
  assert.equal(safeResolve(root, '/a/../../../b'), path.join(root, 'b'));
  assert.equal(safeResolve(root, '/%00'), null);
  assert.equal(safeResolve(root, '/%zz'), null); // bad encoding
});

test('contentType and escapeHtml', () => {
  assert.equal(contentType('/x/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('a.PNG'), 'image/png');
  assert.equal(contentType('blob.bin'), 'application/octet-stream');
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
});
