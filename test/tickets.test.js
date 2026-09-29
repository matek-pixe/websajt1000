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
    assert.ok(html.includes('🎫 ticket-0002'));
    assert.ok(html.indexOf('help &lt;b&gt;me&lt;/b&gt;') < html.indexOf('hello'), 'oldest first, escaped');
    const embed = post.embeds[0].toJSON();
    const field = (n) => embed.fields.find((f) => f.name === n).value;
    assert.equal(field('Ticket'), 'ticket-0002');
    assert.equal(field('Opened by'), '<@U2>');
    assert.equal(field('Closed by'), '<@S>');
    assert.equal(field('Messages'), '2');
    assert.equal(embed.title, '📄 Transcript for ticket-0002');
    assert.equal(embed.footer.text, '35xw · tickets');

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
