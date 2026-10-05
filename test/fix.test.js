'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { Storage } = require('../src/storage');
const { RoleMemoryService } = require('../src/services/roleMemory');
const { FixService, withOpen } = require('../src/services/fix');
const O = require('../src/services/overwrites');
const fix = require('../src/commands/fix');
const { refusal } = require('../src/gates');
const { commands } = require('../src/commands');
const { tmpDir, rm } = require('./helpers');

const CFG = { fix: { memberRoleName: 'member' }, autoRole: { id: '', name: 'member' } };
const VIEW = P.ViewChannel;
const READ = P.ReadMessageHistory;
const SEND = P.SendMessages;

class Coll extends Map {
  find(fn) {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

/** A small server: roles, members, and a VERIFY category whose permissions the test sets. */
function mk({ everyoneBase = VIEW | SEND | READ, verifyOverwrites = [], panel = true, botPerms = null, botTop = 50, failGive = null, readable = true, sendFails = false, memberCount = 5 } = {}) {
  const dir = tmpDir();
  const storage = new Storage(path.join(dir, 'db.json'));
  const roles = new Coll();
  const members = new Coll();
  const log = [];
  const created = [];

  const addRole = (spec) => {
    const role = { managed: false, position: 5, ...spec, permissions: new PermissionsBitField(BigInt(spec.perms || 0)) };
    role.setName = async (n) => { log.push(`rename ${role.id} ${role.name} -> ${n}`); role.name = n; };
    roles.set(role.id, role);
    return role;
  };
  const addMember = (id, roleIds = [], bot = false) => {
    const m = { id, user: { bot, tag: `${id}#0`, username: id }, roles: { cache: new Map() } };
    m.roles.add = async (rid) => {
      if (failGive === id) throw new Error('Missing Permissions');
      m.roles.cache.set(rid, roles.get(rid));
      log.push(`give ${id} ${rid}`);
    };
    for (const r of roleIds) m.roles.cache.set(r, roles.get(r));
    members.set(id, m);
    return m;
  };

  addRole({ id: 'G', name: '@everyone', position: 0, perms: everyoneBase });
  addRole({ id: 'VERIFIED', name: '+', position: 4 });
  const bot = addMember('BOT', [], true);
  for (let i = 1; i <= memberCount; i++) addMember(`U${i}`);

  // the permissions of one channel as Discord keeps them, edited like Discord does
  const mkChannel = (id, name, type, parentId, overwrites = []) => {
    const cache = new Map(overwrites.map((o) => [o.id, { id: o.id, type: o.type, allow: new PermissionsBitField(BigInt(o.allow)), deny: new PermissionsBitField(BigInt(o.deny)) }]));
    const ch = {
      id,
      name,
      type,
      parentId,
      permissionOverwrites: {
        cache,
        edit: async (target, options) => {
          const tid = typeof target === 'string' ? target : target.id;
          const cur = cache.get(tid) || { id: tid, type: tid === 'G' || roles.has(tid) ? 0 : 1, allow: new PermissionsBitField(0n), deny: new PermissionsBitField(0n) };
          let allow = BigInt(cur.allow.bitfield);
          let deny = BigInt(cur.deny.bitfield);
          for (const [k, v] of Object.entries(options)) {
            if (v === true) { allow |= P[k]; deny &= ~P[k]; }
            else if (v === false) { deny |= P[k]; allow &= ~P[k]; }
          }
          cache.set(tid, { ...cur, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });
          log.push(`edit ${id} ${tid}`);
        },
      },
    };
    return ch;
  };
  const verifyCat = mkChannel('VCAT', '✅ ıl VERIFY', ChannelType.GuildCategory, null, verifyOverwrites);
  const verifyCh = mkChannel('VCH', '🎫・verify', ChannelType.GuildText, 'VCAT', verifyOverwrites);
  const sent = [];
  const history = panel
    ? [{ author: { id: 'BOT' }, components: [{ components: [{ customId: 'tk:open' }] }] }, { author: { id: 'U1' }, components: [] }]
    : [{ author: { id: 'BOT' }, components: [] }];
  verifyCh.messages = { fetch: async () => (readable ? new Map(history.map((m, i) => [String(i), m])) : Promise.reject(new Error('Missing Access'))) };
  verifyCh.send = async (p) => { if (sendFails) throw new Error('Missing Access'); sent.push(p); };
  const general = mkChannel('GEN', 'chat', ChannelType.GuildText, 'GCAT');
  const channels = new Coll([
    ['VCAT', verifyCat],
    ['VCH', verifyCh],
    ['GCAT', mkChannel('GCAT', 'GENERAL', ChannelType.GuildCategory, null)],
    ['GEN', general],
  ]);

  const guild = {
    id: 'G',
    name: 'Test',
    roles: {
      cache: roles,
      everyone: roles.get('G'),
      create: async (o) => {
        const role = addRole({ id: `NEW${created.length + 1}`, name: o.name, position: 1, perms: 0n });
        created.push(o);
        log.push(`create ${role.id} ${o.name}`);
        return role;
      },
    },
    channels: { cache: channels },
    members: {
      cache: members,
      fetch: async () => members,
      fetchMe: async () => guild.members.me,
      me: { id: bot.id, permissions: { has: (f) => (botPerms ? botPerms.includes(f) : true) }, roles: { highest: { position: botTop } } },
    },
  };
  const storageSetup = { roles: {}, channels: { verify: 'VCAT', verify_ch: 'VCH' }, keep: [] };
  storage.data.setup.G = storageSetup;
  const roleMemory = new RoleMemoryService(storage, CFG.autoRole);
  const setup = { getVerifyChannelId: (g) => (storage.data.setup[g.id] && storage.data.setup[g.id].channels.verify_ch) || null };
  const svc = new FixService({ storage, config: CFG, roleMemory, setup });
  return { svc, guild, roles, members, channels, log, created, sent, roleMemory, storage, addRole, verifyCat, verifyCh, dir, done: () => rm(dir) };
}
const ow = (id, type, allow = 0n, deny = 0n) => ({ id, type, allow: String(allow), deny: String(deny) });
const BY = { id: 'ADMIN', tag: 'admin#0', username: 'admin' };

// ---------- the member role ----------

test('a missing member role is made again, written in small letters, remembered and given to every person', async () => {
  const k = mk();
  try {
    const res = await k.svc.run(k.guild, BY);
    assert.equal(res.ok, true);
    assert.equal(res.member.created, true);
    assert.equal(res.member.role.name, 'member');
    assert.deepEqual(k.created.map((c) => c.name), ['member']);
    assert.equal(k.roleMemory.getGuildAutoRole('G'), res.member.role.id, 'new members get exactly this role from now on');
    for (const [id, m] of k.members) if (!m.user.bot) assert.ok(m.roles.cache.has(res.member.role.id), `${id} has it`);
    assert.ok(!k.members.get('BOT').roles.cache.has(res.member.role.id), 'bots are skipped');
    assert.deepEqual([res.member.given, res.member.already], [5, 0]);
  } finally {
    k.done();
  }
});

test('an existing member role is found whatever its capitals, fixed, and nobody is given it twice', async () => {
  const k = mk();
  try {
    const role = k.addRole({ id: 'MEM', name: 'Member', position: 3 });
    k.members.get('U1').roles.cache.set('MEM', role);
    k.members.get('U2').roles.cache.set('MEM', role);
    const res = await k.svc.run(k.guild, BY);
    assert.equal(res.member.created, false);
    assert.equal(res.member.renamed, true);
    assert.equal(role.name, 'member');
    assert.deepEqual([res.member.given, res.member.already], [3, 2]);
    assert.equal(k.created.length, 0, 'no second role');

    const again = await k.svc.run(k.guild, BY);
    assert.deepEqual([again.member.given, again.member.already, again.member.renamed], [0, 5, false]);
  } finally {
    k.done();
  }
});

test('the role chosen with /aa is used as it is, even if it is called something else', async () => {
  const k = mk();
  try {
    const role = k.addRole({ id: 'PLAYERS', name: 'Players', position: 3 });
    k.roleMemory.setGuildAutoRole('G', 'PLAYERS', { id: 'x', username: 'x' });
    const res = await k.svc.run(k.guild, BY);
    assert.equal(res.member.role.id, 'PLAYERS');
    assert.equal(role.name, 'Players', 'a different name is somebody\'s choice, never renamed');
    assert.equal(res.member.given, 5);
    assert.equal(k.created.length, 0);
  } finally {
    k.done();
  }
});

test('a role above the bot, or a bot role, is explained and nothing is given', async () => {
  const k = mk();
  try {
    k.addRole({ id: 'MEM', name: 'member', position: 90 });
    const res = await k.svc.run(k.guild, BY);
    assert.match(res.member.problem, /above my highest role/);
    assert.equal(res.member.given, 0);
    assert.ok(!k.log.some((l) => l.startsWith('give')));
    // a role that belongs to a bot cannot be given to people either
    k.addRole({ id: 'BOTROLE', name: 'member', position: 2, managed: true });
    k.roleMemory.setGuildAutoRole('G', 'BOTROLE', { id: 'x', username: 'x' });
    const managed = await k.svc.run(k.guild, BY);
    assert.match(managed.member.problem, /belongs to a bot/);
    assert.equal(managed.member.given, 0);
  } finally {
    k.done();
  }
});

test('failed gives are counted and named, and never stop the rest', async () => {
  const k = mk({ failGive: 'U3' });
  try {
    const res = await k.svc.run(k.guild, BY);
    assert.equal(res.member.given, 4);
    assert.equal(res.member.failedCount, 1);
    assert.match(res.member.failed[0], /U3#0: Missing Permissions/);
  } finally {
    k.done();
  }
});

test('without Manage Roles nothing is done', async () => {
  const k = mk({ botPerms: [P.ViewChannel] });
  try {
    assert.deepEqual(await k.svc.run(k.guild, BY), { ok: false, reason: 'permissions' });
    assert.equal(k.created.length, 0);
  } finally {
    k.done();
  }
});

// ---------- the verify category ----------

test('a verify category that new people can see is left exactly as it is', async () => {
  const k = mk({ verifyOverwrites: [ow('G', 0, VIEW | READ, SEND), ow('VERIFIED', 0, 0n, VIEW)] });
  try {
    const res = await k.svc.run(k.guild, BY);
    assert.deepEqual([res.verify.fine, res.verify.opened, res.verify.failed], [2, [], []]);
    assert.ok(!k.log.some((l) => l.startsWith('edit')), 'nothing was edited');
    assert.equal(res.verify.panel, 'found');
    assert.equal(k.sent.length, 0);
    assert.deepEqual([res.verify.category, res.verify.channel], ['✅ ıl VERIFY', '🎫・verify']);
  } finally {
    k.done();
  }
});

test('a verify category that is hidden from new people is opened for everyone, read only, on the category and its channel', async () => {
  const k = mk({ everyoneBase: SEND, verifyOverwrites: [ow('G', 0, 0n, VIEW), ow('VERIFIED', 0, 0n, VIEW)] });
  try {
    const res = await k.svc.run(k.guild, BY);
    assert.deepEqual(res.verify.opened, [{ name: '✅ ıl VERIFY', how: 'everyone' }, { name: '🎫・verify', how: 'everyone' }]);
    for (const ch of [k.verifyCat, k.verifyCh]) {
      const ev = ch.permissionOverwrites.cache.get('G');
      assert.equal(BigInt(ev.allow.bitfield) & (VIEW | READ), VIEW | READ, 'look and read');
      assert.equal(BigInt(ev.deny.bitfield) & VIEW, 0n, 'no longer hidden');
      assert.equal(BigInt(ev.deny.bitfield) & SEND, SEND, 'but nobody writes here');
      assert.equal(BigInt(ev.allow.bitfield) & SEND, 0n);
      // the verified role keeps its deny, so verified people do not see it any more
      assert.equal(BigInt(ch.permissionOverwrites.cache.get('VERIFIED').deny.bitfield) & VIEW, VIEW);
    }
    // the member role is given to a new person, who can now see it
    const roleId = res.member.role.id;
    const raw = (ch) => [...ch.permissionOverwrites.cache.values()].map((o) => O.raw({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
    const roles = [...k.roles.values()].map((r) => ({ id: r.id, permissions: String(r.permissions.bitfield) }));
    assert.equal(O.memberCanRead({ roleIds: [roleId], roles, channel: { overwrites: raw(k.verifyCh) }, everyoneId: 'G' }), true);
  } finally {
    k.done();
  }
});

test('when something overrides it for the member role itself, that role is opened too', async () => {
  const k = mk({ verifyOverwrites: [ow('G', 0, VIEW | READ, 0n)] });
  try {
    // an explicit deny for the member role on the channel
    k.addRole({ id: 'MEM', name: 'member', position: 3 });
    k.verifyCh.permissionOverwrites.cache.set('MEM', { id: 'MEM', type: 0, allow: new PermissionsBitField(0n), deny: new PermissionsBitField(VIEW) });
    const res = await k.svc.run(k.guild, BY);
    const ch = res.verify.opened.find((o) => o.name === '🎫・verify');
    assert.equal(ch.how, 'the member role');
    const mem = k.verifyCh.permissionOverwrites.cache.get('MEM');
    assert.equal(BigInt(mem.allow.bitfield) & VIEW, VIEW);
    assert.equal(BigInt(mem.deny.bitfield) & VIEW, 0n);
  } finally {
    k.done();
  }
});

test('a missing ticket button is posted again, only when it is really missing and only once', async () => {
  const k = mk({ panel: false });
  try {
    const res = await k.svc.run(k.guild, BY);
    assert.equal(res.verify.panel, 'posted');
    assert.equal(k.sent.length, 1);
    assert.equal(k.sent[0].components[0].toJSON().components[0].custom_id, 'tk:open');
    assert.equal(k.sent[0].embeds[0].toJSON().title, '35xw verification');
  } finally {
    k.done();
  }
  const unreadable = mk({ panel: false, readable: false });
  try {
    const res = await unreadable.svc.run(unreadable.guild, BY);
    assert.equal(res.verify.panel, 'unknown', 'if the channel cannot be read nothing is posted, so there are no doubles');
    assert.equal(unreadable.sent.length, 0);
  } finally {
    unreadable.done();
  }
  const mute = mk({ panel: false, sendFails: true });
  try {
    const res = await mute.svc.run(mute.guild, BY);
    assert.equal(res.verify.panel, 'failed');
    assert.match(res.verify.failed[0].name, /ticket button/);
  } finally {
    mute.done();
  }
});

test('the verify category is found by name when /setup never stored it, and a server without one is told so', async () => {
  const k = mk();
  try {
    k.storage.data.setup.G = { roles: {}, channels: {}, keep: [] };
    const res = await k.svc.run(k.guild, BY);
    assert.equal(res.verify.found, true);
    assert.equal(res.verify.channel, '🎫・verify');
    for (const id of ['VCAT', 'VCH']) k.channels.delete(id);
    const none = await k.svc.run(k.guild, BY);
    assert.equal(none.verify.found, false);
    assert.equal(none.member.role.name, 'member', 'the member part still runs');
  } finally {
    k.done();
  }
});

test('withOpen shows the result of opening without waiting for Discord', () => {
  const list = withOpen([ow('G', 0, 0n, VIEW | SEND)], 'G', 0);
  assert.equal(BigInt(list[0].allow) & (VIEW | READ), VIEW | READ);
  assert.equal(BigInt(list[0].deny) & VIEW, 0n);
  assert.equal(BigInt(list[0].deny) & SEND, SEND);
  assert.equal(withOpen([], 'X', 1).length, 1);
});

// ---------- the command ----------

function run(k, { user = 'ADMIN' } = {}) {
  const replies = [];
  let refunds = 0;
  let held = 0;
  let released = 0;
  const posted = [];
  const i = {
    guild: k.guild,
    user: { id: user, tag: 'admin#0', username: 'admin' },
    deferred: false,
    replied: false,
    deferReply: async () => { i.deferred = true; },
    editReply: async (p) => replies.push(p),
    reply: async (p) => { i.replied = true; replies.push(p); },
  };
  const ctx = { fix: k.svc, refundCooldown: () => { refunds += 1; }, logs: { hold: () => { held += 1; return () => { released += 1; }; }, post: (g, e) => posted.push(e.toJSON()) } };
  return { go: () => fix.execute(i, ctx), replies, posted, refunds: () => refunds, logs: () => ({ held, released }) };
}
const embed = (r) => r.replies[r.replies.length - 1].embeds[0].toJSON();
const fieldOf = (e, name) => (e.fields.find((f) => f.name === name) || {}).value;

test('/fix: one card says what was found and what was done, the log is muted once', async () => {
  const k = mk({ everyoneBase: SEND, verifyOverwrites: [ow('G', 0, 0n, VIEW)], panel: false });
  try {
    const r = run(k);
    await r.go();
    const e = embed(r);
    assert.equal(e.title, 'Fix done');
    assert.match(fieldOf(e, 'Member role'), /was missing, I made it again\. Given to 5 members, 0 already had it\. Bots skipped\. New members get exactly this role\./);
    assert.match(fieldOf(e, 'Verify category'), /\*\*✅ ıl VERIFY\*\* found\. New people could not see 2 channels there, so I opened them for everyone: they can look and read, not write\. The ticket button was missing, I posted it again\./);
    assert.deepEqual(r.logs(), { held: 1, released: 1 });
    assert.equal(r.posted[0].title, 'Members fixed');
    assert.equal(r.refunds(), 0);
  } finally {
    k.done();
  }
});

test('/fix: a healthy server gets a calm card, problems turn it amber, refusals refund the cooldown', async () => {
  const healthy = mk({ verifyOverwrites: [ow('G', 0, VIEW | READ, SEND)] });
  try {
    const r = run(healthy);
    await r.go();
    assert.match(fieldOf(embed(r), 'Verify category'), /New people can already see it \(2 channels checked\)\. The ticket button is there\./);
    assert.equal(embed(r).color, 0x3ba55d);
  } finally {
    healthy.done();
  }
  const sad = mk({ failGive: 'U1' });
  try {
    for (const id of ['VCAT', 'VCH']) sad.channels.delete(id);
    const r = run(sad);
    await r.go();
    assert.equal(embed(r).title, 'Fix done, with problems');
    assert.match(fieldOf(embed(r), 'Verify category'), /could not find a verify category/);
    assert.match(fieldOf(embed(r), 'First errors'), /U1#0/);
  } finally {
    sad.done();
  }
  const noPerm = mk({ botPerms: [P.ViewChannel] });
  try {
    const r = run(noPerm);
    await r.go();
    assert.match(embed(r).description, /Manage Roles/);
    assert.equal(r.refunds(), 1);
  } finally {
    noPerm.done();
  }
});

test('/fix is for admins and follows the house format, and /priv is gone', () => {
  const call = (user, perms) => refusal(commands.get('fix'), { commandName: 'fix', user: { id: user }, guild: { ownerId: 'OWNER' }, memberPermissions: perms, inGuild: () => true }, { isManager: (u) => u.id === 'MGR', verifiedGate: () => ({ ok: true }) });
  assert.equal(call('A', { has: (f) => f === P.Administrator }), null);
  assert.equal(call('OWNER', { has: () => false }), null);
  assert.match(call('MOD', { has: () => false }), /Only admins can use \/fix/);
  const json = fix.data.toJSON();
  assert.ok(json.description.length <= 100 && !json.description.endsWith('.'), json.description);
  assert.deepEqual(json.options || [], []);
  assert.equal(commands.has('priv'), false);
});
