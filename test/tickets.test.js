'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Storage } = require('../src/storage');
const {
  TicketService,
  formatTicketName,
  formatTranscriptName,
  defaultGuildBucket,
  evaluateOpen,
  formatDuration,
  normalizeMessage,
} = require('../src/services/tickets');
const { tmpDir, rm } = require('./helpers');

const CFG = {
  manager: { id: 'MGR' },
  tickets: {
    categoryName: '🎫 Tickets',
    transcriptChannelName: 'transcripts',
    maxTranscriptMessages: 2000,
    reopenCooldownMs: 10 * 60 * 1000,
    deleteDelayMs: 0,
  },
};

/** Minimal fake guild whose channels.create records channels and supports the calls the service makes. */
function mkGuild(id = 'G') {
  const store = new Map();
  let n = 1;
  const g = {
    id,
    name: 'Guild ' + id,
    roles: { cache: new Map() },
    members: { me: { id: 'BOT' }, cache: new Map() },
    channels: {
      cache: { get: (x) => store.get(x), has: (x) => store.has(x), find: (fn) => [...store.values()].find(fn) },
      create: async (o) => {
        const ch = {
          id: `${id}-${n++}`,
          name: o.name,
          type: o.type,
          parentId: o.parent || null,
          guild: g,
          sent: [],
          deleted: false,
          _history: [],
          send: async (p) => {
            ch.sent.push(p);
            return {};
          },
          delete: async () => {
            ch.deleted = true;
            store.delete(ch.id);
          },
          messages: {
            fetch: async ({ before }) => {
              const arr = before ? [] : ch._history;
              return { size: arr.length, values: () => arr[Symbol.iterator](), last: () => arr[arr.length - 1] };
            },
          },
        };
        store.set(ch.id, ch);
        return ch;
      },
    },
    _store: store,
  };
  return g;
}
const m = (id) => ({ id, user: { tag: id, username: id } });

test('a ticket keeps one number: ticket-0001 and transcript-0001', () => {
  assert.equal(formatTicketName(1), 'ticket-0001');
  assert.equal(formatTranscriptName(1), 'transcript-0001');
  assert.equal(formatTicketName(42), 'ticket-0042');
  assert.equal(formatTranscriptName(12345), 'transcript-12345');
});

test('evaluateOpen: one open ticket per user', () => {
  const b = defaultGuildBucket();
  b.tickets.C1 = { userId: 'U1', status: 'open' };
  const r = evaluateOpen(b, 'U1', 0, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_open');
  assert.equal(r.channelId, 'C1');
  assert.equal(evaluateOpen(b, 'U2', 0, 1000).ok, true);
});

test('evaluateOpen: 10-minute cooldown after close, then allowed again', () => {
  const b = defaultGuildBucket();
  const tenMin = 10 * 60 * 1000;
  b.users.U1 = { lastClosedAt: 1_000_000 };
  const during = evaluateOpen(b, 'U1', 1_000_000 + tenMin - 1, tenMin);
  assert.equal(during.ok, false);
  assert.equal(during.reason, 'cooldown');
  assert.equal(during.retryInMs, 1);
  assert.equal(evaluateOpen(b, 'U1', 1_000_000 + tenMin, tenMin).ok, true);
});

test('formatDuration renders minutes and seconds', () => {
  assert.equal(formatDuration(1000), '1s');
  assert.equal(formatDuration(61_000), '1m 1s');
});

test('normalizeMessage flattens a discord.js message into renderer data', () => {
  const out = normalizeMessage({
    id: '1',
    createdTimestamp: 5,
    author: { id: 'A', username: 'alice', globalName: 'Alice', tag: 'alice', bot: false, displayAvatarURL: () => 'https://cdn/a.png' },
    member: { displayName: 'Ali' },
    content: 'hi <@B>',
    mentions: { users: new Map([['B', { id: 'B', username: 'bob' }]]) },
    attachments: new Map([['x', { name: 'f.png', url: 'https://cdn/f.png', contentType: 'image/png' }]]),
    embeds: [{ title: 'T', description: '' }, { title: '', description: '' }],
  });
  assert.equal(out.author.name, 'Ali'); // server nickname wins
  assert.equal(out.author.avatar, 'https://cdn/a.png');
  assert.deepEqual(out.mentions, { B: 'bob' });
  assert.equal(out.attachments[0].name, 'f.png');
  assert.equal(out.embeds.length, 1); // empty embed dropped
});

test('close: saves the HTML transcript to the single #transcripts channel, then deletes the ticket', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const g = mkGuild();
    const r1 = await svc.createTicket(g, m('U1'));
    const r2 = await svc.createTicket(g, m('U2'));
    assert.equal(r1.channel.name, 'ticket-0001');
    assert.equal(r2.channel.name, 'ticket-0002');
    const tickets = [...g._store.values()].find((c) => c.name === '🎫 Tickets');
    assert.ok(tickets);

    r2.channel._history = [
      { id: 'b', createdTimestamp: 2000, author: { id: 'S', username: 'staff', tag: 'staff' }, content: 'hello', attachments: new Map(), embeds: [] },
      { id: 'a', createdTimestamp: 1000, author: { id: 'U2', username: 'U2', tag: 'U2' }, content: 'help <b>me</b>', attachments: new Map(), embeds: [] },
    ];
    // close #2 first -> its transcript must be transcript-0002
    const res = await svc.closeTicket(r2.channel, { id: 'S', username: 'staff', tag: 'staff' });
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    const tr = [...g._store.values()].find((c) => c.name === 'transcripts');
    assert.ok(tr && tr.parentId === tickets.id, 'transcripts channel inside the tickets category');
    assert.equal(res.transcriptChannel.id, tr.id);
    const post = tr.sent[0];
    assert.equal(post.files[0].name, 'transcript-0002.html');
    const html = Buffer.from(post.files[0].attachment).toString();
    assert.ok(html.includes('🎫 ticket-0002'));
    assert.ok(html.indexOf('help &lt;b&gt;me&lt;/b&gt;') < html.indexOf('hello'), 'oldest first, escaped');
    const embed = post.embeds[0].toJSON();
    const field = (n) => embed.fields.find((f) => f.name === n).value;
    assert.equal(field('🎫 Ticket'), 'ticket-0002');
    assert.equal(field('👤 Opened by'), '<@U2>');
    assert.equal(field('🔒 Closed by'), '<@S>');
    assert.equal(field('💬 Messages'), '2');
    assert.ok(embed.title.includes('ticket-0002'));

    // ticket channel deleted, record gone, cooldown started, other ticket untouched
    assert.equal(r2.channel.deleted, true);
    assert.equal(svc.get('G', r2.channel.id), null);
    assert.ok(svc._guild('G').users.U2.lastClosedAt > 0);
    assert.equal((await svc.createTicket(g, m('U2'))).reason, 'cooldown');
    assert.equal(r1.channel.deleted, false);
    assert.equal(svc.get('G', r1.channel.id).status, 'open');

    // closing the second ticket reuses the same transcripts channel
    await svc.closeTicket(r1.channel, { id: 'S', username: 'staff', tag: 'staff' });
    assert.equal([...g._store.values()].filter((c) => c.name === 'transcripts').length, 1);
    assert.equal(tr.sent.length, 2);
    assert.equal(tr.sent[1].files[0].name, 'transcript-0001.html');

    // numbering continues
    assert.equal((await svc.createTicket(g, m('U3'))).channel.name, 'ticket-0003');
  } finally {
    rm(dir);
  }
});

test('close: if the transcript cannot be saved the channel is kept', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const g = mkGuild();
    const r = await svc.createTicket(g, m('U1'));
    svc.saveTranscript = async () => {
      throw new Error('boom');
    };
    const res = await svc.closeTicket(r.channel, { id: 'S', username: 'staff' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'transcript_failed');
    assert.equal(r.channel.deleted, false);
    assert.equal(svc.get('G', r.channel.id).status, 'open');
    assert.ok(r.channel.sent.at(-1).content.includes('not'));
  } finally {
    rm(dir);
  }
});

test('service: counter, staff role and records persist across a reload', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const svc = new TicketService(new Storage(file), CFG);
    svc.setStaffRole('G', 'STAFF');
    const b = svc._guild('G');
    b.counter = 7;
    b.tickets.CHAN = { number: 7, userId: 'U1', status: 'open', openedAt: 1 };
    svc.storage.save();
    const svc2 = new TicketService(new Storage(file), CFG);
    assert.equal(svc2._guild('G').counter, 7);
    assert.equal(svc2.getStaffRole('G'), 'STAFF');
    assert.equal(svc2.get('G', 'CHAN').number, 7);
    assert.equal(svc2.get('G', 'nope'), null);
  } finally {
    rm(dir);
  }
});

test('service: forgetChannel clears a record and starts the cooldown if it was open', () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const b = svc._guild('G');
    b.tickets.CHAN = { number: 1, userId: 'U1', status: 'open', openedAt: 1 };
    assert.equal(svc.forgetChannel('G', 'CHAN'), true);
    assert.equal(svc.get('G', 'CHAN'), null);
    assert.ok(b.users.U1 && b.users.U1.lastClosedAt > 0);
    assert.equal(svc.forgetChannel('G', 'CHAN'), false);
  } finally {
    rm(dir);
  }
});

test('every server numbers its own tickets independently (each starts at ticket-0001)', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const A = mkGuild('A');
    const B = mkGuild('B');
    const a1 = await svc.createTicket(A, m('U1'));
    const a2 = await svc.createTicket(A, m('U2'));
    const b1 = await svc.createTicket(B, m('U1'));
    assert.equal(a1.channel.name, 'ticket-0001');
    assert.equal(a2.channel.name, 'ticket-0002');
    assert.equal(b1.channel.name, 'ticket-0001');
    assert.equal(svc._guild('A').counter, 2);
    assert.equal(svc._guild('B').counter, 1);
    svc.setStaffRole('A', 'STAFF-A');
    assert.equal(svc.getStaffRole('B'), null);
  } finally {
    rm(dir);
  }
});

test('bypass lets the manager ignore the one-open-ticket rule and the cooldown', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const g = mkGuild();
    const mgr = m('MGR');
    assert.equal((await svc.createTicket(g, mgr)).ok, true);
    assert.equal((await svc.createTicket(g, mgr)).reason, 'already_open');
    assert.equal((await svc.createTicket(g, mgr, { bypass: true })).ok, true);
    svc._guild('G').users.MGR = { lastClosedAt: Date.now() };
    assert.equal((await svc.createTicket(g, mgr, { bypass: true })).ok, true);
    assert.equal(svc._guild('G').counter, 3);
  } finally {
    rm(dir);
  }
});

test('service: isStaff recognises manager, admins and the staff role', () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    svc.setStaffRole('G', 'STAFF');
    const mk = (id, perms = [], roles = []) => ({
      id,
      permissions: { has: (p) => perms.includes(p) },
      roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
    });
    const { PermissionFlagsBits } = require('discord.js');
    assert.equal(svc.isStaff(mk('MGR'), 'G'), true);
    assert.equal(svc.isStaff(mk('A', [PermissionFlagsBits.Administrator]), 'G'), true);
    assert.equal(svc.isStaff(mk('B', [], ['STAFF']), 'G'), true);
    assert.equal(svc.isStaff(mk('C'), 'G'), false);
    assert.equal(svc.isStaff(null, 'G'), false);
  } finally {
    rm(dir);
  }
});
