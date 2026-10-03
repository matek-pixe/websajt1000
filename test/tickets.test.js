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
const { MessageFlags } = require('discord.js');
const { COLORS } = require('../src/ui');
const verify = require('../src/commands/verify');
const ticketClose = require('../src/commands/ticketClose');
const ticketAdd = require('../src/commands/ticketAdd');
const { openTicketFlow, requireTicket, requireStaff } = require('../src/commands/_tickets');
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
      cache: { get: (x) => store.get(x), has: (x) => store.has(x), find: (fn) => [...store.values()].find(fn), values: () => store.values() },
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
  assert.deepEqual(out.reactions, []);
  assert.equal(out.replyTo, null);
  assert.equal(out.forwarded, null);
  assert.equal(out.edited, false);
});

test('normalizeMessage captures reactions, replies, forwards and edits', () => {
  const base = { createdTimestamp: 1, author: { id: 'A', username: 'a' }, attachments: new Map(), embeds: [] };

  // reply (type 19) with reactions (unicode + custom) and an edit
  const reply = normalizeMessage({
    ...base,
    id: 'r',
    type: 19,
    reference: { messageId: 'orig', type: 0 },
    editedTimestamp: 5,
    reactions: {
      cache: new Map([
        ['👍', { count: 2, emoji: { name: '👍', id: null } }],
        ['1', { count: 1, emoji: { name: 'pepe', id: '1', animated: true, imageURL: (o) => `https://cdn/1.${o.extension}` } }],
      ]),
    },
  });
  assert.equal(reply.replyTo, 'orig');
  assert.equal(reply.edited, true);
  assert.deepEqual(reply.reactions, [
    { name: '👍', id: null, animated: false, url: null, count: 2 },
    { name: 'pepe', id: '1', animated: true, url: 'https://cdn/1.gif', count: 1 },
  ]);

  // forward: reference type 1 + a message snapshot; must NOT be treated as a reply
  const snap = { content: 'fwd text', createdTimestamp: 9, attachments: new Map([['x', { name: 'p.png', url: 'u', contentType: 'image/png' }]]), embeds: [{ title: 'T' }] };
  const fwd = normalizeMessage({
    ...base,
    id: 'f',
    type: 0,
    content: '',
    reference: { messageId: 'far', type: 1 },
    messageSnapshots: new Map([['far', snap]]),
  });
  assert.equal(fwd.replyTo, null);
  assert.equal(fwd.forwarded.content, 'fwd text');
  assert.equal(fwd.forwarded.createdTimestamp, 9);
  assert.equal(fwd.forwarded.attachments[0].name, 'p.png');
  assert.equal(fwd.forwarded.embeds[0].title, 'T');
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
    assert.ok(html.includes('# ticket-0002'));
    assert.ok(html.indexOf('help &lt;b&gt;me&lt;/b&gt;') < html.indexOf('hello'), 'oldest first, escaped');
    const embed = post.embeds[0].toJSON();
    const field = (n) => embed.fields.find((f) => f.name === n).value;
    assert.equal(field('Ticket'), 'ticket-0002');
    assert.equal(field('Opened by'), '<@U2>');
    assert.equal(field('Closed by'), '<@S>');
    assert.equal(field('Messages'), '2');
    assert.equal(embed.title, '📄 Transcript for ticket-0002');
    assert.equal(embed.description, undefined, 'no description line');
    assert.equal(embed.footer, undefined, 'no footer and no timestamp');
    assert.equal(embed.timestamp, undefined);

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
    assert.equal(
      r.channel.sent.at(-1).content,
      'Could not save the transcript (boom). The ticket was not deleted. Try closing it again.',
    );
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

test('numbering continues after the database was lost, using what Discord still shows', async () => {
  const dirA = tmpDir();
  const dirB = tmpDir();
  try {
    const g = mkGuild();
    const before = new TicketService(new Storage(path.join(dirA, 'db.json')), CFG);
    await before.createTicket(g, m('U1')); // ticket-0001 stays open
    const tr = await before.ensureTranscriptChannel(g);
    tr._history = [
      { attachments: new Map([['a', { name: 'transcript-0007.html' }]]) },
      { attachments: new Map([['b', { name: 'transcript-0005.html' }]]) },
      { attachments: new Map() },
    ];

    // fresh bot, empty database (the host lost data/db.json)
    const after = new TicketService(new Storage(path.join(dirB, 'db.json')), CFG);
    assert.equal(after._guild('G').counter, 0);
    const next = await after.createTicket(g, m('U2'));
    assert.equal(next.channel.name, 'ticket-0008');
    assert.equal(after._guild('G').counter, 8);
    assert.equal((await after.createTicket(g, m('U3'))).channel.name, 'ticket-0009');
  } finally {
    rm(dirA);
    rm(dirB);
  }
});

test('the stored counter is never lowered by what Discord shows', async () => {
  const dir = tmpDir();
  try {
    const storage = new Storage(path.join(dir, 'db.json'));
    const svc = new TicketService(storage, CFG);
    const g = mkGuild();
    svc._guild('G').counter = 50;
    assert.equal((await svc.createTicket(g, m('U1'))).channel.name, 'ticket-0051');
  } finally {
    rm(dir);
  }
});

test('only the tickets category is read for numbers, other channels cannot inflate the counter', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const g = mkGuild();
    g._store.set('X', { id: 'X', name: 'ticket-9999', type: 0, parentId: 'ELSEWHERE' });
    assert.equal((await svc.createTicket(g, m('U1'))).channel.name, 'ticket-0001');
  } finally {
    rm(dir);
  }
});

function notifyKit(over = {}) {
  const dir = tmpDir();
  const storage = new Storage(path.join(dir, 'db.json'));
  const cfg = { ...CFG, tickets: { ...CFG.tickets, notify: { userId: 'OWNER', channelId: 'NEWS', roleIds: ['R1', 'R2', 'GONE'], ...over } } };
  const svc = new TicketService(storage, cfg);
  const g = mkGuild('G');
  g.ownerId = 'OWNER';
  g.roles.cache = new Map([['R1', {}], ['R2', {}]]);
  const posted = [];
  const dms = [];
  g._store.set('NEWS', { id: 'NEWS', name: 'staff-news', type: 0, send: async (p) => posted.push(p) });
  g.client = { users: { send: async (id, p) => dms.push({ id, p }) } };
  return { svc, g, posted, dms, storage, done: () => rm(dir) };
}

test('a new ticket pings the roles in the staff channel and DMs the owner', async () => {
  const k = notifyKit();
  try {
    const r = await k.svc.createTicket(k.g, m('U1'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r.ok, true);
    assert.equal(k.posted.length, 1);
    assert.equal(k.posted[0].content, '<@&R1> <@&R2>'); // GONE does not exist here, so it is left out
    assert.deepEqual(k.posted[0].allowedMentions, { roles: ['R1', 'R2'], users: [] });
    const e = k.posted[0].embeds[0].toJSON();
    assert.equal(e.title, 'New ticket');
    assert.match(e.description, new RegExp(`<@U1> opened <#${r.channel.id}>`));
    assert.equal(e.fields.find((f) => f.name === 'Ticket').value, '#0001');
    assert.equal(k.dms.length, 1);
    assert.equal(k.dms[0].id, 'OWNER');
    assert.equal(k.dms[0].p.embeds[0].toJSON().title, 'New ticket');
  } finally {
    k.done();
  }
});

test('other servers never reach the owner: no staff channel and not owned by them means no alert', async () => {
  const k = notifyKit();
  try {
    const other = mkGuild('H');
    other.ownerId = 'SOMEONE';
    other.client = k.g.client;
    await k.svc.createTicket(other, m('U1'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(k.posted.length, 0);
    assert.equal(k.dms.length, 0);
  } finally {
    k.done();
  }
});

test('after /setup server the staff-news channel it built is used', async () => {
  const k = notifyKit({ channelId: 'DELETED-LONG-AGO' });
  try {
    k.g._store.set('NEW-NEWS', { id: 'NEW-NEWS', name: 'staff-news', type: 0, send: async (p) => k.posted.push(p) });
    k.storage.data.setup.G = { roles: {}, channels: { staff_news: 'NEW-NEWS' }, keep: [] };
    await k.svc.createTicket(k.g, m('U1'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(k.posted.length, 1);
  } finally {
    k.done();
  }
});

test('a failing alert never breaks the ticket', async () => {
  const k = notifyKit();
  try {
    k.g._store.get('NEWS').send = async () => {
      throw new Error('Missing Access');
    };
    k.g.client = { users: { send: async () => { throw new Error('Cannot send messages to this user'); } } };
    const r = await k.svc.createTicket(k.g, m('U1'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r.ok, true);
    assert.equal(r.channel.name, 'ticket-0001');
  } finally {
    k.done();
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

test('close: the channel gets a closing notice with the delay before it is deleted', async () => {
  const dir = tmpDir();
  try {
    const cfg = { ...CFG, tickets: { ...CFG.tickets, deleteDelayMs: 1000 } };
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), cfg);
    const g = mkGuild();
    const r = await svc.createTicket(g, m('U1'));
    await svc.closeTicket(r.channel, { id: 'S', username: 'staff', tag: 'staff' });
    const notice = r.channel.sent.find((p) => p.embeds && /closed by/.test(p.embeds[0].toJSON().description || ''));
    assert.ok(notice, 'a closing notice was posted');
    const body = notice.embeds[0].toJSON();
    assert.equal(body.color, 0xf1c40f);
    assert.equal(
      body.description,
      'Ticket closed by <@S>.\nSaving the transcript. This channel will be deleted in **1 second**.',
    );
  } finally {
    rm(dir);
  }
});

// ---------- command replies ----------

/** Just enough of a slash command or button interaction to see what the bot answers with. */
function fakeInteraction(over = {}) {
  const sent = { replies: [], edits: [], follow: [], updates: [], defer: null };
  const i = {
    _sent: sent,
    deferred: false,
    replied: false,
    guildId: 'G',
    channelId: 'C',
    channel: { id: 'C' },
    commandName: 'add',
    customId: '',
    user: { id: 'U1', username: 'U1', tag: 'U1' },
    member: m('U1'),
    inGuild: () => true,
    options: { getUser: () => null, getRole: () => null },
    reply: async (p) => {
      sent.replies.push(p);
      i.replied = true;
    },
    deferReply: async (p) => {
      sent.defer = p;
      i.deferred = true;
    },
    editReply: async (p) => {
      sent.edits.push(p);
    },
    update: async (p) => {
      sent.updates.push(p);
      i.replied = true;
    },
    followUp: async (p) => {
      sent.follow.push(p);
    },
    ...over,
  };
  return i;
}

const cardOf = (payload) => payload.embeds[0].toJSON();
/** The house style keeps replies plain: no emoji, no exclamation marks, no dashes as punctuation. */
function assertPlain(text) {
  assert.ok(!/\p{Extended_Pictographic}/u.test(text), `emoji in: ${text}`);
  assert.ok(!/[!–—]/.test(text), `exclamation mark or dash in: ${text}`);
}
const STAFF = { id: 'MGR' };

test('command descriptions follow the house format', () => {
  const list = [
    [verify, 'Post the verification panel with a ticket button (staff only)'],
    [ticketClose, 'Close the current ticket and save the transcript'],
    [ticketAdd, 'Add a member or role to the current ticket (staff only)'],
  ];
  for (const [cmd, text] of list) {
    const json = cmd.data.toJSON();
    assert.equal(json.description, text);
    assert.ok(json.description.length <= 100);
    assert.ok(!json.description.endsWith('.'));
    for (const o of json.options || []) assert.ok(o.description.length <= 100 && !o.description.endsWith('.'));
  }
  assert.deepEqual(verify.data.toJSON().options.map((o) => o.name), ['staff']);
  assert.deepEqual(ticketAdd.data.toJSON().options.map((o) => o.name), ['user', 'role']);
});

test('open flow: a green card when the ticket is created, an amber card when nothing was done', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const g = mkGuild();
    const ctx = { tickets: svc, isBypass: () => false };
    const open = async (id) => {
      const i = fakeInteraction({ guild: g, member: m(id), user: { id, username: id, tag: id } });
      await openTicketFlow(i, ctx);
      return i;
    };

    const first = await open('U1');
    assert.equal(first._sent.defer.flags, MessageFlags.Ephemeral);
    const made = cardOf(first._sent.edits[0]);
    const channel = [...g._store.values()].find((c) => c.name === 'ticket-0001');
    assert.equal(made.color, COLORS.ok);
    assert.equal(made.description, `Your ticket is open: <#${channel.id}>`);
    assertPlain(made.description);

    const again = cardOf((await open('U1'))._sent.edits[0]);
    assert.equal(again.color, COLORS.warn);
    assert.equal(again.description, `You already have an open ticket: <#${channel.id}>`);

    svc._guild('G').users.U2 = { lastClosedAt: Date.now() };
    const wait = cardOf((await open('U2'))._sent.edits[0]);
    assert.equal(wait.color, COLORS.warn);
    assert.match(wait.description, /^You can open a new ticket in \*\*(\d+m )?\d+s\*\*\.$/);
    assertPlain(wait.description);

    // a second click while the first is still being created
    svc.creating.add('U3');
    const busy = cardOf((await open('U3'))._sent.edits[0]);
    assert.equal(busy.color, COLORS.warn);
    assert.equal(busy.description, 'Your ticket is already being created. Wait a moment.');
  } finally {
    rm(dir);
  }
});

test('open flow: refusals and failures are red cards with a next step', async () => {
  const outside = fakeInteraction({ inGuild: () => false });
  await openTicketFlow(outside, { tickets: {}, isBypass: () => false });
  assert.equal(outside._sent.replies[0].flags, MessageFlags.Ephemeral);
  const a = cardOf(outside._sent.replies[0]);
  assert.equal(a.color, COLORS.danger);
  assert.equal(a.description, 'Tickets can only be opened inside a server.');

  const boom = fakeInteraction({ guild: mkGuild() });
  const quiet = console.error;
  console.error = () => {};
  try {
    await openTicketFlow(boom, {
      tickets: {
        createTicket: async () => {
          throw new Error('nope');
        },
      },
      isBypass: () => false,
    });
  } finally {
    console.error = quiet;
  }
  const b = cardOf(boom._sent.edits[0]);
  assert.equal(b.color, COLORS.danger);
  assert.equal(
    b.description,
    'Could not create your ticket. Check that the bot has the Manage Channels and Manage Roles permissions, then try again.',
  );
  assertPlain(b.description);

  const odd = fakeInteraction({ guild: mkGuild() });
  await openTicketFlow(odd, { tickets: { createTicket: async () => ({ ok: false, reason: 'weird' }) }, isBypass: () => false });
  const c = cardOf(odd._sent.edits[0]);
  assert.equal(c.color, COLORS.danger);
  assert.equal(c.description, 'Something went wrong. Try again in a moment.');
});

test('requireTicket and requireStaff answer with a card and return a falsy value', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const ctx = { tickets: svc };

    const dm = fakeInteraction({ inGuild: () => false });
    assert.equal(await requireTicket(dm, ctx), null);
    assert.equal(cardOf(dm._sent.replies[0]).color, COLORS.warn);
    assert.equal(cardOf(dm._sent.replies[0]).description, 'This command only works inside a ticket channel.');

    const plain = fakeInteraction();
    assert.equal(await requireTicket(plain, ctx), null);
    assert.equal(plain._sent.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(cardOf(plain._sent.replies[0]).description, 'This is not a ticket channel. Run the command inside a ticket.');

    svc._guild('G').tickets.C = { number: 1, userId: 'U1', status: 'open' };
    assert.equal((await requireTicket(fakeInteraction(), ctx)).number, 1);

    const nope = fakeInteraction();
    assert.equal(await requireStaff(nope, ctx), false);
    const denied = cardOf(nope._sent.replies[0]);
    assert.equal(denied.color, COLORS.danger);
    assert.equal(denied.description, 'Only staff can use /add.');
    assert.equal(await requireStaff(fakeInteraction({ member: STAFF }), ctx), true);
  } finally {
    rm(dir);
  }
});

test('/add: staff only, public green reply that still pings, refunds the cooldown when nothing changed', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    svc._guild('G').tickets.C = { number: 1, userId: 'U1', status: 'open' };
    const edits = [];
    const channel = { id: 'C', permissionOverwrites: { edit: async (id) => edits.push(id) }, guild: { id: 'G', members: {} } };
    let refunds = 0;
    const ctx = { tickets: svc, refundCooldown: () => (refunds += 1) };
    const withOptions = (over) =>
      fakeInteraction({ channel, options: { getUser: () => null, getRole: () => null, ...over.options }, ...over.rest });

    // not staff
    const a = withOptions({ rest: { member: m('U1') } });
    await ticketAdd.execute(a, ctx);
    assert.equal(cardOf(a._sent.replies[0]).color, COLORS.danger);
    assert.equal(cardOf(a._sent.replies[0]).description, 'Only staff can use /add.');
    assert.equal(refunds, 1);

    // staff, nothing picked
    const b = withOptions({ rest: { member: STAFF } });
    await ticketAdd.execute(b, ctx);
    assert.equal(cardOf(b._sent.replies[0]).color, COLORS.warn);
    assert.equal(cardOf(b._sent.replies[0]).description, 'Pick a member or a role to add.');
    assert.equal(refunds, 2);

    // staff adds a member: public reply, mention in the content, green card
    const c = withOptions({ rest: { member: STAFF }, options: { getUser: () => ({ id: 'U9' }) } });
    await ticketAdd.execute(c, ctx);
    const reply = c._sent.replies[0];
    assert.equal(reply.flags, undefined);
    assert.equal(reply.content, '<@U9>');
    assert.equal(cardOf(reply).color, COLORS.ok);
    assert.equal(cardOf(reply).description, 'Added to this ticket.');
    assert.deepEqual(edits, ['U9']);
    assert.equal(refunds, 2);

    // a role
    const d = withOptions({ rest: { member: STAFF }, options: { getRole: () => ({ id: 'R1' }) } });
    await ticketAdd.execute(d, ctx);
    assert.equal(d._sent.replies[0].content, '<@&R1>');

    // Discord refuses
    channel.permissionOverwrites.edit = async () => {
      throw new Error('Missing Permissions');
    };
    const e = withOptions({ rest: { member: STAFF }, options: { getUser: () => ({ id: 'U9' }) } });
    await ticketAdd.execute(e, ctx);
    const failed = cardOf(e._sent.replies[0]);
    assert.equal(failed.color, COLORS.danger);
    assert.equal(
      failed.description,
      'Could not add them to this ticket (Missing Permissions). Check that the bot can manage this channel, then try again.',
    );
    assertPlain(failed.description);
    assert.equal(refunds, 3);
  } finally {
    rm(dir);
  }
});

test('/close: refusals are cards and refund the cooldown, a valid close answers privately then closes', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const g = mkGuild();
    const r = await svc.createTicket(g, m('U1'));
    let refunds = 0;
    const ctx = { tickets: svc, refundCooldown: () => (refunds += 1) };
    const at = (over) => fakeInteraction({ guildId: 'G', channelId: r.channel.id, channel: r.channel, ...over });

    const stranger = at({ user: { id: 'U2', username: 'U2', tag: 'U2' }, member: m('U2') });
    await ticketClose.execute(stranger, ctx);
    const denied = cardOf(stranger._sent.replies[0]);
    assert.equal(denied.color, COLORS.danger);
    assert.equal(denied.description, 'Only the ticket opener or staff can close this ticket.');
    assert.equal(refunds, 1);

    svc.get('G', r.channel.id).status = 'closed';
    const late = at({ member: m('U1') });
    await ticketClose.execute(late, ctx);
    assert.equal(cardOf(late._sent.replies[0]).color, COLORS.warn);
    assert.equal(cardOf(late._sent.replies[0]).description, 'This ticket is already being closed.');
    assert.equal(refunds, 2);
    svc.get('G', r.channel.id).status = 'open';

    const elsewhere = fakeInteraction({ channelId: 'other', channel: {} });
    await ticketClose.execute(elsewhere, ctx);
    assert.equal(cardOf(elsewhere._sent.replies[0]).color, COLORS.warn);
    assert.equal(refunds, 3);

    const opener = at({ member: m('U1') });
    await ticketClose.execute(opener, ctx);
    assert.equal(opener._sent.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(cardOf(opener._sent.replies[0]).description, 'Closing this ticket and saving the transcript.');
    assert.equal(r.channel.deleted, true);
    assert.equal(refunds, 3);
  } finally {
    rm(dir);
  }
});

test('/v: staff only, posts the panel untouched and confirms in green', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    let refunds = 0;
    const ctx = { tickets: svc, refundCooldown: () => (refunds += 1) };
    const posted = [];
    const channel = { send: async (p) => posted.push(p) };

    const blocked = fakeInteraction({ commandName: 'v', channel, options: { getRole: () => null } });
    await verify.execute(blocked, ctx);
    assert.equal(cardOf(blocked._sent.replies[0]).color, COLORS.danger);
    assert.equal(cardOf(blocked._sent.replies[0]).description, 'Only staff can use /v.');
    assert.equal(refunds, 1);
    assert.equal(posted.length, 0);

    const plain = fakeInteraction({ commandName: 'v', channel, member: STAFF, options: { getRole: () => null } });
    await verify.execute(plain, ctx);
    assert.equal(posted.length, 1);
    const panel = posted[0].embeds[0].toJSON();
    assert.equal(panel.title, '35xw verification');
    assert.equal(panel.description, 'Open a ticket to get access to the server.');
    assert.equal(posted[0].components[0].toJSON().components[0].label, 'OPEN TICKET');
    assert.equal(plain._sent.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(cardOf(plain._sent.replies[0]).color, COLORS.ok);
    assert.equal(cardOf(plain._sent.replies[0]).description, 'Verification panel posted.');

    const withRole = fakeInteraction({ commandName: 'v', channel, member: STAFF, guildId: 'G', options: { getRole: () => ({ id: 'R7' }) } });
    await verify.execute(withRole, ctx);
    assert.equal(cardOf(withRole._sent.replies[0]).description, 'Verification panel posted. Staff role set to <@&R7>.');
    assert.equal(svc.getStaffRole('G'), 'R7');
    assert.equal(refunds, 1);
  } finally {
    rm(dir);
  }
});

test('tk:close button: denial and already-closing answers are cards, the private notice uses a follow-up', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const g = mkGuild();
    const r = await svc.createTicket(g, m('U1'));
    const ctx = { tickets: svc, refundCooldown() {} };
    const press = (over) =>
      fakeInteraction({ customId: 'tk:close', guildId: 'G', channelId: r.channel.id, channel: r.channel, ...over });

    const stranger = press({ user: { id: 'U2', username: 'U2', tag: 'U2' }, member: m('U2') });
    await verify.handleButton(stranger, ctx);
    assert.equal(cardOf(stranger._sent.replies[0]).color, COLORS.danger);
    assert.equal(cardOf(stranger._sent.replies[0]).description, 'Only the ticket opener or staff can close this ticket.');
    assert.equal(stranger._sent.updates.length, 0);

    svc.get('G', r.channel.id).status = 'closed';
    const late = press({ member: m('U1') });
    await verify.handleButton(late, ctx);
    assert.equal(cardOf(late._sent.replies[0]).color, COLORS.warn);
    assert.equal(cardOf(late._sent.replies[0]).description, 'This ticket is already being closed.');
    svc.get('G', r.channel.id).status = 'open';

    // a close that is already running: the button was answered by update(), so the notice is a follow-up
    svc.closing.add(r.channel.id);
    const twice = press({ member: m('U1') });
    await verify.handleButton(twice, ctx);
    assert.deepEqual(twice._sent.updates, [{ components: [] }]);
    assert.equal(twice._sent.replies.length, 0);
    assert.equal(twice._sent.follow[0].flags, MessageFlags.Ephemeral);
    assert.equal(cardOf(twice._sent.follow[0]).color, COLORS.warn);
    assert.equal(cardOf(twice._sent.follow[0]).description, 'This ticket is already being closed.');
  } finally {
    rm(dir);
  }
});

// ---------- online transcript link ----------

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
const imageReply = (size = 8) => ({
  ok: true,
  status: 200,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
  body: (async function* () {
    yield size === 8 ? PNG_BYTES : Buffer.alloc(size, 7);
  })(),
});

async function closeWith({ host, mediaFetch, media, dm }) {
  const dir = tmpDir();
  const svc = new TicketService(new Storage(path.join(dir, 'db.json')), { ...CFG, tickets: { ...CFG.tickets, ...(media ? { media } : {}) } });
  if (host) svc.host = host;
  if (mediaFetch) svc.mediaFetch = mediaFetch;
  const problems = [];
  svc.onProblem = (guild, text, title) => problems.push({ text, title });
  const g = mkGuild();
  const dms = [];
  g.client = { users: { send: dm || (async (id, payload) => dms.push({ id, payload })) } };
  const r = await svc.createTicket(g, m('U2'));
  r.channel._history = [
    {
      id: 'a',
      createdTimestamp: 1000,
      author: { id: 'U2', username: 'U2', tag: 'U2', avatar: 'https://cdn.discordapp.com/avatars/2/a.png' },
      content: 'proof',
      attachments: new Map([['x', { name: 'proof.png', url: 'https://cdn.discordapp.com/attachments/1/proof.png', contentType: 'image/png', size: 8 }]]),
      embeds: [],
    },
  ];
  const res = await svc.closeTicket(r.channel, { id: 'S', username: 'staff', tag: 'staff' });
  const post = [...g._store.values()].find((c) => c.name === 'transcripts').sent[0];
  return { res, post, problems, dir, dms };
}

/** A stand-in for TranscriptHost#session that records what is stored. */
function fakeHost({ failPage = false } = {}) {
  const stored = { page: null, files: [] };
  const base = 'https://pub.example/t/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
  return {
    stored,
    enabled: () => true,
    session: () => ({
      token: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
      pageUrl: `${base}/index.html`,
      putFile: async (name, buf) => (stored.files.push({ name, bytes: buf.length }), `${base}/files/${stored.files.length}-${name}`),
      putPage: async (html) => {
        if (failPage) throw new Error('upload failed (HTTP 403 AccessDenied)');
        stored.page = html;
        return `${base}/index.html`;
      },
    }),
  };
}

test('close: with a host the transcript message gets a View transcript button, the file keeps its pictures', async () => {
  const host = fakeHost();
  const { res, post, dir } = await closeWith({ host, mediaFetch: async () => imageReply() });
  try {
    assert.equal(res.ok, true);
    assert.equal(res.url, 'https://pub.example/t/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/index.html');
    const button = post.components[0].toJSON().components[0];
    assert.equal(button.style, 5); // link button
    assert.equal(button.label, 'View transcript');
    assert.equal(button.url, res.url);
    const attached = Buffer.from(post.files[0].attachment).toString();
    assert.equal(post.files[0].name, 'transcript-0001.html');
    assert.ok(attached.includes('data:image/png;base64,'), 'pictures are inside the file');
    assert.equal(host.stored.page, attached, 'the online page and the file are the same page');
    assert.equal(post.embeds[0].toJSON().description, undefined);
  } finally {
    rm(dir);
  }
});

test('close: without a host there is no button, and a failed upload still leaves the file and tells the log', async () => {
  const plain = await closeWith({ mediaFetch: async () => imageReply() });
  try {
    assert.equal(plain.post.components, undefined);
    assert.ok(plain.post.files[0]);
    assert.equal(plain.post.embeds[0].toJSON().description, undefined);
  } finally {
    rm(plain.dir);
  }

  const broken = await closeWith({ host: fakeHost({ failPage: true }), mediaFetch: async () => imageReply() });
  try {
    assert.equal(broken.res.ok, true, 'the ticket still closes');
    assert.equal(broken.post.components, undefined);
    assert.ok(broken.post.files[0]);
    assert.equal(broken.problems[0].title, 'Transcript link failed');
    assert.match(broken.problems[0].text, /AccessDenied/);
  } finally {
    rm(broken.dir);
  }
});

test('close: a page too big for Discord is link only with a host, and loses its pictures without one', async () => {
  const media = { budgetBytes: 30 * 1024 * 1024, maxFileBytes: 9 * 1024 * 1024, embedImageMax: 20 * 1024 * 1024 };
  const big = async () => imageReply(9 * 1024 * 1024 - 100);

  const withHost = await closeWith({ host: fakeHost(), mediaFetch: big, media });
  try {
    assert.equal(withHost.post.files, undefined, 'too large to attach');
    assert.ok(withHost.post.components[0]);
    assert.equal(withHost.post.embeds[0].toJSON().footer, undefined);
  } finally {
    rm(withHost.dir);
  }

  const without = await closeWith({ mediaFetch: big, media });
  try {
    const file = Buffer.from(without.post.files[0].attachment).toString();
    assert.ok(file.length < 1_000_000, 'rebuilt without the pictures so it can be posted');
    assert.ok(!file.includes('data:image/png'));
    assert.ok(file.includes('Preview not available'), 'the picture is still reachable through its link');
    assert.ok(file.includes('Open original'));
  } finally {
    rm(without.dir);
  }
});

test('close: a big picture is shown reduced and its original is kept online for the Download button', async () => {
  const host = fakeHost();
  const asked = [];
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    svc.host = host;
    svc.mediaFetch = async (url) => (asked.push(url), imageReply());
    const g = mkGuild();
    const r = await svc.createTicket(g, m('U2'));
    r.channel._history = [
      {
        id: 'a',
        createdTimestamp: 1000,
        author: { id: 'U2', username: 'U2', tag: 'U2' },
        content: 'screenshot',
        attachments: new Map([
          ['x', { name: 'huge.png', url: 'https://cdn.discordapp.com/attachments/1/huge.png', proxyURL: 'https://media.discordapp.net/attachments/1/huge.png?ex=1&is=2&hm=3', contentType: 'image/png', size: 6 * 1024 * 1024, width: 4000, height: 3000 }],
          ['y', { name: 'notes.pdf', url: 'https://cdn.discordapp.com/attachments/1/notes.pdf', contentType: 'application/pdf', size: 3 * 1024 * 1024 }],
        ]),
        embeds: [],
      },
    ];
    await svc.closeTicket(r.channel, { id: 'S', username: 'staff', tag: 'staff' });
    const html = host.stored.page;
    assert.ok(asked.some((u) => u.startsWith('https://media.discordapp.net/attachments/1/huge.png') && u.includes('width=1600') && u.includes('height=1200') && u.includes('format=webp')), 'the reduced copy was asked for');
    assert.ok(html.includes('reduced preview, click to enlarge'));
    assert.ok(host.stored.files.some((f) => f.name === 'huge.png'), 'the original picture is kept online');
    assert.ok(host.stored.files.some((f) => f.name === 'notes.pdf'), 'so is the document that was too big for the page');
    assert.ok(html.includes('Download original'));
    assert.ok(html.includes('https://pub.example/t/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/files/1-huge.png'));
  } finally {
    rm(dir);
  }
});

// ---------- alerts ----------

function alertKit({ notify = {}, config = {} } = {}) {
  const dir = tmpDir();
  const cfg = { ...CFG, ...config, tickets: { ...CFG.tickets, notify: { userId: 'OWNER', channelId: 'NEWS', roleIds: ['R1'], ...notify } } };
  const svc = new TicketService(new Storage(path.join(dir, 'db.json')), cfg);
  const g = mkGuild('G');
  g.ownerId = 'SOMEONE';
  g.roles.cache = new Map([['R1', { id: 'R1', mentionable: true }]]);
  g.members.me = { id: 'BOT', permissions: { has: () => true } };
  g.client = { users: { send: async () => ({}) } };
  const problems = [];
  svc.onProblem = (guild, text, title) => problems.push({ text, title });
  return { svc, g, problems, done: () => rm(dir) };
}

test('alerts: a server counts as the owner server by its staff channel, its owner or GUILD_ID', () => {
  const k = alertKit();
  try {
    assert.equal(k.svc._isHome(k.g), false);
    k.g.ownerId = 'OWNER';
    assert.equal(k.svc._isHome(k.g), true);
    k.g.ownerId = 'SOMEONE';
    k.g._store.set('NEWS', { id: 'NEWS', name: 'staff-news', send: async () => {} });
    assert.equal(k.svc._isHome(k.g), true);
    k.g._store.delete('NEWS');
    k.svc.config.guildId = 'G';
    assert.equal(k.svc._isHome(k.g), true, 'a server named in GUILD_ID is the owner server even if the staff channel is gone');
  } finally {
    k.done();
  }
});

test('alerts: what is wrong is named, and other servers report nothing', () => {
  const k = alertKit({ config: { guildId: 'G' } });
  try {
    k.g.roles.cache = new Map([['R1', { id: 'R1', mentionable: false }]]);
    k.g.members.me.permissions.has = () => false;
    const out = k.svc.alertProblems(k.g);
    assert.ok(out.some((t) => /staff channel .*was not found/.test(t)));
    assert.ok(out.some((t) => /cannot be pinged/.test(t)));

    k.g._store.set('NEWS', { id: 'NEWS', send: async () => {}, permissionsFor: () => ({ has: () => false }) });
    assert.ok(k.svc.alertProblems(k.g).some((t) => /missing View Channel, Send Messages, Embed Links/.test(t)));

    k.g.roles.cache = new Map();
    assert.ok(k.svc.alertProblems(k.g).some((t) => /does not exist on this server/.test(t)));

    const other = mkGuild('H');
    other.ownerId = 'X';
    assert.deepEqual(k.svc.alertProblems(other), []);
  } finally {
    k.done();
  }
});

test('alerts: a test sends without pinging, reports each part and explains a blocked DM', async () => {
  const k = alertKit({ notify: { roleIds: ['R1', 'R2'] } });
  try {
    const sent = [];
    k.g._store.set('NEWS', { id: 'NEWS', name: 'staff-news', send: async (p) => sent.push(p) });
    k.g.roles.cache.set('R2', { id: 'R2', mentionable: true });
    k.g.client.users.send = async () => {
      const err = new Error('Cannot send messages to this user');
      err.code = 50007;
      throw err;
    };
    const report = await k.svc.notifyOpened(k.g, m('U1'), { id: 'C1' }, 0, { test: true });
    assert.equal(report.staff.ok, true);
    assert.equal(report.dm.ok, false);
    assert.match(report.dm.error, /allow direct messages from server members/);
    assert.deepEqual(sent[0].allowedMentions, { roles: [], users: [] }, 'a test pings nobody');
    assert.equal(sent[0].content, '<@&R1> <@&R2>', 'but shows who would be pinged');
    assert.equal(sent[0].embeds[0].toJSON().title, 'Test ticket alert');
    assert.deepEqual(report.roles, ['R1', 'R2']);
    assert.equal(k.problems.length, 1, 'the failure also goes to the server log');

    k.g._store.get('NEWS').send = async () => {
      const err = new Error('Missing Access');
      err.code = 50001;
      throw err;
    };
    const again = await k.svc.notifyOpened(k.g, m('U1'), { id: 'C1' }, 0, { test: true });
    assert.match(again.staff.error, /not allowed to post in <#NEWS>.*View Channel, Send Messages and Embed Links/);
  } finally {
    k.done();
  }
});

test('alerts: another server is skipped quietly', async () => {
  const k = alertKit();
  try {
    const report = await k.svc.notifyOpened(k.g, m('U1'), { id: 'C1' }, 3);
    assert.equal(report.skipped, 'not the owner server');
    assert.equal(k.problems.length, 0);
  } finally {
    k.done();
  }
});

// ---------- the opener gets the transcript too ----------

test('close: the person who opened the ticket gets literally the same message by DM', async () => {
  const host = fakeHost();
  const { post, dms, res, dir } = await closeWith({ host, mediaFetch: async () => imageReply() });
  try {
    assert.equal(res.ok, true);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].id, 'U2', 'the opener, not the person who closed it');
    const sent = dms[0].payload;
    assert.deepEqual(sent.embeds[0].toJSON(), post.embeds[0].toJSON(), 'same card');
    assert.equal(sent.files[0].name, post.files[0].name);
    assert.deepEqual(Buffer.from(sent.files[0].attachment), Buffer.from(post.files[0].attachment), 'same file, byte for byte');
    assert.deepEqual(sent.components[0].toJSON(), post.components[0].toJSON(), 'same View transcript button');
    assert.notEqual(sent.files[0], post.files[0], 'two separate file objects');
    assert.deepEqual(res.dm, { ok: true });
  } finally {
    rm(dir);
  }
});

test('close: without an online link the DM still carries the file, exactly like the channel message', async () => {
  const { post, dms, dir } = await closeWith({ mediaFetch: async () => imageReply() });
  try {
    assert.equal(dms.length, 1);
    assert.equal(dms[0].payload.components, undefined);
    assert.deepEqual(Buffer.from(dms[0].payload.files[0].attachment), Buffer.from(post.files[0].attachment));
  } finally {
    rm(dir);
  }
});

test('close: a member with closed DMs still gets their ticket closed, and the server log says who did not get it', async () => {
  const blocked = async () => {
    throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
  };
  const { res, post, problems, dir } = await closeWith({ dm: blocked });
  try {
    assert.equal(res.ok, true, 'the ticket closes anyway');
    assert.ok(post.files[0], 'the channel copy is there');
    assert.equal(res.dm.ok, false);
    assert.equal(problems[0].title, 'Transcript not delivered');
    assert.match(problems[0].text, /<@U2>.*direct messages from server members turned off/);
  } finally {
    rm(dir);
  }
});

test('close: if the channel copy cannot be saved nothing is sent to the opener, so a retry never sends it twice', async () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const g = mkGuild();
    const dms = [];
    g.client = { users: { send: async (id, p) => dms.push({ id, p }) } };
    const r = await svc.createTicket(g, m('U2'));
    const tr = await svc.ensureTranscriptChannel(g);
    tr.send = async () => {
      throw new Error('Missing Access');
    };
    const res = await svc.closeTicket(r.channel, { id: 'S', username: 'staff', tag: 'staff' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'transcript_failed');
    assert.equal(dms.length, 0);
    assert.equal(r.channel.deleted, false, 'the ticket is kept');
  } finally {
    rm(dir);
  }
});
