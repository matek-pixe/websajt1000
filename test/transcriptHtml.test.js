'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTranscriptHtml, renderContent, formatSpan } = require('../src/services/transcriptHtml');

const ticket = { number: 7, userId: 'U1', username: 'matija', openedAt: Date.UTC(2026, 0, 1, 10, 0) };
const msg = (over = {}) => ({
  id: 'm',
  createdTimestamp: Date.UTC(2026, 0, 1, 10, 5),
  author: { id: 'U1', name: 'matija', tag: 'matija', bot: false, avatar: 'https://cdn/x.png' },
  content: 'hello',
  mentions: {},
  attachments: [],
  embeds: [],
  ...over,
});

test('renderContent escapes HTML and applies light markup', () => {
  const out = renderContent('<script>x</script> **bold** *it* `code` https://a.b/c?d=1&e=2 <@42>', { 42: 'bob' });
  assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('<strong>bold</strong>'));
  assert.ok(out.includes('<em>it</em>'));
  assert.ok(out.includes('<code>code</code>'));
  assert.ok(out.includes('<a href="https://a.b/c?d=1&amp;e=2"'));
  assert.ok(out.includes('<span class="mention">@bob</span>'));
  assert.equal(renderContent('a\nb'), 'a<br>b');
});

test('formatSpan renders h/m/s', () => {
  assert.equal(formatSpan(40_000), '40s');
  assert.equal(formatSpan(5 * 60_000 + 3000), '5m 3s');
  assert.equal(formatSpan(2 * 3_600_000 + 5 * 60_000), '2h 5m');
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('renderTranscriptHtml: header facts, messages, escaping, attachments, bot tag', () => {
  const closedAt = Date.UTC(2026, 0, 1, 11, 12);
  const media = new Map([
    ['https://cdn/x.png', PNG],
    ['https://cdn/pic.png', PNG],
  ]);
  const html = renderTranscriptHtml({
    ticket,
    ticketName: 'ticket-0007',
    guildName: 'My <Server>',
    closedBy: { id: 'S1', name: 'staff' },
    closedAt,
    media,
    messages: [
      msg(),
      msg({ id: 'm2', author: { id: 'B1', name: 'Bot', bot: true, avatar: null }, content: '<b>hi</b>', createdTimestamp: Date.UTC(2026, 0, 1, 10, 6) }),
      msg({
        id: 'm3',
        author: { id: 'U1', name: 'matija', avatar: 'https://cdn/x.png' },
        createdTimestamp: Date.UTC(2026, 0, 1, 10, 30),
        content: '',
        attachments: [
          { name: 'pic.png', url: 'https://cdn/pic.png', contentType: 'image/png' },
          { name: 'big.png', url: 'https://cdn/big.png', contentType: 'image/png' },
          { name: 'doc.pdf', url: 'https://cdn/doc.pdf', contentType: 'application/pdf', size: 2048 },
        ],
        embeds: [{ title: 'T', description: 'D', fields: [{ name: 'F', value: 'V', inline: true }], color: 0xaa0000, footer: { text: 'foot' } }],
      }),
    ],
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>Transcript - ticket-0007</title>'));
  assert.ok(html.includes('# ticket-0007'));
  assert.ok(html.includes('My &lt;Server&gt;')); // escaped
  assert.ok(html.includes('matija <span class="muted">(U1)</span>'));
  assert.ok(html.includes('staff <span class="muted">(S1)</span>'));
  assert.ok(html.includes('>1h 12m<')); // duration
  assert.ok(html.includes('info-key">Messages</span><span class="info-val">3<'));
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;')); // user content escaped
  assert.ok(!html.includes('<b>hi</b>'));
  assert.ok(html.includes('class="bot-tag">APP'));
  assert.ok(html.includes(`<img class="avatar" src="${PNG}"`)); // avatar embedded, not linked
  assert.ok(html.includes(`<div class="media"><img src="${PNG}" alt="pic.png">`)); // picture embedded
  assert.ok(!html.includes('src="https://cdn/'), 'nothing is loaded from the network');
  assert.ok(html.includes('Preview not available')); // not in media -> a card with a link, never a broken image
  assert.ok(html.includes('file-name">doc.pdf</div>'));
  assert.ok(html.includes('href="https://cdn/doc.pdf" target="_blank" rel="noopener noreferrer"'), 'no kept copy: Discord link');
  assert.ok(html.includes('2 KB'));
  assert.ok(html.includes('embed-title">T<'));
  assert.ok(html.includes('border-left-color:#aa0000'));
  assert.ok(html.includes('embed-field-name">F<'));
  assert.ok(html.includes('class="avatar placeholder">B<')); // no avatar -> initial
  // same author within a few minutes is grouped under the first message
  assert.equal((html.match(/class="msg grouped"/g) || []).length, 0);
});

test('renderTranscriptHtml: consecutive messages of one author are grouped', () => {
  const html = renderTranscriptHtml({
    ticket,
    guildName: 'S',
    closedAt: Date.UTC(2026, 0, 1, 11, 0),
    messages: [msg({ id: 'a' }), msg({ id: 'b', createdTimestamp: Date.UTC(2026, 0, 1, 10, 6) }), msg({ id: 'c', createdTimestamp: Date.UTC(2026, 0, 1, 12, 0) })],
  });
  assert.equal((html.match(/class="msg grouped"/g) || []).length, 1);
});

test('renderTranscriptHtml: the page cannot load anything or run foreign scripts', () => {
  const html = renderTranscriptHtml({
    ticket,
    guildName: 'S',
    closedAt: Date.UTC(2026, 0, 1, 11, 0),
    messages: [msg({ content: '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) javascript:alert(1)', author: { id: 'U1', name: '"><script>x</script>', color: 'red;background:url(x)' } })],
  });
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src &#39;none&#39;/);
  assert.match(csp, /img-src data:/);
  assert.match(csp, /script-src &#39;nonce-[A-Za-z0-9+/=]+&#39;/);
  const nonce = /nonce-([A-Za-z0-9+/=]+)&#39;/.exec(csp)[1];
  assert.equal((html.match(/<script/g) || []).length, 1, 'only the page script');
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(!html.includes('onclick='));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('background:url(x)'), 'colours are validated before they reach a style');
  assert.ok(!/href="javascript:/i.test(html));
  assert.ok(html.includes('name="robots" content="noindex, nofollow"'));
});

test('renderTranscriptHtml: replies, forwards, reactions, buttons and the edited tag', () => {
  const media = new Map([['https://cdn/emojis/1.png', PNG]]);
  const html = renderTranscriptHtml({
    ticket,
    guildName: 'S',
    closedAt: Date.UTC(2026, 0, 1, 11, 0),
    media,
    messages: [
      msg({ id: 'orig', content: 'the original <question>' }),
      msg({ id: 'r1', author: { id: 'S1', name: 'staff', avatar: null }, content: 'answer', replyTo: 'orig', edited: true }),
      msg({ id: 'r2', content: 'reply to gone', replyTo: 'missing' }),
      msg({
        id: 'fw',
        content: '',
        forwarded: {
          content: 'forwarded **text** https://x.y/z',
          createdTimestamp: Date.UTC(2025, 11, 31, 9, 0),
          attachments: [{ name: 'shot.png', url: 'https://cdn/shot.png', contentType: 'image/png' }],
          embeds: [{ title: 'E', description: '' }],
        },
      }),
      msg({
        id: 'rx',
        content: 'nice',
        reactions: [
          { name: '👍', id: null, url: null, count: 3 },
          { name: 'pepe', id: '1', url: 'https://cdn/emojis/1.png', count: 1 },
        ],
        components: [[{ label: 'Close', style: 2, emoji: '🔒' }, { label: 'Docs', url: 'https://d.example/x' }]],
      }),
    ],
  });
  assert.ok(html.includes('<span class="reply-name">matija</span><span class="reply-text">the original &lt;question&gt;</span>'));
  assert.ok(html.includes('Replying to a message that is not in this transcript'));
  assert.ok(html.includes('<span class="edited">(edited)</span>'));
  assert.ok(html.includes('↪ Forwarded'));
  assert.ok(html.includes('forwarded <strong>text</strong> <a href="https://x.y/z"'));
  assert.ok(html.includes('shot.png'));
  assert.ok(html.includes('embed-title">E<'));
  assert.ok(html.includes('<span class="reaction">👍<span>3</span></span>'));
  assert.ok(html.includes(`<img class="emoji" src="${PNG}" alt="pepe">`));
  assert.ok(html.includes('<span class="btn btn-secondary">🔒 Close</span>'));
  assert.ok(html.includes('class="btn btn-link" href="https://d.example/x"'));
});

test('renderTranscriptHtml: wording with one message and a missing closer', () => {
  const html = renderTranscriptHtml({
    ticket,
    ticketName: 'ticket-0001',
    guildName: 'S',
    closedAt: Date.UTC(2026, 0, 1, 10, 30),
    messages: [msg()],
  });
  assert.ok(html.includes('info-key">Messages</span><span class="info-val">1<'));
  assert.ok(html.includes('info-key">Closed by</span><span class="info-val">unknown'));
  assert.ok(html.includes('<title>Transcript - ticket-0001</title>'));
  assert.ok(html.includes('End of transcript'));
  assert.ok(!/[–—]/.test(html), 'no dashes used as punctuation');
});

test('renderContent: code is left alone, custom emoji and mentions resolve, quotes and lists become blocks', () => {
  const ctx = { roles: { 5: { name: 'Staff', color: '#aa0000' } }, channels: { 9: 'rules' }, emoji: (id, a, name) => `[emoji ${name}]` };
  const out = renderContent('`**not bold**` **bold** __under__ ~~gone~~ ||secret|| <@&5> <#9> <:pepe:123456789012345678> <t:1700000000:R>\n> quoted\n- item\n# Title', {}, ctx);
  assert.ok(out.includes('<code>**not bold**</code>'));
  assert.ok(out.includes('<strong>bold</strong>') && out.includes('<u>under</u>') && out.includes('<s>gone</s>'));
  assert.ok(out.includes('<span class="spoiler">secret</span>'));
  assert.ok(out.includes('style="color:#aa0000;background:#aa000022">@Staff</span>'));
  assert.ok(out.includes('#rules'));
  assert.ok(out.includes('[emoji pepe]'));
  assert.ok(out.includes('data-ts="2023-11-14T22:13:20.000Z" data-style="R"'));
  assert.ok(out.includes('<div class="quote">quoted</div>'));
  assert.ok(out.includes('<div class="li">• item</div>'));
  assert.ok(out.includes('<div class="h1">Title</div>'));
  assert.ok(!out.includes('\u0000'));
});

test('renderContent: a link keeps its underscores and ampersands', () => {
  const out = renderContent('see https://a.b/c_d_e?x=1&y=2 now');
  assert.ok(out.includes('<a href="https://a.b/c_d_e?x=1&amp;y=2"'));
  assert.ok(!out.includes('<em>'));
});

test('renderTranscriptHtml: every picture and file gets a Download from the best place there is', () => {
  const att = (name, url, over = {}) => ({ name, url, contentType: name.endsWith('.png') ? 'image/png' : 'application/pdf', size: 2048, ...over });
  const media = new Map([
    ['https://cdn/own.png', PNG],
    ['https://cdn/reduced.png', PNG],
  ]);
  const files = new Map([
    ['https://cdn/own.png', { shown: true, reduced: false, original: 'page' }],
    ['https://cdn/reduced.png', { shown: true, reduced: true, original: 'online', onlineUrl: 'https://pub.example/t/T/files/1-reduced.png' }],
    ['https://cdn/small.pdf', { original: 'page', data: 'QUJD', type: 'application/pdf' }],
    ['https://cdn/big.pdf', { original: 'online', onlineUrl: 'https://pub.example/t/T/files/2-big.pdf' }],
  ]);
  const html = renderTranscriptHtml({
    ticket,
    guildName: 'S',
    closedAt: Date.UTC(2026, 0, 1, 11, 0),
    media,
    files,
    messages: [
      msg({ attachments: [att('own.png', 'https://cdn/own.png'), att('reduced.png', 'https://cdn/reduced.png', { size: 6 * 1024 * 1024 }), att('small.pdf', 'https://cdn/small.pdf'), att('big.pdf', 'https://cdn/big.pdf'), att('gone.zip', 'https://cdn/gone.zip', { contentType: 'application/zip' })] }),
    ],
  });
  // a picture that is the original: downloaded from the page itself
  assert.ok(html.includes('<a class="dl" href="#" data-from="img" data-name="own.png">Download</a>'));
  // a reduced preview: the original comes from the online copy, and the page says it is reduced
  assert.ok(html.includes('reduced preview, click to enlarge'));
  assert.ok(html.includes('<a class="dl" href="https://pub.example/t/T/files/1-reduced.png" rel="noopener noreferrer">Download original</a>'));
  // a small file travels inside the page
  assert.ok(html.includes('data-name="small.pdf" data-type="application/pdf" data-b64="QUJD">Download</a>'));
  // a big file is downloaded from the online copy
  assert.ok(html.includes('<a class="dl" href="https://pub.example/t/T/files/2-big.pdf" rel="noopener noreferrer">Download</a>'));
  // nothing kept: Discord's own link, honestly labelled
  assert.ok(html.includes(`href="https://cdn/gone.zip" target="_blank" rel="noopener noreferrer" title="Discord's own link, it can stop working">Open original</a>`));
  // the page script saves from the page and the picture can be enlarged
  assert.ok(html.includes('URL.createObjectURL'));
  assert.ok(html.includes('.media img,.embed-image img'));
});

test('renderTranscriptHtml: a hostile file name or address cannot break out of the markup', () => {
  const html = renderTranscriptHtml({
    ticket,
    guildName: 'S',
    closedAt: Date.UTC(2026, 0, 1, 11, 0),
    files: new Map([['https://cdn/a', { original: 'online', onlineUrl: 'javascript:alert(1)' }]]),
    messages: [msg({ attachments: [{ name: '"><script>x</script>.pdf', url: 'https://cdn/a', contentType: 'application/pdf', size: 1 }] })],
  });
  assert.ok(!html.includes('"><script>x'));
  assert.ok(!/href="javascript:/i.test(html));
  assert.equal((html.match(/<script/g) || []).length, 1);
});
