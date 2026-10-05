'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const ban = require('../src/commands/ban');
const { refusal, isAdminOrAbove } = require('../src/gates');
const { commands } = require('../src/commands');

const isManager = (u) => u.id === 'MGR';
const perms = (...flags) => ({ has: (f) => flags.includes(f) });
const role = (position) => ({ position });

/** A /ban call with a fake server. `target` is the member being banned (null = not on the server). */
function run({ invoker = 'ADMIN', targetId = 'T1', reason = 'cheating', target = { bannable: true, highest: 1 }, botCan = true, invokerHighest = 5, banFails = false, owner = 'OWNER' } = {}) {
  const bans = [];
  const replies = [];
  let refunds = 0;
  const guild = {
    ownerId: owner,
    members: {
      me: { permissions: perms(...(botCan ? [PermissionFlagsBits.BanMembers] : [])) },
      fetch: async () => null,
      ban: async (id, o) => {
        if (banFails) throw new Error('Missing Permissions');
        bans.push({ id, ...o });
      },
    },
  };
  const targetMember = target ? { bannable: target.bannable, roles: { highest: role(target.highest) } } : null;
  const interaction = {
    guild,
    client: { user: { id: 'BOT' } },
    user: { id: invoker, tag: 'admin#0', username: 'admin' },
    member: { roles: { highest: role(invokerHighest) } },
    options: {
      getUser: () => ({ id: targetId }),
      getString: () => reason,
      getMember: () => targetMember,
    },
    deferred: false,
    replied: false,
    reply: async (p) => replies.push(p),
  };
  const ctx = { isManager, isOwnerOrManager: () => invoker === 'MGR' || invoker === owner, refundCooldown: () => (refunds += 1) };
  return { go: () => ban.execute(interaction, ctx), bans, replies, refunds: () => refunds };
}
const text = (r) => r.replies[0].embeds[0].toJSON();

test('/ban: an admin bans a member and the reason lands in the audit log with their name', async () => {
  const r = run();
  await r.go();
  assert.equal(r.bans.length, 1);
  assert.equal(r.bans[0].id, 'T1');
  assert.equal(r.bans[0].reason, 'admin#0 (ADMIN): cheating');
  assert.equal(text(r).title, 'Member banned');
  assert.equal(text(r).fields[0].value, 'cheating');
  assert.equal(r.refunds(), 0);
});

test('/ban: the reason is optional and a long one is cut to what Discord accepts', async () => {
  const none = run({ reason: null });
  await none.go();
  assert.match(none.bans[0].reason, /No reason given$/);
  assert.equal(text(none).fields[0].value, 'No reason given');

  const long = run({ reason: 'x'.repeat(400) });
  await long.go();
  assert.ok(long.bans[0].reason.length <= 512);
});

test('/ban: a person who already left can still be banned by their id', async () => {
  const r = run({ target: null });
  await r.go();
  assert.equal(r.bans.length, 1);
});

test('/ban: nobody can ban themselves, the bot, the owner or the manager', async () => {
  for (const [opts, word] of [[{ targetId: 'ADMIN' }, /yourself/], [{ targetId: 'BOT' }, /myself/], [{ targetId: 'OWNER' }, /cannot be banned/], [{ targetId: 'MGR' }, /cannot be banned/]]) {
    const r = run(opts);
    await r.go();
    assert.equal(r.bans.length, 0);
    assert.match(text(r).description, word);
    assert.equal(r.refunds(), 1, 'a refusal does not spend the cooldown');
  }
});

test('/ban: the target must sit below the admin and below the bot', async () => {
  const same = run({ target: { bannable: true, highest: 5 }, invokerHighest: 5 });
  await same.go();
  assert.equal(same.bans.length, 0);
  assert.match(text(same).description, /not below yours/);

  const botBlocked = run({ target: { bannable: false, highest: 1 } });
  await botBlocked.go();
  assert.equal(botBlocked.bans.length, 0);
  assert.match(text(botBlocked).description, /My role has to be above theirs/);

  // the owner and the manager do not need to out-rank anyone
  const owner = run({ invoker: 'OWNER', target: { bannable: true, highest: 99 }, invokerHighest: 1 });
  await owner.go();
  assert.equal(owner.bans.length, 1);
});

test('/ban: without Ban Members, or when Discord refuses, the answer says so and the cooldown is refunded', async () => {
  const noPerm = run({ botCan: false });
  await noPerm.go();
  assert.equal(noPerm.bans.length, 0);
  assert.match(text(noPerm).description, /Ban Members/);

  const refused = run({ banFails: true });
  await refused.go();
  assert.match(text(refused).description, /Could not ban them: Missing Permissions/);
  assert.equal(refused.refunds(), 1);
});

test('/ban is for admins: owner and manager always, a member only with Administrator', () => {
  const call = (user, memberPermissions, owner = 'OWNER') =>
    refusal(commands.get('ban'), { commandName: 'ban', user: { id: user }, guild: { ownerId: owner }, memberPermissions, inGuild: () => true }, { isManager, verifiedGate: () => ({ ok: true }) });
  assert.equal(call('ADMIN', perms(PermissionFlagsBits.Administrator)), null);
  assert.equal(call('OWNER', perms()), null);
  assert.equal(call('MGR', perms()), null);
  assert.match(call('MOD', perms(PermissionFlagsBits.BanMembers)), /Only admins can use \/ban/);
  assert.match(call('NOBODY', undefined), /Only admins can use \/ban/);
  assert.equal(isAdminOrAbove({ user: { id: 'X' }, guild: null, memberPermissions: perms(PermissionFlagsBits.Administrator) }, isManager), true);
});

test('/ban: definition', () => {
  const json = ban.data.toJSON();
  assert.equal(json.description, 'Ban a member and record the reason (admins only)');
  assert.deepEqual(json.options.map((o) => [o.name, !!o.required]), [['user', true], ['reason', false]]);
  assert.equal(json.options[1].max_length, 400);
  assert.equal(ban.adminOnly, true);
  assert.equal(ban.audit, true);
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.Administrator));
});
