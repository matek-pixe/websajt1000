'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const { Storage } = require('../src/storage');
const { PrivService, GRANT } = require('../src/services/priv');
const priv = require('../src/commands/priv');
const { refusal } = require('../src/gates');
const { commands } = require('../src/commands');
const { tmpDir, rm } = require('./helpers');

const CAT = '1554450056336375878';
const CFG = { priv: { categoryId: CAT, roleName: 'priv' } };

/** A small server: the private category with two channels, another category with one, some roles. */
function mk({ botPerms = null, failOn = null } = {}) {
  const dir = tmpDir();
  const storage = new Storage(path.join(dir, 'db.json'));
  const svc = new PrivService(storage, CFG);
  const edits = [];
  const chan = (id, name, type, parentId = null) => ({
    id,
    name,
    type,
    parentId,
    permissionOverwrites: {
      edit: async (role, allow, opts) => {
        if (failOn === id) throw new Error('Missing Permissions');
        edits.push({ channel: id, role: role.id, allow, reason: opts && opts.reason });
      },
    },
  });
  const roles = new Map([['R-existing', { id: 'R-existing', name: 'Member', managed: false }]]);
  const created = [];
  const guild = {
    id: 'G',
    roles: {
      cache: roles,
      create: async (o) => {
        const role = { id: `R-new${created.length + 1}`, managed: false, ...o };
        created.push(o);
        roles.set(role.id, role);
        return role;
      },
    },
    channels: {
      cache: new Map([
        [CAT, chan(CAT, 'PRIVATE', 4)],
        ['t1', chan('t1', 'priv-chat', 0, CAT)],
        ['v1', chan('v1', 'priv voice', 2, CAT)],
        ['other-cat', chan('other-cat', 'GENERAL', 4)],
        ['t2', chan('t2', 'chat', 0, 'other-cat')],
      ]),
    },
    members: { me: { permissions: { has: (f) => (botPerms ? botPerms.includes(f) : true) } } },
  };
  return { svc, guild, edits, created, storage, done: () => rm(dir) };
}

test('the priv role is made once, with no permissions of its own, and remembered', async () => {
  const k = mk();
  try {
    const first = await k.svc.ensureRole(k.guild, 'r');
    assert.equal(first.created, true);
    assert.equal(first.role.name, 'priv');
    assert.deepEqual(k.created[0].permissions, []);
    assert.equal(k.created[0].hoist, false);
    assert.equal(k.created[0].mentionable, false);
    assert.equal(k.svc.roleId('G'), first.role.id);
    assert.equal(new PrivService(new Storage(k.storage.file), CFG).roleId('G'), first.role.id, 'survives a restart');

    const second = await k.svc.ensureRole(k.guild, 'r');
    assert.equal(second.created, false);
    assert.equal(second.role.id, first.role.id);
    assert.equal(k.created.length, 1, 'never a second role');

    // renamed afterwards: still found by the remembered id
    k.guild.roles.cache.get(first.role.id).name = 'VIP lounge';
    assert.equal((await k.svc.ensureRole(k.guild, 'r')).role.id, first.role.id);
    assert.equal(k.created.length, 1);
  } finally {
    k.done();
  }
});

test('a role that is already called priv is used, but a bot role with that name is not', async () => {
  const k = mk();
  try {
    k.guild.roles.cache.set('bot', { id: 'bot', name: 'priv', managed: true });
    const made = await k.svc.ensureRole(k.guild, 'r');
    assert.equal(made.created, true, 'a managed role cannot be given to people');
    k.guild.roles.cache.delete(made.role.id);
    k.guild.roles.cache.set('mine', { id: 'mine', name: 'Priv', managed: false });
    const again = await new PrivService(new Storage(path.join(tmpDir(), 'other.json')), CFG).ensureRole(k.guild, 'r');
    assert.equal(again.role.id, 'mine');
    assert.equal(again.created, false);
  } finally {
    k.done();
  }
});

test('the role gets its access on the category and on every channel inside it, and nowhere else', async () => {
  const k = mk();
  try {
    const { role } = await k.svc.ensureRole(k.guild, 'r');
    const res = await k.svc.grant(k.guild, k.svc.category(k.guild), role, 'why');
    assert.deepEqual(res.done, ['PRIVATE', 'priv-chat', 'priv voice']);
    assert.deepEqual(k.edits.map((e) => e.channel), [CAT, 't1', 'v1'], 'not the other category and not its channel');
    for (const e of k.edits) {
      assert.equal(e.role, role.id);
      assert.equal(e.reason, 'why');
      for (const key of ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak']) assert.equal(e.allow[key], true, key);
      assert.ok(Object.values(e.allow).every((v) => v === true), 'only allows, nothing is denied or removed');
    }
    assert.deepEqual(res.skipped, []);
  } finally {
    k.done();
  }
});

test('what the bot does not hold itself is not granted, and is reported', async () => {
  const k = mk({ botPerms: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.ManageRoles] });
  try {
    const { role } = await k.svc.ensureRole(k.guild, 'r');
    const res = await k.svc.grant(k.guild, k.svc.category(k.guild), role, 'r');
    assert.deepEqual(Object.keys(k.edits[0].allow).sort(), ['Connect', 'ReadMessageHistory', 'SendMessages', 'ViewChannel']);
    assert.ok(res.skipped.includes('Speak') && res.skipped.includes('Stream'));
    assert.equal(res.failed.length, 0);
  } finally {
    k.done();
  }
});

test('a channel that cannot be changed is named, and the others are still done', async () => {
  const k = mk({ failOn: 't1' });
  try {
    const { role } = await k.svc.ensureRole(k.guild, 'r');
    const res = await k.svc.grant(k.guild, k.svc.category(k.guild), role, 'r');
    assert.deepEqual(res.done, ['PRIVATE', 'priv voice']);
    assert.deepEqual(res.failed, [{ name: 'priv-chat', error: 'Missing Permissions' }]);
  } finally {
    k.done();
  }
});

test('the category must be on this server, and be a category', () => {
  const k = mk();
  try {
    assert.equal(k.svc.category(k.guild).id, CAT);
    k.guild.channels.cache.delete(CAT);
    assert.equal(k.svc.category(k.guild), null);
    k.guild.channels.cache.set(CAT, { id: CAT, type: 0 });
    assert.equal(k.svc.category(k.guild), null, 'a text channel with that id is not a category');
  } finally {
    k.done();
  }
});

// ---------- the command ----------

function run(k, { user = 'ADMIN' } = {}) {
  const replies = [];
  let refunds = 0;
  const i = {
    guild: k.guild,
    user: { id: user, tag: 'admin#0' },
    deferred: false,
    replied: false,
    deferReply: async () => { i.deferred = true; },
    editReply: async (p) => replies.push(p),
    reply: async (p) => { i.replied = true; replies.push(p); },
  };
  const ctx = { priv: k.svc, config: CFG, refundCooldown: () => { refunds += 1; } };
  return { go: () => priv.execute(i, ctx), replies, refunds: () => refunds };
}
const card = (r) => r.replies[0].embeds[0].toJSON();

test('/priv: makes the role, opens the category and says so', async () => {
  const k = mk();
  try {
    const r = run(k);
    await r.go();
    const e = card(r);
    assert.equal(e.title, 'Priv role created');
    assert.match(e.description, /<@&R-new1> can see \*\*PRIVATE\*\*, write in its text channels and join and speak in its voice channels/);
    assert.equal(e.fields.find((f) => f.name === 'Opened').value, '3 channels (the category and 2 inside)');
    assert.equal(k.edits.length, 3);
    assert.equal(r.refunds(), 0);

    const again = run(k);
    await again.go();
    assert.equal(card(again).title, 'Priv role updated', 'running it again reuses the role');
    assert.equal(k.created.length, 1);
  } finally {
    k.done();
  }
});

test('/priv: refuses when the category is missing or the bot cannot manage roles, and refunds the cooldown', async () => {
  const k = mk();
  try {
    k.guild.channels.cache.delete(CAT);
    const missing = run(k);
    await missing.go();
    assert.match(card(missing).description, new RegExp(`${CAT} was not found on this server`));
    assert.equal(missing.refunds(), 1);
    assert.equal(k.created.length, 0, 'no role is made for nothing');
  } finally {
    k.done();
  }
  const k2 = mk({ botPerms: [P.ViewChannel] });
  try {
    const r = run(k2);
    await r.go();
    assert.match(card(r).description, /Manage Roles/);
    assert.equal(k2.created.length, 0);
  } finally {
    k2.done();
  }
});

test('/priv: partial failures are listed in an amber card', async () => {
  const k = mk({ failOn: 'v1' });
  try {
    const r = run(k);
    await r.go();
    const e = card(r);
    assert.equal(e.color, 0xfaa61a);
    assert.match(e.fields.find((f) => f.name === 'Could not change').value, /priv voice: Missing Permissions/);
  } finally {
    k.done();
  }
});

test('/priv is for admins and follows the house format', () => {
  const call = (user, perms) => refusal(commands.get('priv'), { commandName: 'priv', user: { id: user }, guild: { ownerId: 'OWNER' }, memberPermissions: perms, inGuild: () => true }, { isManager: (u) => u.id === 'MGR', verifiedGate: () => ({ ok: true }) });
  assert.equal(call('A', { has: (f) => f === P.Administrator }), null);
  assert.equal(call('OWNER', { has: () => false }), null);
  assert.match(call('MOD', { has: () => false }), /Only admins can use \/priv/);
  const json = priv.data.toJSON();
  assert.equal(json.name, 'priv');
  assert.ok(json.description.length <= 100 && !json.description.endsWith('.'));
  assert.deepEqual(json.options || [], []);
  assert.ok(Object.keys(GRANT).includes('Connect') && Object.keys(GRANT).includes('Speak'));
});
