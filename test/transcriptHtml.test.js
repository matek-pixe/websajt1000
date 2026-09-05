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

test('renderTranscriptHtml: header facts, messages, escaping, attachments, bot badge', () => {
  const closedAt = Date.UTC(2026, 0, 1, 11, 12);
  const html = renderTranscriptHtml({
    ticket,
    ticketName: 'ticket-0007',
    guildName: 'My <Server>',
    closedBy: { id: 'S1', name: 'staff' },
    closedAt,
    messages: [
      msg(),
      msg({ id: 'm2', author: { id: 'B1', name: 'Bot', bot: true, avatar: null }, content: '<b>hi</b>' }),
      msg({
        id: 'm3',
        author: { id: 'U1', name: 'matija', avatar: 'https://cdn/x.png' },
        content: '',
        attachments: [
          { name: 'pic.png', url: 'https://cdn/pic.png', contentType: 'image/png' },
          { name: 'doc.pdf', url: 'https://cdn/doc.pdf', contentType: 'application/pdf' },
        ],
        embeds: [{ title: 'T', description: 'D' }],
      }),
    ],
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('🎫 ticket-0007'));
  assert.ok(html.includes('My &lt;Server&gt;')); // escaped
  assert.ok(html.includes('Opened by <b>matija</b>'));
  assert.ok(html.includes('Closed by <b>staff</b>'));
  assert.ok(html.includes('<b>3</b> messages'));
  assert.ok(html.includes('<b>2</b> participants'));
  assert.ok(html.includes('Duration <b>1h 12m</b>'));
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;')); // user content escaped
  assert.ok(!html.includes('<b>hi</b>'));
  assert.ok(html.includes('class="badge">BOT'));
  assert.ok(html.includes('<img src="https://cdn/pic.png"'));
  assert.ok(html.includes('📎 doc.pdf'));
  assert.ok(html.includes('embed-title">T<'));
  assert.ok(html.includes('src="https://cdn/x.png"'));
  assert.ok(html.includes('class="avatar placeholder">B<')); // no avatar -> initial
});

test('renderTranscriptHtml: replies, forwards, reactions and the edited tag', () => {
  const html = renderTranscriptHtml({
    ticket,
    guildName: 'S',
    closedAt: Date.UTC(2026, 0, 1, 11, 0),
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
      }),
    ],
  });
  // reply to an existing message shows author + escaped snippet
  assert.ok(html.includes('↩️ Replying to <b>matija</b>: the original &lt;question&gt;'));
  // reply to a message that is not in the transcript
  assert.ok(html.includes('Replying to <i>a deleted message</i>'));
  // edited tag
  assert.ok(html.includes('<span class="edited">(edited)</span>'));
  // forward block with its own content, timestamp, attachment and embed
  assert.ok(html.includes('↪️ Forwarded · 2025-12-31 09:00 UTC'));
  assert.ok(html.includes('forwarded <strong>text</strong> <a href="https://x.y/z"'));
  assert.ok(html.includes('<img src="https://cdn/shot.png"'));
  assert.ok(html.includes('embed-title">E<'));
  // reactions: unicode emoji and custom emoji image, with counts
  assert.ok(html.includes('<span class="reaction">👍<span class="count">3</span></span>'));
  assert.ok(html.includes('<img src="https://cdn/emojis/1.png" alt="pepe"'));
  assert.ok(html.includes('<span class="count">1</span>'));
});
