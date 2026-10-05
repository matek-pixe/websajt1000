'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { Storage } = require('../src/storage');
const { RoleMemoryService } = require('../src/services/roleMemory');
const { PrivService, GRANT } = require('../src/services/priv');
const priv = require('../src/commands/priv');
const { refusal } = require('../src/gates');
const { commands } = require('../src/commands');
const { tmpDir, rm } = require('./helpers');

const PRIV_CAT = '1554450056336375878';
const VIP_CAT = '1554450096551370822';
const STAFF_CAT = '1554450100728762408';
const CFG = {
  priv: { categoryId: PRIV_CAT, roleName: 'priv', staffCategoryIds: [STAFF_CAT, VIP_CAT], staffRoleName: 'staff', memberRoleName: 'member' },
  autoRole: { id: '', name: 'member' },
  setup: { sensitiveRoleId: 'SENSITIVE', protectedRoleIds: [] },
  web: { roleIds: ['WEBROLE'] },
};

/**
 * A small server with its roles, members and channels, and just enough of discord.js's behaviour:
 * roles that list their members, permission edits that are recorded, role changes that really happen.
 */
/** discord.js collections are Maps with a few helpers. */
class Coll extends Map {
  find(fn) {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

function mk({ botPerms = null, botTop = 50, failEdit = null, failGive = null, extraRoles = [], extraChannels = [], memberCount = 6 } = {}) {
  const dir = tmpDir();
  const storage = new Storage(path.join(dir, 'db.json'));
  const members = new Map();
  const roles = new Coll();
  const edits = [];
  const log = [];

  const addRole = (spec) => {
    const role = {
      managed: false,
      position: 5,
      ...spec,
      permissions: new PermissionsBitField(BigInt(spec.perms || 0)),
      get members() {
        return new Map([...members.values()].filter((m) => m.roles.cache.has(role.id)).map((m) => [m.id, m]));
      },
      async setName(name) { log.push(`rename ${role.id} ${role.name} -> ${name}`); role.name = name; },
      async setPermissions(p) { log.push(`permissions ${role.id}`); role.permissions = p; },
      async delete() {
        log.push(`delete ${role.id}`);
        // everyone must already have the member role when a duplicate goes
        log.push(`humans without keep at delete: ${[...members.values()].filter((m) => !m.user.bot && !m.roles.cache.has('KEEP') && !m.roles.cache.has('M1')).length}`);
        roles.delete(role.id);
        for (const m of members.values()) m.roles.cache.delete(role.id);
      },
    };
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

  addRole({ id: 'G', name: '@everyone', position: 0 });
  addRole({ id: 'M1', name: 'Member', position: 3 }); // the role the bot gives today
  for (const r of extraRoles) addRole(r);
  for (let i = 1; i <= memberCount; i++) addMember(`U${i}`, i <= 3 ? ['M1'] : []);
  addMember('BOTUSER', [], true);

  const chan = (id, name, type, parentId = null, overwriteIds = []) => ({
    id,
    name,
    type,
    parentId,
    permissionOverwrites: {
      cache: new Map(overwriteIds.map((x) => [x, {}])),
      edit: async (role, allow, opts) => {
        if (failEdit === id) throw new Error('Missing Permissions');
        edits.push({ channel: id, role: role.id, allow, reason: opts && opts.reason });
      },
    },
  });
  const channels = new Map(
    [
      chan(PRIV_CAT, 'PRIVATE', 4),
      chan('p1', 'priv-chat', 0, PRIV_CAT),
      chan(STAFF_CAT, 'STAFF', 4),
      chan('s1', 'staff-news', 0, STAFF_CAT),
      chan('s2', 'staff voice', 2, STAFF_CAT),
      chan(VIP_CAT, 'VIP', 4),
      chan('v1', 'vip-chat', 0, VIP_CAT),
      chan('g-cat', 'GENERAL', 4),
      chan('g1', 'chat', 0, 'g-cat'),
      ...extraChannels.map((c) => chan(c.id, c.name, c.type ?? 0, c.parentId ?? 'g-cat', c.overwriteIds || [])),
    ].map((c) => [c.id, c]),
  );

  const created = [];
  const guild = {
    id: 'G',
    name: 'Test',
    roles: {
      cache: roles,
      create: async (o) => {
        const role = addRole({ id: `NEW${created.length + 1}`, name: o.name, position: 1, perms: (o.permissions || []).reduce((a, b) => a | b, 0n) });
        created.push({ ...o, id: role.id });
        log.push(`create ${role.id} ${o.name}`);
        return role;
      },
    },
    channels: { cache: channels },
    members: {
      cache: members,
      fetch: async () => members,
      fetchMe: async () => guild.members.me,
      me: { permissions: { has: (f) => (botPerms ? botPerms.includes(f) : true) }, roles: { highest: { position: botTop } } },
    },
  };
  const roleMemory = new RoleMemoryService(storage, CFG.autoRole);
  const svc = new PrivService(storage, CFG, { roleMemory, setup: { getVerifiedRoleId: () => 'VERIFIED' }, tickets: { getStaffRole: () => 'TICKETSTAFF' } });
  return { svc, guild, edits, created, log, roles, members, channels, storage, roleMemory, dir, done: () => rm(dir) };
}

const BY = { id: 'ADMIN', tag: 'admin#0', username: 'admin' };

// ---------- plan ----------

test('plan: the roles and what they open, and how the member roles are sorted', async () => {
  const k = mk({
    extraRoles: [
      { id: 'M2', name: 'member', position: 2 }, // empty duplicate: goes
      { id: 'M3', name: ' MEMBER ', position: 2 }, // duplicate with a spare permission: stays
      { id: 'M4', name: 'Member', position: 2 }, // used in a channel's permissions: stays
      { id: 'VERIFIED', name: 'member', position: 2 }, // the verified role: protected
      { id: 'M5', name: 'Member', position: 90 }, // above the bot: stays
      { id: 'MBOT', name: 'member', managed: true, position: 2 }, // a bot role: not even a candidate
    ],
    extraChannels: [{ id: 'x1', name: 'rooms', overwriteIds: ['M4'] }],
  });
  try {
    k.roles.get('M3').permissions = new PermissionsBitField(P.KickMembers);
    const plan = await k.svc.plan(k.guild);
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.priv.category.id, PRIV_CAT);
    assert.equal(plan.priv.channels, 1);
    assert.equal(plan.priv.role, null);
    assert.deepEqual(plan.staff.categories.map((c) => c.id), [STAFF_CAT, VIP_CAT]);
    assert.equal(plan.staff.channels, 3);
    assert.deepEqual(plan.staffMissing, []);

    const m = plan.member;
    assert.equal(m.keep.id, 'M1', 'the one with the most members is kept');
    assert.equal(m.rename, true);
    const by = Object.fromEntries(m.dups.map((d) => [d.id, d]));
    assert.equal(by.M2.action, 'delete');
    assert.match(by.M3.reason, /permissions the kept role lacks/);
    assert.match(by.M4.reason, /used in 1 channel permission$/);
    assert.equal(by.VERIFIED.reason, 'the verified role');
    assert.equal(by.M5.reason, 'above my highest role');
    assert.ok(!by.MBOT, 'a role owned by a bot is never touched');
    assert.equal(m.giveTo, 3, 'U4 U5 U6 lack it, the bot user is skipped');
    assert.equal(m.total, 6);
    assert.equal(k.created.length, 0, 'planning changes nothing');
  } finally {
    k.done();
  }
});

test('plan: the role new members get decides what is kept, and a differently named one is left alone', async () => {
  const k = mk({ extraRoles: [{ id: 'M2', name: 'member', position: 2 }] });
  try {
    k.roleMemory.setGuildAutoRole('G', 'M2', { id: 'x', username: 'x' });
    const plan = await k.svc.plan(k.guild);
    assert.equal(plan.member.keep.id, 'M2', 'the /aa role wins even with fewer members');
    assert.equal(plan.member.dups.find((d) => d.id === 'M1').action, 'delete');

    k.roleMemory.setGuildAutoRole('G', 'M1', { id: 'x', username: 'x' });
    k.roles.get('M1').name = 'Players';
    const other = await k.svc.plan(k.guild);
    assert.match(other.member.skip, /The role new members get is Players, so I leave the member roles alone/);
  } finally {
    k.done();
  }
});

test('plan: with no member role at all one is created, and problems stop everything', async () => {
  const k = mk();
  try {
    k.roles.delete('M1');
    for (const m of k.members.values()) m.roles.cache.delete('M1');
    const plan = await k.svc.plan(k.guild);
    assert.equal(plan.member.create, true);
    assert.equal(plan.member.giveTo, 6);
    k.guild.members.me.permissions.has = () => false;
    assert.match((await k.svc.plan(k.guild)).problems[0], /Manage Roles/);
  } finally {
    k.done();
  }
});

test('plan: categories that are not on the server are named, and the parts that do not apply are dropped', async () => {
  const k = mk();
  try {
    k.channels.delete(PRIV_CAT);
    k.channels.delete(VIP_CAT);
    const plan = await k.svc.plan(k.guild);
    assert.equal(plan.priv, null);
    assert.equal(plan.privMissing, PRIV_CAT);
    assert.deepEqual(plan.staffMissing, [VIP_CAT]);
    assert.deepEqual(plan.staff.categories.map((c) => c.id), [STAFF_CAT]);
    k.channels.delete(STAFF_CAT);
    assert.equal((await k.svc.plan(k.guild)).staff, null);
  } finally {
    k.done();
  }
});

// ---------- execute ----------

test('execute: priv has no permissions, staff has only Kick Members, each opens its own categories', async () => {
  const k = mk();
  try {
    const plan = await k.svc.plan(k.guild);
    const res = await k.svc.execute(k.guild, plan, BY);
    assert.equal(res.ok, true);

    const [privMade, staffMade] = k.created;
    assert.deepEqual([privMade.name, privMade.permissions], ['priv', []]);
    assert.deepEqual([staffMade.name, staffMade.permissions], ['staff', [P.KickMembers, P.ManageMessages]], 'kick and delete messages, nothing else');
    assert.equal(staffMade.hoist, false);
    assert.equal(staffMade.mentionable, false);

    const forRole = (id) => k.edits.filter((e) => e.role === id).map((e) => e.channel);
    assert.deepEqual(forRole(res.priv.role.id), [PRIV_CAT, 'p1']);
    assert.deepEqual(forRole(res.staff.role.id), [STAFF_CAT, 's1', 's2', VIP_CAT, 'v1', PRIV_CAT, 'p1'], 'its own categories in full, then the private category');
    assert.ok(!k.edits.some((e) => e.channel === 'g1' || e.channel === 'g-cat'), 'no other channel is touched');
    for (const e of k.edits.filter((x) => x.role === res.priv.role.id || [STAFF_CAT, 's1', 's2', VIP_CAT, 'v1'].includes(x.channel))) {
      assert.ok(['ViewChannel', 'SendMessages', 'Connect', 'Speak'].every((f) => e.allow[f] === true));
      assert.ok(Object.values(e.allow).every((v) => v === true), 'only allows');
    }
    // in the private category staff may only look: read yes, write, react, voice and deleting no
    for (const e of k.edits.filter((x) => x.role === res.staff.role.id && [PRIV_CAT, 'p1'].includes(x.channel))) {
      assert.equal(e.allow.ViewChannel, true);
      assert.equal(e.allow.ReadMessageHistory, true);
      for (const f of ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'AddReactions', 'ManageMessages', 'Connect', 'Speak']) assert.equal(e.allow[f], false, `${f} is denied`);
    }
    assert.equal(k.svc.roleId('G'), res.priv.role.id);
    assert.equal(k.svc.staffRoleId('G'), res.staff.role.id);
    assert.deepEqual(res.priv.skipped, []);
  } finally {
    k.done();
  }
});

test('execute: the member role is renamed, remembered, given to everyone and the empty duplicates are deleted', async () => {
  const k = mk({ extraRoles: [{ id: 'M2', name: 'member', position: 2 }, { id: 'M3', name: 'MEMBER', position: 2 }] });
  try {
    k.roles.get('M3').permissions = new PermissionsBitField(P.BanMembers);
    // two people only have a duplicate
    k.members.get('U5').roles.cache.set('M2', k.roles.get('M2'));
    const plan = await k.svc.plan(k.guild);
    const res = await k.svc.execute(k.guild, plan, BY);
    const m = res.member;

    assert.equal(m.renamed, true);
    assert.equal(k.roles.get('M1').name, 'member', 'written in small letters');
    assert.equal(k.roleMemory.getGuildAutoRole('G'), 'M1', 'the bot gives exactly this role to new members');
    for (const [id, member] of k.members) if (!member.user.bot) assert.ok(member.roles.cache.has('M1'), `${id} has it`);
    assert.ok(!k.members.get('BOTUSER').roles.cache.has('M1'), 'bots are skipped');
    assert.equal(m.given, 3);
    assert.equal(m.already, 3);
    assert.deepEqual(m.deleted.map((d) => d.name), ['member']);
    assert.ok(!k.roles.has('M2') && k.roles.has('M3'), 'only the empty duplicate is deleted');
    assert.deepEqual(m.kept, [{ name: 'MEMBER', reason: 'has permissions the kept role lacks' }]);

    const del = k.log.findIndex((l) => l === 'delete M2');
    assert.ok(del > k.log.findLastIndex((l) => l.startsWith('give ')), 'everyone got the role before a duplicate was deleted');
    assert.equal(k.log[del + 1], 'humans without keep at delete: 0');
  } finally {
    k.done();
  }
});

test('execute: an existing staff role only gets what it lacks, nothing is taken away, and it is not made again', async () => {
  const k = mk({ extraRoles: [{ id: 'ST', name: 'Staff', position: 2, perms: P.KickMembers | P.ManageNicknames }] });
  try {
    const plan = await k.svc.plan(k.guild);
    assert.deepEqual(plan.staff.add, ['ManageMessages']);
    assert.deepEqual(plan.staff.extra, ['ManageNicknames']);
    const first = await k.svc.execute(k.guild, plan, BY);
    assert.equal(first.staff.created, false);
    assert.deepEqual(first.staff.added, ['ManageMessages']);
    assert.equal(k.roles.get('ST').permissions.has(P.ManageMessages), true, 'delete messages was added');
    assert.equal(k.roles.get('ST').permissions.has(P.KickMembers), true);
    assert.equal(k.roles.get('ST').permissions.has(P.ManageNicknames), true, 'what it had stays');
    assert.deepEqual(first.staff.extra, ['ManageNicknames']);
    assert.deepEqual(k.created.map((c) => c.name), ['priv']);

    const again = await k.svc.plan(k.guild);
    assert.deepEqual(again.staff.add, []);
    const second = await k.svc.execute(k.guild, again, BY);
    assert.equal(second.priv.created, false, 'running it again reuses the roles');
    assert.deepEqual(second.staff.added, []);
    assert.equal(k.log.filter((l) => l.startsWith('permissions')).length, 1, 'permissions are only written when something is missing');
  } finally {
    k.done();
  }
});

test('execute: the staff role also reads the log channel when it sits outside the private category', async () => {
  const k = mk({ extraChannels: [{ id: 'LOG', name: 'logs', parentId: 'g-cat' }] });
  try {
    k.svc.config = { ...k.svc.config, logs: { channelId: 'LOG' } };
    const plan = await k.svc.plan(k.guild);
    assert.deepEqual(plan.staff.read.map((c) => c.id), [PRIV_CAT, 'p1', 'LOG']);
    const res = await k.svc.execute(k.guild, plan, BY);
    const log = k.edits.find((e) => e.channel === 'LOG');
    assert.equal(log.role, res.staff.role.id);
    assert.equal(log.allow.ViewChannel, true);
    assert.equal(log.allow.SendMessages, false);
    assert.equal(log.allow.ManageMessages, false, 'staff cannot delete log entries');
    assert.equal(k.edits.filter((e) => e.channel === 'LOG').length, 1, 'once, not twice');
  } finally {
    k.done();
  }
});

test('execute: only roles that were in the preview are deleted, and one that is used since is kept', async () => {
  const k = mk({ extraRoles: [{ id: 'M2', name: 'member', position: 2 }] });
  try {
    const approved = await k.svc.plan(k.guild);
    k.roles.set('M9', { id: 'M9', name: 'member', managed: false, position: 2, permissions: new PermissionsBitField(0n), members: new Map(), delete: async () => k.roles.delete('M9') }); // appears after the preview
    k.channels.get('g1').permissionOverwrites.cache.set('M2', {}); // M2 is used by a channel since the preview
    const res = await k.svc.execute(k.guild, approved, BY);
    assert.ok(k.roles.has('M9'), 'a role that was not in the preview is never deleted');
    assert.ok(k.roles.has('M2'), 'a role that is used by a channel now is kept');
    assert.deepEqual(res.member.deleted, []);
    assert.deepEqual(res.member.kept.map((x) => x.name).sort(), ['member', 'member']);
  } finally {
    k.done();
  }
});

test('execute: failures are named and never stop the rest; a bot that lacks a permission does not grant it', async () => {
  const k = mk({ failEdit: 's2', failGive: 'U4', botPerms: [P.ManageRoles, P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect] });
  try {
    const res = await k.svc.execute(k.guild, await k.svc.plan(k.guild), BY);
    assert.deepEqual(res.staff.failed, [{ name: 'staff voice', error: 'Missing Permissions' }]);
    assert.ok(res.staff.done.includes('vip-chat'), 'the other channels were still done');
    assert.ok(res.priv.skipped.includes('Speak'));
    assert.ok(!('Speak' in k.edits[0].allow));
    assert.equal(res.member.failedCount, 1);
    assert.match(res.member.failed[0], /U4#0: Missing Permissions/);
    assert.equal(res.member.given, 2);
  } finally {
    k.done();
  }
});

test('execute: a second run at the same time is refused', async () => {
  const k = mk();
  try {
    const plan = await k.svc.plan(k.guild);
    const [a, b] = await Promise.all([k.svc.execute(k.guild, plan, BY), k.svc.execute(k.guild, plan, BY)]);
    assert.deepEqual([a.ok, b.reason].sort(), ['busy', true].sort());
  } finally {
    k.done();
  }
});

test('the confirmation only works once, for the person who asked, in time', async () => {
  const k = mk();
  try {
    const plan = await k.svc.plan(k.guild);
    const t = k.svc.createPending('ADMIN', 'G', plan);
    assert.equal(k.svc.takePending(t, { guildId: 'G', userId: 'OTHER' }), null);
    assert.equal(k.svc.takePending(t, { guildId: 'OTHERG', userId: 'ADMIN' }), null);
    assert.equal(k.svc.takePending(t, { guildId: 'G', userId: 'ADMIN' }), plan);
    assert.equal(k.svc.takePending(t, { guildId: 'G', userId: 'ADMIN' }), null, 'used once');
    const late = k.svc.createPending('ADMIN', 'G', plan);
    k.svc.pending.get(late).expires = Date.now() - 1;
    assert.equal(k.svc.takePending(late, { guildId: 'G', userId: 'ADMIN' }), null);
  } finally {
    k.done();
  }
});

test('the role memory finds the member role whatever its capitals, so it is never made twice', async () => {
  const k = mk();
  try {
    k.roles.get('M1').name = 'MEMBER';
    const role = await k.roleMemory.ensureAutoRole(k.guild);
    assert.equal(role.id, 'M1');
    assert.equal(k.created.length, 0);
  } finally {
    k.done();
  }
});

// ---------- the command ----------

function fakeInteraction(k, { user = 'ADMIN', customId = null, perms = { has: () => true } } = {}) {
  const log = { replies: [], updates: [], dms: [] };
  const i = {
    guild: k.guild,
    guildId: 'G',
    user: { id: user, tag: 'admin#0', username: 'admin', send: async (p) => log.dms.push(p) },
    memberPermissions: perms,
    customId,
    deferred: false,
    replied: false,
    deferReply: async () => { i.deferred = true; },
    editReply: async (p) => log.replies.push(p),
    reply: async (p) => { i.replied = true; log.replies.push(p); },
    update: async (p) => log.updates.push(p),
  };
  return { i, log };
}
const ctxFor = (k) => {
  const posted = [];
  let held = 0;
  let released = 0;
  return { posted, state: () => ({ held, released }), ctx: { priv: k.svc, isManager: () => false, logs: { hold: () => { held += 1; return () => { released += 1; }; }, post: (g, e) => posted.push(e.toJSON()) } } };
};
const embed = (p) => p.embeds[0].toJSON();
const fieldOf = (e, name) => (e.fields.find((f) => f.name === name) || {}).value;

test('/priv: a preview of everything, nothing changed, and two buttons', async () => {
  const k = mk({ extraRoles: [{ id: 'M2', name: 'member', position: 2 }] });
  try {
    const { i, log } = fakeInteraction(k);
    const { ctx } = ctxFor(k);
    await priv.execute(i, ctx);
    const e = embed(log.replies[0]);
    assert.equal(e.title, 'Priv setup preview');
    assert.match(e.description, /Nothing has changed yet/);
    assert.match(e.description, /Deleted roles cannot be brought back/);
    assert.match(fieldOf(e, 'Priv role'), /A role called priv will be created, with no permissions of its own\. It opens \*\*PRIVATE\*\* and 1 channel inside/);
    assert.match(fieldOf(e, 'Staff role'), /created that can \*\*only kick people and delete messages\*\*.*\*\*STAFF\*\* and \*\*VIP\*\* and 3 channels inside/);
    assert.match(fieldOf(e, 'Staff in the private category'), /It can see 2 channels there.*It cannot write, react, join voice or delete messages in them/);
    assert.match(fieldOf(e, 'Member role'), /<@&M1> is the one that stays.*renamed from Member to \*\*member\*\*.*New members get exactly this role.*given to 3 of 6 members/);
    assert.match(fieldOf(e, 'Deleted (1)'), /member, 0 members/);
    const ids = log.replies[0].components[0].toJSON().components.map((c) => c.custom_id);
    assert.match(ids[0], /^priv:go:/);
    assert.equal(k.created.length, 0);
    assert.equal(k.edits.length, 0);
  } finally {
    k.done();
  }
});

test('/priv: Run does it all, mutes the log once and shows the result; Cancel and strangers do nothing', async () => {
  const k = mk({ extraRoles: [{ id: 'M2', name: 'member', position: 2 }] });
  try {
    const { ctx, posted, state } = ctxFor(k);
    const first = fakeInteraction(k);
    await priv.execute(first.i, ctx);
    const [go, no] = first.log.replies[0].components[0].toJSON().components.map((c) => c.custom_id);

    // Cancel
    const cancel = fakeInteraction(k, { customId: no });
    await priv.handleButton(cancel.i, ctx);
    assert.equal(embed(cancel.log.updates[0]).title, 'Cancelled');
    assert.equal(k.created.length, 0);
    const gone = fakeInteraction(k, { customId: go });
    await priv.handleButton(gone.i, ctx);
    assert.equal(embed(gone.log.updates[0]).title, 'Preview expired');

    // not an admin
    const second = fakeInteraction(k);
    await priv.execute(second.i, ctx);
    const goId = second.log.replies[0].components[0].toJSON().components[0].custom_id;
    const noAdmin = fakeInteraction(k, { customId: goId, perms: { has: () => false } });
    await priv.handleButton(noAdmin.i, ctx);
    assert.match(embed(noAdmin.log.replies[0]).description, /Only admins can use \/priv/);
    // somebody else's button
    const stranger = fakeInteraction(k, { customId: goId, user: 'OTHER' });
    await priv.handleButton(stranger.i, ctx);
    assert.equal(embed(stranger.log.updates[0]).title, 'Preview expired');
    assert.equal(k.created.length, 0);

    // Run
    const run = fakeInteraction(k, { customId: goId });
    await priv.handleButton(run.i, ctx);
    const done = embed(run.log.replies[run.log.replies.length - 1]);
    assert.equal(done.title, 'Priv setup done');
    assert.match(fieldOf(done, 'Priv role'), /created\. Opened 2 channels/);
    assert.match(fieldOf(done, 'Staff role'), /created\. It can only kick people and delete messages\. Opened 5 channels, and can read 2 channels in the private category and the log/);
    assert.match(fieldOf(done, 'Member role'), /renamed\. Given to 3 members, 3 already had it/);
    assert.match(fieldOf(done, 'Deleted (1)'), /member, 0 members/);
    assert.deepEqual(state(), { held: 1, released: 1 });
    assert.equal(posted[0].title, 'Roles set up with /priv');
    assert.equal(k.roles.get('M1').name, 'member');

    // a result that cannot be shown in the reply goes by DM
    const third = fakeInteraction(k);
    await priv.execute(third.i, ctx);
    const goId3 = third.log.replies[0].components[0].toJSON().components[0].custom_id;
    const dm = fakeInteraction(k, { customId: goId3 });
    dm.i.editReply = async () => { throw new Error('Unknown Webhook'); };
    await priv.handleButton(dm.i, ctx);
    assert.equal(embed(dm.log.dms[0]).title, 'Priv setup done');
  } finally {
    k.done();
  }
});

test('/priv: problems and "nothing to do" are explained before any button', async () => {
  const k = mk({ botPerms: [P.ViewChannel] });
  try {
    const { ctx } = ctxFor(k);
    const a = fakeInteraction(k);
    await priv.execute(a.i, ctx);
    assert.match(embed(a.log.replies[0]).description, /Manage Roles/);
    assert.equal(a.log.replies[0].components, undefined);
  } finally {
    k.done();
  }
  const k2 = mk();
  try {
    for (const id of [PRIV_CAT, STAFF_CAT, VIP_CAT]) k2.channels.delete(id);
    k2.roleMemory.setGuildAutoRole('G', 'M1', { id: 'x', username: 'x' });
    k2.roles.get('M1').name = 'Players';
    const { ctx } = ctxFor(k2);
    const b = fakeInteraction(k2);
    await priv.execute(b.i, ctx);
    assert.match(embed(b.log.replies[0]).description, /Nothing to do here/);
  } finally {
    k2.done();
  }
});

test('/priv is for admins and follows the house format', () => {
  const call = (user, perms) => refusal(commands.get('priv'), { commandName: 'priv', user: { id: user }, guild: { ownerId: 'OWNER' }, memberPermissions: perms, inGuild: () => true }, { isManager: (u) => u.id === 'MGR', verifiedGate: () => ({ ok: true }) });
  assert.equal(call('A', { has: (f) => f === P.Administrator }), null);
  assert.equal(call('OWNER', { has: () => false }), null);
  assert.match(call('MOD', { has: () => false }), /Only admins can use \/priv/);
  const json = priv.data.toJSON();
  assert.equal(json.description, 'Set up the priv, staff and member roles in one go (admins only)');
  assert.ok(json.description.length <= 100 && !json.description.endsWith('.'));
  assert.deepEqual(json.options || [], []);
  assert.ok(Object.keys(GRANT).includes('Connect') && Object.keys(GRANT).includes('Speak'));
  assert.equal(priv.noCooldown, true);
});
