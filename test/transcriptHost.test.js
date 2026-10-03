'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TranscriptHost, newToken, signRequest, safeName, TOKEN_RE } = require('../src/services/transcriptHost');
const { inlineMedia, collectUrls, allowed, previewUrl } = require('../src/services/transcriptMedia');
const { emojiUrl } = require('../src/services/transcriptHtml');
const { createWebServer } = require('../src/web/server');
const { tmpDir, rm } = require('./helpers');

test('the request signature matches the example in the AWS documentation', () => {
  const r = signRequest({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    uri: '/test.txt',
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(r.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8/);
});

test('tokens are 32 letters and digits and never repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const t = newToken();
    assert.match(t, TOKEN_RE);
    seen.add(t);
  }
  assert.equal(seen.size, 500);
});

/** A tiny stand-in for the bucket: records every request and answers like S3. */
function bucket(status = 200, body = '') {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status, { 'Content-Type': 'application/xml' });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, endpoint: `http://127.0.0.1:${server.address().port}` })));
}

const S3 = (endpoint) => ({ s3: { endpoint, bucket: 'transcripts', accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'auto', publicUrl: 'https://pub-abc.r2.dev/' } });

test('R2 / S3: the page is uploaded signed, under t/<token>/index.html, and the public address is returned', async () => {
  const b = await bucket();
  try {
    const host = new TranscriptHost(S3(b.endpoint));
    assert.equal(host.enabled(), true);
    assert.match(host.describe(), /bucket transcripts \(https:\/\/pub-abc\.r2\.dev\/\)/);
    const html = '<!doctype html><p>héllo</p>';
    const out = await host.publish(html);

    assert.match(out.token, TOKEN_RE);
    assert.equal(out.url, `https://pub-abc.r2.dev/t/${out.token}/index.html`);
    assert.equal(b.requests.length, 1);
    const r = b.requests[0];
    assert.equal(r.method, 'PUT');
    assert.equal(r.url, `/transcripts/t/${out.token}/index.html`);
    assert.equal(r.body.toString('utf8'), html);
    assert.equal(r.headers['x-amz-content-sha256'], crypto.createHash('sha256').update(r.body).digest('hex'));
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(r.headers['cache-control'], /immutable/);
    assert.match(r.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(r.headers).includes('SECRET'), 'the secret never leaves the bot');

    const second = await host.publish(html);
    assert.notEqual(second.url, out.url, 'every ticket gets its own address');
  } finally {
    b.server.close();
  }
});

test('R2 / S3: a refusal is reported with its code', async () => {
  const b = await bucket(403, '<Error><Code>AccessDenied</Code></Error>');
  try {
    await assert.rejects(new TranscriptHost(S3(b.endpoint)).publish('x'), /upload failed \(HTTP 403 AccessDenied\)/);
  } finally {
    b.server.close();
  }
});

test('an incomplete bucket setting is ignored, and with nothing configured there is no link', async () => {
  const half = new TranscriptHost({ s3: { endpoint: 'https://x', bucket: 'b' } });
  assert.equal(half.enabled(), false);
  assert.equal(await half.publish('x'), null);
  assert.match(half.describe(), /^off/);
});

test('own website: the page is written to disk and served at /t/<token>/index.html, and nowhere else', async () => {
  const dir = tmpDir();
  try {
    const host = new TranscriptHost({ local: { dir, publicUrl: 'https://35xw.top/' } });
    assert.match(host.describe(), /own website/);
    const html = '<!doctype html><title>t</title>';
    const { token, url } = await host.publish(html);
    assert.equal(url, `https://35xw.top/t/${token}/index.html`);
    assert.equal(fs.readFileSync(path.join(dir, token, 'index.html'), 'utf8'), html);

    const site = createWebServer({
      web: { dir: path.join(dir, 'site'), sessionHours: 1, recheckMinutes: 1, port: 0, host: '127.0.0.1', publicUrl: 'https://35xw.top', roleIds: ['R'], clientSecret: 'x' },
      clientId: '1',
      sessionSecret: 's',
      checkMember: async () => ({ isMember: false, roleIds: [] }),
      transcriptsDir: dir,
      log: { log() {}, warn() {}, error() {} },
    });
    const { port } = await site.start();
    try {
      const get = (p, method = 'GET') => fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: 'manual' });
      for (const p of [`/t/${token}/index.html`, `/t/${token}/`, `/t/${token}`]) {
        const res = await get(p);
        assert.equal(res.status, 200, p);
        assert.equal(await res.text(), html);
        assert.match(res.headers.get('content-type'), /text\/html/);
        assert.match(res.headers.get('x-robots-tag'), /noindex/);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      }
      // no login needed, but a wrong or malformed address is a plain 404
      for (const p of ['/t/' + 'a'.repeat(32) + '/index.html', '/t/short/index.html', `/t/${token}/other.html`, `/t/${token}/../x`, '/t/', '/t/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
        assert.equal((await get(p)).status, 404, p);
      }
      assert.equal((await get(`/t/${token}/index.html`, 'POST')).status, 405);
    } finally {
      await site.stop();
    }
  } finally {
    rm(dir);
  }
});

// ---------- pictures ----------

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const reply = (body, type = 'image/png', status = 200, extra = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (h) => ({ 'content-type': type, ...extra }[h.toLowerCase()] ?? null) },
  body: (async function* () {
    yield body;
  })(),
});

test('pictures: only Discord hosts are contacted, and what comes back must really be an image', async () => {
  assert.equal(allowed('https://cdn.discordapp.com/a.png'), true);
  assert.equal(allowed('https://media.discordapp.net/a.png'), true);
  assert.equal(allowed('https://images-ext-1.discordapp.net/x'), true);
  assert.equal(allowed('http://cdn.discordapp.com/a.png'), false);
  assert.equal(allowed('https://evil.example/a.png'), false);
  assert.equal(allowed('https://cdn.discordapp.com.evil.example/a.png'), false);
  assert.equal(allowed('https://127.0.0.1/a.png'), false);

  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.endsWith('/page.png')) return reply(Buffer.from('<html>'), 'text/html');
    return reply(png);
  };
  const messages = [
    { author: { avatar: 'https://cdn.discordapp.com/avatars/1/a.png' }, attachments: [{ name: 'ok.png', url: 'https://cdn.discordapp.com/attachments/1/ok.png', contentType: 'image/png' }, { name: 'x.png', url: 'https://evil.example/x.png', contentType: 'image/png' }, { name: 'page.png', url: 'https://cdn.discordapp.com/attachments/1/page.png', contentType: 'image/png' }, { name: 'doc.pdf', url: 'https://cdn.discordapp.com/attachments/1/doc.pdf', contentType: 'application/pdf' }], embeds: [], reactions: [] },
  ];
  const { media, files, stats } = await inlineMedia({ guildIcon: null, messages }, { fetchImpl });
  assert.deepEqual([...media.keys()].sort(), ['https://cdn.discordapp.com/attachments/1/ok.png', 'https://cdn.discordapp.com/avatars/1/a.png']);
  assert.ok(media.get('https://cdn.discordapp.com/avatars/1/a.png').startsWith('data:image/png;base64,'));
  assert.equal(stats.embedded, 3); // avatar, picture, document
  assert.ok(!asked.some((u) => u.includes('evil.example')), 'no request to a foreign host');
  assert.equal(files.get('https://cdn.discordapp.com/attachments/1/doc.pdf').original, 'page', 'a small document goes inside the page');
  assert.equal(files.get('https://cdn.discordapp.com/attachments/1/page.png').original, null, 'a "picture" that is not one is not trusted');
});

test('pictures: a size cap per file and a budget for the whole page, small things first', async () => {
  const sizes = { 'https://cdn.discordapp.com/avatars/1/a.png': 10, 'https://cdn.discordapp.com/attachments/1/big.png': 5000, 'https://cdn.discordapp.com/attachments/1/s1.png': 400, 'https://cdn.discordapp.com/attachments/1/s2.png': 400, 'https://cdn.discordapp.com/attachments/1/s3.png': 400 };
  const fetchImpl = async (url) => reply(Buffer.alloc(sizes[url], 1), 'image/png', 200, { 'content-length': String(sizes[url]) });
  const att = (n) => ({ name: `${n}.png`, url: `https://cdn.discordapp.com/attachments/1/${n}.png`, contentType: 'image/png' });
  const messages = [{ author: { avatar: 'https://cdn.discordapp.com/avatars/1/a.png' }, attachments: [att('big'), att('s1'), att('s2'), att('s3')], embeds: [], reactions: [] }];
  const { media, stats } = await inlineMedia({ guildIcon: null, messages }, { fetchImpl, maxFileBytes: 1000, budgetBytes: 1200, concurrency: 1 });
  assert.ok(media.has('https://cdn.discordapp.com/avatars/1/a.png'), 'the avatar comes first');
  assert.ok(!media.has('https://cdn.discordapp.com/attachments/1/big.png'), 'over the per-file cap');
  assert.ok(media.has('https://cdn.discordapp.com/attachments/1/s1.png') && media.has('https://cdn.discordapp.com/attachments/1/s2.png'));
  assert.ok(!media.has('https://cdn.discordapp.com/attachments/1/s3.png'), 'over the budget, stays a link');
  assert.ok(stats.bytes <= 1200);
});

test('pictures: a failing download never fails the transcript', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const messages = [{ author: { avatar: 'https://cdn.discordapp.com/avatars/1/a.png' }, attachments: [], embeds: [], reactions: [] }];
  const { media, stats } = await inlineMedia({ guildIcon: 'https://cdn.discordapp.com/icons/1/i.png', messages }, { fetchImpl });
  assert.equal(media.size, 0);
  assert.equal(stats.skipped, 2);
});

test('pictures: every kind of image in a message is found once', () => {
  const urls = collectUrls({
    guildIcon: 'https://cdn.discordapp.com/icons/1/g.png',
    messages: [
      {
        author: { avatar: 'https://cdn.discordapp.com/avatars/1/a.png' },
        content: 'hi <:pepe:123456789012345678> <a:wave:223456789012345678> <:pepe:123456789012345678>',
        attachments: [{ name: 'p.PNG', url: 'https://cdn/p', contentType: '' }],
        embeds: [{ description: 'x <:ee:323456789012345678>', fields: [{ value: 'v' }], image: 'https://m/i', thumbnail: 'https://m/t', author: { iconUrl: 'https://m/ai' }, footer: { iconUrl: 'https://m/fi' } }],
        reactions: [{ url: 'https://cdn/r' }],
        stickers: [{ url: 'https://cdn/s' }],
        forwarded: { attachments: [{ name: 'fw.jpg', url: 'https://cdn/fw', contentType: 'image/jpeg' }], embeds: [] },
      },
      { author: { avatar: 'https://cdn.discordapp.com/avatars/1/a.png' }, attachments: [], embeds: [], reactions: [] },
    ],
  });
  assert.equal(urls[0], 'https://cdn.discordapp.com/icons/1/g.png');
  assert.equal(urls[1], 'https://cdn.discordapp.com/avatars/1/a.png');
  assert.ok(urls.includes(emojiUrl('123456789012345678', false)) && urls.includes(emojiUrl('223456789012345678', true)) && urls.includes(emojiUrl('323456789012345678', false)));
  for (const u of ['https://m/i', 'https://m/t', 'https://m/ai', 'https://m/fi', 'https://cdn/r', 'https://cdn/s']) assert.ok(urls.includes(u), u);
  assert.ok(!urls.includes('https://cdn/p') && !urls.includes('https://cdn/fw'), 'attachments are handled on their own');
  assert.equal(new Set(urls).size, urls.length, 'no duplicates');
});

// ---------- reduced previews, files and downloads ----------

const D = 'https://cdn.discordapp.com/attachments/1';
const imgAtt = (name, size, over = {}) => ({ name, url: `${D}/${name}`, proxyUrl: `https://media.discordapp.net/attachments/1/${name}?ex=a&is=b&hm=c`, contentType: 'image/png', size, width: 4000, height: 3000, ...over });
const fileAtt = (name, size) => ({ name, url: `${D}/${name}`, contentType: 'application/pdf', size });
const msgWith = (...attachments) => [{ author: {}, attachments, embeds: [], reactions: [] }];
const sessionStub = () => {
  const stored = [];
  return { stored, session: { putFile: async (name, buf) => (stored.push({ name, bytes: buf.length }), `https://pub.example/t/T/files/${stored.length}-${name}`) } };
};

test('reduced preview: the address keeps the signature and asks Discord for a smaller webp', () => {
  const u = new URL(previewUrl(imgAtt('big.png', 6e6)));
  assert.equal(u.hostname, 'media.discordapp.net');
  assert.equal(u.searchParams.get('hm'), 'c');
  assert.equal(u.searchParams.get('width'), '1600');
  assert.equal(u.searchParams.get('height'), '1200');
  assert.equal(u.searchParams.get('format'), 'webp');
  assert.equal(u.searchParams.get('animated'), null);
  // a small picture is not enlarged, an animated one stays animated, no size known still gets a width
  const small = new URL(previewUrl(imgAtt('s.png', 6e6, { width: 800, height: 600 })));
  assert.equal(small.searchParams.get('width'), '800');
  assert.equal(new URL(previewUrl(imgAtt('a.gif', 6e6, { contentType: 'image/gif' }))).searchParams.get('animated'), 'true');
  const unknown = new URL(previewUrl({ ...imgAtt('u.png', 6e6), proxyUrl: null, width: 0, height: 0 }));
  assert.equal(unknown.hostname, 'media.discordapp.net');
  assert.equal(unknown.searchParams.get('width'), '1600');
});

test('a big picture is shown reduced and its original goes online; a small one is taken as it is', async () => {
  const asked = [];
  const fetchImpl = async (url) => (asked.push(url), reply(png));
  const { stored, session } = sessionStub();
  const { media, files, stats } = await inlineMedia({ guildIcon: null, messages: msgWith(imgAtt('big.png', 6e6), imgAtt('small.png', 5e4)) }, { fetchImpl, session });

  assert.ok(asked.some((u) => u.startsWith('https://media.discordapp.net/attachments/1/big.png') && u.includes('format=webp')), 'the reduced copy is what is shown');
  assert.ok(media.has(`${D}/big.png`) && media.has(`${D}/small.png`));
  const big = files.get(`${D}/big.png`);
  assert.deepEqual([big.shown, big.reduced, big.original], [true, true, 'online']);
  assert.equal(big.onlineUrl, 'https://pub.example/t/T/files/1-big.png');
  const small = files.get(`${D}/small.png`);
  assert.deepEqual([small.shown, small.reduced, small.original], [true, false, 'page']);
  assert.deepEqual(stored.map((f) => f.name), ['big.png'], 'only what the page does not hold is uploaded');
  assert.equal(stats.reduced, 1);
  assert.ok(asked.includes(`${D}/small.png`) && asked.includes(`${D}/big.png`), 'the original of the big one was fetched to be kept');
});

test('without a place online a big picture is still shown reduced, and its Download falls back to Discord', async () => {
  const { files, media } = await inlineMedia({ guildIcon: null, messages: msgWith(imgAtt('big.png', 6e6)) }, { fetchImpl: async () => reply(png) });
  assert.ok(media.has(`${D}/big.png`));
  assert.deepEqual([files.get(`${D}/big.png`).reduced, files.get(`${D}/big.png`).original], [true, null]);
});

test('when Discord cannot reduce a picture it is taken as it is if small enough, otherwise left out', async () => {
  const proxyDown = async (url) => (url.includes('media.discordapp.net') ? reply(Buffer.from('x'), 'text/plain', 500) : reply(png));
  const ok = await inlineMedia({ guildIcon: null, messages: msgWith(imgAtt('mid.png', 3 * 1024 * 1024)) }, { fetchImpl: proxyDown });
  assert.equal(ok.files.get(`${D}/mid.png`).original, 'page', 'under the cap, the original is used');
  assert.equal(ok.files.get(`${D}/mid.png`).reduced, false);

  const tooBig = await inlineMedia({ guildIcon: null, messages: msgWith(imgAtt('huge.png', 9 * 1024 * 1024)) }, { fetchImpl: proxyDown });
  assert.equal(tooBig.media.has(`${D}/huge.png`), false);
  assert.equal(tooBig.files.get(`${D}/huge.png`).shown, false);
});

test('files: small ones go inside the page, big ones online, and nothing breaks without a place online', async () => {
  const fetchImpl = async () => reply(Buffer.from('%PDF-1.4'), 'application/pdf');
  const { stored, session } = sessionStub();
  const { files } = await inlineMedia({ guildIcon: null, messages: msgWith(fileAtt('small.pdf', 5e5), fileAtt('big.pdf', 3 * 1024 * 1024)) }, { fetchImpl, session });
  const small = files.get(`${D}/small.pdf`);
  assert.equal(small.original, 'page');
  assert.equal(Buffer.from(small.data, 'base64').toString(), '%PDF-1.4');
  assert.equal(small.type, 'application/pdf');
  assert.equal(files.get(`${D}/big.pdf`).original, 'online');
  assert.deepEqual(stored.map((f) => f.name), ['big.pdf']);

  const offline = await inlineMedia({ guildIcon: null, messages: msgWith(fileAtt('big.pdf', 3 * 1024 * 1024)) }, { fetchImpl });
  assert.equal(offline.files.get(`${D}/big.pdf`).original, null);
});

test('online copies have a size cap and a budget, and a failed upload only costs that file', async () => {
  const fetchImpl = async () => reply(Buffer.alloc(100, 1), 'application/zip');
  const { stored, session } = sessionStub();
  const { files } = await inlineMedia(
    { guildIcon: null, messages: msgWith(fileAtt('a.zip', 2 * 1024 * 1024), fileAtt('b.zip', 2 * 1024 * 1024), fileAtt('c.zip', 2 * 1024 * 1024)) },
    { fetchImpl, session, embedFileMax: 1000, hostBudget: 5 * 1024 * 1024 },
  );
  assert.deepEqual(stored.map((f) => f.name).sort(), ['a.zip', 'b.zip']);
  assert.equal(files.get(`${D}/c.zip`).original, null, 'over the budget');

  const failing = { putFile: async () => { throw new Error('upload failed (HTTP 500)'); } };
  const r = await inlineMedia({ guildIcon: null, messages: msgWith(fileAtt('a.zip', 2 * 1024 * 1024)) }, { fetchImpl, session: failing, embedFileMax: 1000 });
  assert.equal(r.files.get(`${D}/a.zip`).original, null);
});

test('file names are made safe for addresses and headers', () => {
  assert.equal(safeName('my report (final).pdf'), 'my_report_final_.pdf');
  assert.equal(safeName('../../etc/passwd'), 'etc_passwd');
  assert.equal(safeName('..'), 'file');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('šč.png'), 'sc.png');
  assert.ok(safeName('x'.repeat(500)).length <= 80);
  assert.match(safeName('a b'), /^[A-Za-z0-9._-]+$/);
});

test('R2 / S3: an original file is stored as opaque bytes that download, next to the page', async () => {
  const b = await bucket();
  try {
    const session = new TranscriptHost(S3(b.endpoint)).session();
    const url = await session.putFile('Résumé (1).pdf', Buffer.from('%PDF'));
    assert.equal(url, `https://pub-abc.r2.dev/t/${session.token}/files/1-Resume_1_.pdf`);
    const r = b.requests[0];
    assert.equal(r.url, `/transcripts/t/${session.token}/files/1-Resume_1_.pdf`);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.match(r.headers['content-disposition'], /^attachment; filename="Resume_1_\.pdf"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20%281%29\.pdf$/);
    assert.match(r.headers.authorization, /SignedHeaders=cache-control;content-disposition;content-type;host;x-amz-content-sha256;x-amz-date/);
    assert.equal(r.body.toString(), '%PDF');
    await session.putPage('<p>x</p>');
    assert.equal(b.requests[1].url, `/transcripts/t/${session.token}/index.html`);
    assert.equal(session.pageUrl, `https://pub-abc.r2.dev/t/${session.token}/index.html`);
  } finally {
    b.server.close();
  }
});

test('own website: originals are written under files/ and served as downloads only', async () => {
  const dir = tmpDir();
  try {
    const session = new TranscriptHost({ local: { dir, publicUrl: 'https://35xw.top' } }).session();
    const evil = await session.putFile('evil.html', Buffer.from('<script>alert(1)</script>'));
    assert.equal(evil, `https://35xw.top/t/${session.token}/files/1-evil.html`);
    await session.putPage('<p>page</p>');
    assert.ok(fs.existsSync(path.join(dir, session.token, 'files', '1-evil.html')));

    const site = createWebServer({
      web: { dir: path.join(dir, 'site'), sessionHours: 1, recheckMinutes: 1, port: 0, host: '127.0.0.1', publicUrl: 'https://35xw.top', roleIds: ['R'], clientSecret: 'x' },
      clientId: '1',
      sessionSecret: 's',
      checkMember: async () => ({ isMember: false, roleIds: [] }),
      transcriptsDir: dir,
      log: { log() {}, warn() {}, error() {} },
    });
    const { port } = await site.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/t/${session.token}/files/1-evil.html`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      assert.equal(res.headers.get('content-disposition'), 'attachment; filename="evil.html"');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await res.text(), '<script>alert(1)</script>');
      for (const p of [`/t/${session.token}/files/9-nothing.pdf`, `/t/${session.token}/files/..%2Findex.html`, `/t/${session.token}/files/x-evil.html`, `/t/${'a'.repeat(32)}/files/1-evil.html`]) {
        assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 404, p);
      }
      assert.equal((await fetch(`http://127.0.0.1:${port}/t/${session.token}/index.html`)).status, 200);
    } finally {
      await site.stop();
    }
  } finally {
    rm(dir);
  }
});
