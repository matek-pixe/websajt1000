'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const { Storage } = require('../src/storage');
const { RoleMemoryService } = require('../src/services/roleMemory');
const roles = require('../src/commands/roles');
const { tmpDir, rm } = require('./helpers');

function fakeGuild(memberIds = []) {
  return {
    id: 'G',
    roles: {
      cache: new Map([
        ['G', { id: 'G', position: 0, managed: false }],
        ['low', { id: 'low', position: 2, managed: false }],
        ['high', { id: 'high', position: 9, managed: false }],
      ]),
    },
    members: {
      me: { roles: { highest: { position: 5 } } },
      cache: new Map(memberIds.map((id) => [id, { id }])),
      fetch: async (id) => {
        if (memberIds.includes(id)) return { id };
        throw new Error('Unknown Member');
      },
    },
  };
}

function fakeInteraction({ user, member, guild, pickedUser = null, id = null }) {
  const st = { replies: [] };
  return {
    user: { id: user },
    member,
    guild,
    inGuild: () => true,
    options: { getUser: () => pickedUser, getString: () => id },
    async reply(p) {
      st.replies.push(p);
      return {};
    },
    _st: st,
  };
}

const admin = { permissions: { has: (p) => p === PermissionFlagsBits.Administrator } };
const plain = { permissions: { has: () => false } };

test('/roles: staff only', () => {
  const ctx = { isManager: (u) => u.id === 'MGR' };
  assert.equal(roles._canUse({ user: { id: 'MGR' }, member: plain }, ctx), true);
  assert.equal(roles._canUse({ user: { id: 'A' }, member: admin }, ctx), true);
  assert.equal(roles._canUse({ user: { id: 'P' }, member: plain }, ctx), false);
});

test('/roles: shows remembered roles for someone who left, split by restorable / above bot', async () => {
  const dir = tmpDir();
  try {
    const storage = new Storage(path.join(dir, 'db.json'));
    const roleMemory = new RoleMemoryService(storage, { id: '', name: 'Member' });
    const LEFT = '123456789012345678'; // a real-looking snowflake of someone who already left
    storage.data.roles.G = { [LEFT]: { roles: ['low', 'high', 'gone'], username: 'matija', updatedAt: '2026-01-01T00:00:00.000Z' } };
    const ctx = { isManager: () => false, roleMemory, refundCooldown() {} };

    // by pasted id, user not in the server anymore
    const i = fakeInteraction({ user: 'A', member: admin, guild: fakeGuild([]), id: LEFT });
    await roles.execute(i, ctx);
    const embed = i._st.replies[0].embeds[0].toJSON();
    assert.ok(embed.description.includes('not in the server'));
    assert.ok(embed.description.includes('matija'));
    const field = (prefix) => embed.fields.find((f) => f.name.startsWith(prefix));
    assert.ok(field('✅').value.includes('<@&low>'));
    assert.ok(field('⚠️').value.includes('<@&high>'));
    assert.ok(field('🗑️').value.includes('`gone`'));
    assert.ok(field('🕒'));
    assert.equal(i._st.replies[0].flags, 64); // ephemeral

    // unknown user -> "nothing remembered"
    const j = fakeInteraction({ user: 'A', member: admin, guild: fakeGuild(['1'.repeat(18)]), pickedUser: { id: '1'.repeat(18) } });
    await roles.execute(j, ctx);
    const e2 = j._st.replies[0].embeds[0].toJSON();
    assert.ok(e2.description.includes('in the server'));
    assert.ok(e2.fields[0].value.includes('Nothing remembered'));

    // bad input
    const k = fakeInteraction({ user: 'A', member: admin, guild: fakeGuild([]), id: 'abc' });
    await roles.execute(k, ctx);
    assert.ok(k._st.replies[0].content.includes('valid'));

    // non-staff denied
    const l = fakeInteraction({ user: 'P', member: plain, guild: fakeGuild([]), id: '1'.repeat(18) });
    await roles.execute(l, ctx);
    assert.ok(l._st.replies[0].content.includes('Only staff'));
  } finally {
    rm(dir);
  }
});
