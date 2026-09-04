'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const massrole = require('../src/commands/massrole');

function fakeMember(id, { roles = [], bot = false, perms = [] } = {}) {
  const cache = new Map(roles.map((r) => [r, { id: r }]));
  const m = {
    id,
    user: { id, tag: `${id}#0`, username: id, bot },
    permissions: { has: (p) => perms.includes(p) },
    roles: {
      cache,
      add: async (r) => {
        cache.set(r, { id: r });
      },
      remove: async (r) => {
        cache.delete(r);
      },
    },
  };
  return m;
}

function fakeGuild(members, { botHighest = 10, botPerms = [PermissionFlagsBits.ManageRoles] } = {}) {
  const coll = new Map(members.map((m) => [m.id, m]));
  return {
    id: 'G',
    ownerId: 'OWNER',
    members: {
      me: { permissions: { has: (p) => botPerms.includes(p) }, roles: { highest: { position: botHighest } } },
      fetch: async () => coll,
    },
  };
}

function fakeInteraction({ user, member, guild, role, action = null, bots = null }) {
  const st = { replies: [], edits: [] };
  return {
    user: { id: user, tag: `${user}#0`, username: user },
    member,
    guild,
    inGuild: () => true,
    options: {
      getRole: () => role,
      getString: () => action,
      getBoolean: () => bots,
    },
    async reply(p) {
      st.replies.push(p);
      return {};
    },
    async deferReply(p) {
      st.deferred = p;
      return {};
    },
    async editReply(p) {
      st.edits.push(p);
      return {};
    },
    _st: st,
  };
}

const ctxFor = (managerId = 'MGR') => ({ isManager: (u) => u.id === managerId, refundCooldown() {} });
const ROLE = { id: 'R', position: 2, managed: false };

test('pickTargets skips bots unless asked; needsChange respects give/remove', () => {
  const ms = new Map([
    ['a', fakeMember('a')],
    ['b', fakeMember('b', { bot: true })],
  ]);
  assert.deepEqual(massrole._pickTargets(ms).map((m) => m.id), ['a']);
  assert.deepEqual(massrole._pickTargets(ms, { bots: true }).map((m) => m.id), ['a', 'b']);
  const has = fakeMember('x', { roles: ['R'] });
  const lacks = fakeMember('y');
  assert.equal(massrole._needsChange(has, 'R', 'give'), false);
  assert.equal(massrole._needsChange(lacks, 'R', 'give'), true);
  assert.equal(massrole._needsChange(has, 'R', 'remove'), true);
  assert.equal(massrole._needsChange(lacks, 'R', 'remove'), false);
});

test('canUse: admins, the owner and the manager only', () => {
  const ctx = ctxFor();
  const guild = fakeGuild([]);
  const admin = fakeMember('A', { perms: [PermissionFlagsBits.Administrator] });
  const plain = fakeMember('P');
  assert.equal(massrole._canUse({ user: { id: 'A' }, member: admin, guild }, ctx), true);
  assert.equal(massrole._canUse({ user: { id: 'OWNER' }, member: plain, guild }, ctx), true);
  assert.equal(massrole._canUse({ user: { id: 'MGR' }, member: plain, guild }, ctx), true);
  assert.equal(massrole._canUse({ user: { id: 'P' }, member: plain, guild }, ctx), false);
});

test('/f gives the role to everyone who lacks it, skips bots and those who have it', async () => {
  const members = [
    fakeMember('a'),
    fakeMember('b', { roles: ['R'] }),
    fakeMember('c'),
    fakeMember('bot', { bot: true }),
  ];
  const guild = fakeGuild(members);
  const admin = fakeMember('ADM', { perms: [PermissionFlagsBits.Administrator] });
  const i = fakeInteraction({ user: 'ADM', member: admin, guild, role: ROLE });
  await massrole.execute(i, ctxFor());

  assert.equal(members[0].roles.cache.has('R'), true);
  assert.equal(members[2].roles.cache.has('R'), true);
  assert.equal(members[3].roles.cache.has('R'), false); // bot skipped
  const embed = i._st.edits.at(-1).embeds[0].toJSON();
  const field = (n) => embed.fields.find((f) => f.name === n).value;
  assert.equal(field('Given'), '2');
  assert.equal(field('Already had it'), '1');
  assert.equal(field('Failed'), '0');
  assert.ok(embed.description.includes('3 members'));
});

test('/f action:remove takes the role away; bots:true includes bots', async () => {
  const members = [fakeMember('a', { roles: ['R'] }), fakeMember('b'), fakeMember('bot', { roles: ['R'], bot: true })];
  const guild = fakeGuild(members);
  const admin = fakeMember('ADM', { perms: [PermissionFlagsBits.Administrator] });
  const i = fakeInteraction({ user: 'ADM', member: admin, guild, role: ROLE, action: 'remove', bots: true });
  await massrole.execute(i, ctxFor());
  assert.equal(members[0].roles.cache.has('R'), false);
  assert.equal(members[2].roles.cache.has('R'), false);
  const embed = i._st.edits.at(-1).embeds[0].toJSON();
  assert.equal(embed.fields.find((f) => f.name === 'Removed').value, '2');
  assert.equal(embed.fields.find((f) => f.name === 'Did not have it').value, '1');
});

test('/f refuses non-admins and un-assignable roles, and counts failures', async () => {
  const plain = fakeMember('P');
  let i = fakeInteraction({ user: 'P', member: plain, guild: fakeGuild([]), role: ROLE });
  await massrole.execute(i, ctxFor());
  assert.ok(i._st.replies[0].content.includes('Only administrators'));

  const admin = fakeMember('ADM', { perms: [PermissionFlagsBits.Administrator] });
  // role above the bot
  i = fakeInteraction({ user: 'ADM', member: admin, guild: fakeGuild([], { botHighest: 1 }), role: ROLE });
  await massrole.execute(i, ctxFor());
  assert.ok(i._st.replies[0].content.includes('above'));
  // managed role
  i = fakeInteraction({ user: 'ADM', member: admin, guild: fakeGuild([]), role: { ...ROLE, managed: true } });
  await massrole.execute(i, ctxFor());
  assert.ok(i._st.replies[0].content.includes('managed'));
  // @everyone
  i = fakeInteraction({ user: 'ADM', member: admin, guild: fakeGuild([]), role: { ...ROLE, id: 'G' } });
  await massrole.execute(i, ctxFor());
  assert.ok(i._st.replies[0].content.includes('@everyone'));
  // bot lacks Manage Roles
  i = fakeInteraction({ user: 'ADM', member: admin, guild: fakeGuild([], { botPerms: [] }), role: ROLE });
  await massrole.execute(i, ctxFor());
  assert.ok(i._st.replies[0].content.includes('Manage Roles'));

  // one member fails -> counted, others still done
  const bad = fakeMember('bad');
  bad.roles.add = async () => {
    throw new Error('Missing Permissions');
  };
  const members = [fakeMember('ok'), bad];
  i = fakeInteraction({ user: 'ADM', member: admin, guild: fakeGuild(members), role: ROLE });
  await massrole.execute(i, ctxFor());
  const embed = i._st.edits.at(-1).embeds[0].toJSON();
  assert.equal(embed.fields.find((f) => f.name === 'Given').value, '1');
  assert.equal(embed.fields.find((f) => f.name === 'Failed').value, '1');
  assert.ok(embed.fields.find((f) => f.name === 'Errors (first few)').value.includes('bad#0'));
});
