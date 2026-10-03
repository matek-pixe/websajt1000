'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const sos = require('../src/commands/sos');
const lock = require('../src/commands/lock');
const unlock = require('../src/commands/unlock');
const { refusal } = require('../src/gates');
const { commands } = require('../src/commands');
const { G, VIEW, SEND, ADMIN, ow, kit, typical } = require('./fakeServer');

/** The pieces of an interaction these commands touch. */
function fakeInteraction(k, { user = 'OWNER', sub = null, options = {}, customId = null, channel = null } = {}) {
  const log = { replies: [], updates: [], dms: [], sent: [], deleted: false };
  const i = {
    guild: k.server.guild,
    guildId: G,
    user: { id: user, send: async (p) => log.dms.push(p) },
    channel,
    customId,
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => sub,
      getBoolean: (n) => options[n] ?? null,
      getAttachment: (n) => options[n] ?? null,
    },
    deferReply: async () => { i.deferred = true; },
    editReply: async (p) => log.replies.push(p),
    reply: async (p) => { i.replied = true; log.replies.push(p); },
    update: async (p) => log.updates.push(p),
    deleteReply: async () => { log.deleted = true; },
  };
  return { i, log };
}
const ctxFor = (k, over = {}) => {
  const held = { n: 0, released: 0 };
  const posted = [];
  return {
    held,
    posted,
    ctx: {
      lockdown: k.svc,
      isOwnerOrManager: () => true,
      isManager: () => false,
      refundCooldown: () => { held.refunds = (held.refunds || 0) + 1; },
      logs: { hold: () => { held.n += 1; return () => { held.released += 1; }; }, post: (g, e) => posted.push(e.toJSON()) },
      ...over,
    },
  };
};
const embed = (p) => p.embeds[0].toJSON();
const fieldOf = (e, name) => (e.fields.find((f) => f.name === name) || {}).value;

test('/sos start: shows a preview with the scan file and two buttons, and changes nothing', async () => {
  const k = kit(typical());
  try {
    const before = k.server.dump();
    const { i, log } = fakeInteraction(k, { sub: 'start' });
    const { ctx } = ctxFor(k);
    await sos.execute(i, ctx);
    const p = log.replies[0];
    const e = embed(p);
    assert.equal(e.title, 'SOS preview');
    assert.match(e.description, /Nothing has changed yet/);
    assert.match(fieldOf(e, 'Channels'), /7 \(.*\)\. \d+ visible to everyone today, \d+ restricted\./);
    assert.match(fieldOf(e, 'Administrator roles'), /Admin/);
    assert.match(fieldOf(e, 'Cannot be hidden from'), /Head admin: above my highest role/);
    assert.match(fieldOf(e, 'Still sees everything'), /<@OWNER>.*<@MGR>.*this bot/);
    assert.equal(p.files[0].name, 'sos-scan.txt');
    assert.match(Buffer.from(p.files[0].attachment).toString(), /SOS scan of Test Server/);
    const ids = p.components[0].toJSON().components.map((c) => c.custom_id);
    assert.match(ids[0], /^sos:go:/);
    assert.match(ids[1], /^sos:no:/);
    assert.deepEqual(k.server.dump(), before);
    assert.equal(k.svc.isActive(G), false);
  } finally {
    k.done();
  }
});

test('/sos start: Cancel changes nothing, a stranger or an old preview cannot start it', async () => {
  const k = kit(typical());
  try {
    const before = k.server.dump();
    const first = fakeInteraction(k, { sub: 'start' });
    const { ctx } = ctxFor(k);
    await sos.execute(first.i, ctx);
    const [goId, noId] = first.log.replies[0].components[0].toJSON().components.map((c) => c.custom_id);

    const cancel = fakeInteraction(k, { customId: noId });
    await sos.handleButton(cancel.i, ctx);
    assert.equal(embed(cancel.log.updates[0]).title, 'Cancelled');
    assert.deepEqual(k.server.dump(), before);

    // the same token cannot be used after it was cancelled
    const late = fakeInteraction(k, { customId: goId });
    await sos.handleButton(late.i, ctx);
    assert.equal(embed(late.log.updates[0]).title, 'Preview expired');

    // a different person cannot press somebody else's button
    const second = fakeInteraction(k, { sub: 'start' });
    await sos.execute(second.i, ctx);
    const goId2 = second.log.replies[0].components[0].toJSON().components[0].custom_id;
    const stranger = fakeInteraction(k, { customId: goId2, user: 'SOMEONE' });
    await sos.handleButton(stranger.i, ctx);
    assert.equal(embed(stranger.log.updates[0]).title, 'Preview expired');
    assert.deepEqual(k.server.dump(), before);

    // and a button from a non-owner is refused outright
    const notOwner = fakeInteraction(k, { customId: goId2, user: 'SOMEONE' });
    await sos.handleButton(notOwner.i, { ...ctx, isOwnerOrManager: () => false });
    assert.match(embed(notOwner.log.replies[0]).description, /Only the server owner can use \/sos/);
  } finally {
    k.done();
  }
});

test('/sos start then Start SOS: hides everything, sends the saved copy by DM, writes one log line and releases the log', async () => {
  const k = kit(typical());
  try {
    const original = k.server.dump();
    const first = fakeInteraction(k, { sub: 'start' });
    const { ctx, held, posted } = ctxFor(k);
    await sos.execute(first.i, ctx);
    const goId = first.log.replies[0].components[0].toJSON().components[0].custom_id;

    const go = fakeInteraction(k, { customId: goId });
    await sos.handleButton(go.i, ctx);
    assert.equal(embed(go.log.updates[0]).title, 'Saving the server and hiding every channel');
    const done = embed(go.log.replies[go.log.replies.length - 1]);
    assert.equal(done.title, 'SOS is on');
    assert.match(fieldOf(done, 'Channels hidden'), /^7 of 7|^\d+ of \d+/);
    assert.match(done.description, /<@OWNER> and <@MGR>/);
    assert.equal(k.svc.isActive(G), true);
    assert.equal(k.server.canSee('PLAIN', 'chat'), false);
    assert.equal(k.server.canSee('OWNER', 'chat'), true);
    assert.equal(held.n, 1, 'the log was muted while it ran');
    assert.equal(held.released, 1);
    assert.equal(posted[0].title, 'SOS started');

    // a copy outside the server and outside the bot's disk
    assert.equal(go.log.dms.length, 1);
    assert.match(go.log.dms[0].files[0].name, /^sos-100-\d{8}-\d{6}\.json$/);
    const copy = JSON.parse(Buffer.from(go.log.dms[0].files[0].attachment).toString());
    assert.equal(copy.kind, '35xw-sos');
    assert.equal(copy.snapshot.channels.length, 7);

    // status
    const st = fakeInteraction(k, { sub: 'status' });
    await sos.execute(st.i, ctx);
    assert.equal(embed(st.log.replies[0]).title, 'SOS is on');

    // start again is refused
    const again = fakeInteraction(k, { sub: 'start' });
    await sos.execute(again.i, ctx);
    assert.match(embed(again.log.replies[0]).description, /already on/);

    // end
    const end = fakeInteraction(k, { sub: 'end' });
    await sos.execute(end.i, ctx);
    const endCard = embed(end.log.replies[end.log.replies.length - 1]);
    assert.equal(endCard.title, 'Everything is back');
    assert.match(endCard.description, /They are identical/);
    assert.deepEqual(k.server.dump(), original);
    assert.equal(posted[1].title, 'SOS ended');
    assert.equal(held.released, 2);

    const off = fakeInteraction(k, { sub: 'status' });
    await sos.execute(off.i, ctx);
    assert.equal(embed(off.log.replies[0]).title, 'SOS is off');
  } finally {
    k.done();
  }
});

test('/sos end: nothing to end, and a backup file is checked before it is trusted', async () => {
  const k = kit(typical());
  try {
    const { ctx } = ctxFor(k);
    const none = fakeInteraction(k, { sub: 'end' });
    await sos.execute(none.i, ctx);
    assert.match(embed(none.log.replies[0]).description, /SOS is not on/);

    const bad = async (attachment, text) => {
      const x = fakeInteraction(k, { sub: 'end', options: { backup: attachment } });
      await sos.execute(x.i, ctx);
      assert.match(embed(x.log.replies[0]).description, text);
    };
    await bad({ name: 'notes.txt', size: 10, url: 'https://cdn.discordapp.com/a/notes.txt' }, /\.json file I sent you/);
    await bad({ name: 'b.json', size: 50 * 1024 * 1024, url: 'https://cdn.discordapp.com/a/b.json' }, /too large/);
    await bad({ name: 'b.json', size: 10, url: 'https://evil.example/b.json' }, /only read attachments from Discord/);
  } finally {
    k.done();
  }
});

test('/sos end with a backup file restores a server whose database was lost', async () => {
  const k = kit(typical());
  const realFetch = globalThis.fetch;
  try {
    const original = k.server.dump();
    const res = await k.svc.start(k.server.guild, await k.svc.scan(k.server.guild), 'OWNER');
    const text = fs.readFileSync(res.backupFile, 'utf8');
    k.svc._sos()[G] = undefined; // the host lost the database
    delete k.svc._sos()[G];
    globalThis.fetch = async () => ({ ok: true, text: async () => text });

    const { ctx } = ctxFor(k);
    const x = fakeInteraction(k, { sub: 'end', options: { backup: { name: 'sos-100.json', size: text.length, url: 'https://cdn.discordapp.com/attachments/1/sos-100.json' } } });
    await sos.execute(x.i, ctx);
    assert.equal(embed(x.log.replies[x.log.replies.length - 1]).title, 'Everything is back');
    assert.deepEqual(k.server.dump(), original);

    // the file of another server is refused
    const other = { name: 'x.json', size: 10, url: 'https://cdn.discordapp.com/a/x.json' };
    globalThis.fetch = async () => ({ ok: true, text: async () => text.replace('"guildId": "100"', '"guildId": "999"') });
    const y = fakeInteraction(k, { sub: 'end', options: { backup: other } });
    await sos.execute(y.i, ctx);
    assert.match(embed(y.log.replies[0]).description, /not a backup of this server/);
  } finally {
    globalThis.fetch = realFetch;
    k.done();
  }
});

test('/sos end that cannot finish says so and keeps SOS on', async () => {
  const k = kit(typical());
  try {
    const { ctx } = ctxFor(k);
    await k.svc.start(k.server.guild, await k.svc.scan(k.server.guild), 'OWNER');
    k.server.failWhen = (m, route) => (m === 'PUT' && route.includes('/channels/staff/') ? Object.assign(new Error('rate limited'), { code: 0 }) : null);
    const x = fakeInteraction(k, { sub: 'end' });
    await sos.execute(x.i, ctx);
    const e = embed(x.log.replies[x.log.replies.length - 1]);
    assert.equal(e.title, 'Restore not finished');
    assert.match(e.description, /SOS stays on and nothing is forgotten/);
    assert.match(fieldOf(e, 'Still to fix'), /staff/);
    assert.equal(k.svc.isActive(G), true);
  } finally {
    k.done();
  }
});

test('/sos is for the owner only, and its definition follows the house format', () => {
  const call = (user) => refusal(commands.get('sos'), { commandName: 'sos', user: { id: user }, guild: { ownerId: 'OWNER' }, inGuild: () => true }, { isManager: (u) => u.id === 'MGR', verifiedGate: () => ({ ok: true }) });
  assert.equal(call('OWNER'), null);
  assert.equal(call('MGR'), null);
  assert.match(call('ADMIN'), /Only the server owner can use \/sos/);
  const json = sos.data.toJSON();
  assert.deepEqual(json.options.map((o) => o.name), ['start', 'end', 'status']);
  for (const o of [json, ...json.options]) {
    assert.ok(o.description.length <= 100 && !o.description.endsWith('.'), o.description);
  }
  assert.equal(sos.noCooldown, true);
});

// ---------- /lock and /unlock ----------

const lockKit = () => {
  const spec = typical();
  spec.channels.push({ id: 'talk', permission_overwrites: [ow(G, 0, 0n, 0n), ow('VIPR', 0, SEND, 0n)] });
  return kit(spec);
};
const textChannel = (k, id) => ({ id, type: ChannelType.GuildText, send: async (p) => { k.sent = (k.sent || []).concat(p); } });

test('/lock posts the Channel locked card in the channel, and /unlock puts the channel back as it was', async () => {
  const k = lockKit();
  try {
    const original = k.server.dump();
    const { ctx } = ctxFor(k);
    const a = fakeInteraction(k, { user: 'ADMIN1', channel: textChannel(k, 'talk') });
    await lock.execute(a.i, ctx);
    const locked = embed(k.sent[0]);
    assert.equal(locked.title, 'Channel locked');
    assert.equal(locked.description, 'Only admins and the server owner can write here.');
    assert.equal(a.log.deleted, true, 'the private thinking message is gone');
    assert.equal(k.svc.isLocked(G, 'talk'), true);
    const mask = SEND | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
    const everyone = k.server.state.channels.get('talk').permission_overwrites.find((o) => o.id === G);
    assert.equal(BigInt(everyone.deny) & mask, mask);
    const vip = k.server.state.channels.get('talk').permission_overwrites.find((o) => o.id === 'VIPR');
    assert.equal(BigInt(vip.allow) & SEND, 0n, 'a role that was allowed to write is not any more');

    const again = fakeInteraction(k, { user: 'ADMIN1', channel: textChannel(k, 'talk') });
    await lock.execute(again.i, ctx);
    assert.match(embed(again.log.replies[0]).description, /already locked/);

    const u = fakeInteraction(k, { user: 'ADMIN1', channel: textChannel(k, 'talk') });
    await unlock.execute(u.i, ctx);
    assert.equal(embed(k.sent[1]).title, 'Channel unlocked');
    assert.deepEqual(k.server.dump(), original);

    const notLocked = fakeInteraction(k, { user: 'ADMIN1', channel: textChannel(k, 'talk') });
    await unlock.execute(notLocked.i, ctx);
    assert.match(embed(notLocked.log.replies[0]).description, /was not locked with \/lock/);
  } finally {
    k.done();
  }
});

test('/lock refuses threads, explains a permission problem and falls back to a private card when it cannot post', async () => {
  const k = lockKit();
  try {
    const { ctx, held } = ctxFor(k);
    const thread = fakeInteraction(k, { channel: { id: 't', type: ChannelType.PublicThread } });
    await lock.execute(thread.i, ctx);
    assert.match(embed(thread.log.replies[0]).description, /not in a thread/);
    assert.equal(held.refunds, 1);

    k.server.failWhen = (m) => (m === 'PUT' ? Object.assign(new Error('Missing Permissions'), { code: 50013 }) : null);
    const denied = fakeInteraction(k, { channel: textChannel(k, 'talk') });
    await lock.execute(denied.i, ctx);
    assert.match(embed(denied.log.replies[0]).description, /Give me Manage Roles/);
    assert.equal(k.svc.isLocked(G, 'talk'), false);
    k.server.failWhen = null;

    const mute = fakeInteraction(k, { channel: { id: 'talk', type: ChannelType.GuildText, send: async () => { throw new Error('Missing Access'); } } });
    await lock.execute(mute.i, ctx);
    assert.equal(embed(mute.log.replies[0]).title, 'Channel locked', 'the answer still reaches the admin');
  } finally {
    k.done();
  }
});

test('/lock and /unlock are for admins, and refuse while SOS is on', async () => {
  const k = lockKit();
  try {
    const callWith = (name, user, perms) =>
      refusal(commands.get(name), { commandName: name, user: { id: user }, guild: { ownerId: 'OWNER' }, memberPermissions: perms, inGuild: () => true }, { isManager: (u) => u.id === 'MGR', verifiedGate: () => ({ ok: true }) });
    for (const name of ['lock', 'unlock']) {
      assert.equal(callWith(name, 'A', { has: (f) => f === ADMIN }), null);
      assert.equal(callWith(name, 'OWNER', { has: () => false }), null);
      assert.match(callWith(name, 'MOD', { has: (f) => f === P.ManageMessages }), /Only admins can use/);
    }
    k.svc._sos()[G] = { active: true };
    const { ctx } = ctxFor(k);
    const x = fakeInteraction(k, { channel: textChannel(k, 'talk') });
    await lock.execute(x.i, ctx);
    assert.match(embed(x.log.replies[0]).description, /SOS is on/);
  } finally {
    k.done();
  }
});
