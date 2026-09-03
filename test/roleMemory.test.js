'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Storage } = require('../src/storage');
const {
  RoleMemoryService,
  rolesToRemember,
  rolesToApplyOnJoin,
} = require('../src/services/roleMemory');
const { tmpDir, rm } = require('./helpers');

test('rolesToRemember drops @everyone and managed roles and de-dupes', () => {
  const guildId = 'G';
  const managed = new Set(['boost']);
  const out = rolesToRemember(['G', 'boost', 'vip', 'vip', 'mod'], guildId, managed);
  assert.deepEqual(out, ['vip', 'mod']);
});

test('rolesToApplyOnJoin puts the auto role first and keeps only assignable roles', () => {
  const assignable = new Set(['auto', 'vip']);
  const out = rolesToApplyOnJoin({
    remembered: ['vip', 'gone', 'auto'],
    autoRoleId: 'auto',
    assignableRoleIds: assignable,
  });
  assert.deepEqual(out, ['auto', 'vip']); // auto first, 'gone' not assignable, no dupes
});

test('rolesToApplyOnJoin works with no auto role', () => {
  const out = rolesToApplyOnJoin({
    remembered: ['vip'],
    autoRoleId: null,
    assignableRoleIds: new Set(['vip']),
  });
  assert.deepEqual(out, ['vip']);
});

test('remember persists roles keyed by guild + user id and survives a reload', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const storage = new Storage(file);
    const svc = new RoleMemoryService(storage, { id: '', name: 'Member' });

    // minimal fake member with the shape the service reads
    const guild = {
      id: 'G',
      roles: { cache: new Map([['G', { id: 'G', managed: false }]]) },
    };
    guild.roles.cache.set('vip', { id: 'vip', managed: false });
    guild.roles.cache.set('boost', { id: 'boost', managed: true });
    const member = {
      id: 'U1',
      guild,
      user: { username: 'matija' },
      roles: {
        cache: new Map([
          ['G', { id: 'G' }],
          ['vip', { id: 'vip' }],
          ['boost', { id: 'boost' }],
        ]),
        // map(fn) like discord.js Collection
      },
    };
    member.roles.cache.map = function (fn) {
      return [...this.values()].map(fn);
    };

    const kept = svc.remember(member);
    assert.deepEqual(kept, ['vip']); // @everyone + managed dropped

    // reload
    const svc2 = new RoleMemoryService(new Storage(file), { id: '', name: 'Member' });
    assert.deepEqual(svc2.getRemembered('G', 'U1'), ['vip']);
    assert.deepEqual(svc2.getRemembered('G', 'nobody'), []);
  } finally {
    rm(dir);
  }
});

test('forget wipes a user\'s remembered roles (used on ban)', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const storage = new Storage(file);
    const svc = new RoleMemoryService(storage, { id: '', name: 'Member' });

    // seed a snapshot directly
    storage.data.roles.G = { U1: { roles: ['vip'], username: 'x', updatedAt: 't' } };
    storage.save();
    assert.deepEqual(svc.getRemembered('G', 'U1'), ['vip']);

    assert.equal(svc.forget('G', 'U1'), true);
    assert.deepEqual(svc.getRemembered('G', 'U1'), []);
    assert.equal(svc.forget('G', 'U1'), false); // already gone
    assert.equal(svc.forget('nope', 'U1'), false); // unknown guild
  } finally {
    rm(dir);
  }
});

test('per-guild auto role set via /aa persists and takes priority in ensureAutoRole', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const svc = new RoleMemoryService(new Storage(file), { id: '', name: 'Member' });

    assert.equal(svc.getGuildAutoRole('G'), null);
    svc.setGuildAutoRole('G', 'ROLE1', { id: 'owner', username: 'matija' });
    assert.equal(svc.getGuildAutoRole('G'), 'ROLE1');

    // survives a reload
    const svc2 = new RoleMemoryService(new Storage(file), { id: 'ENVROLE', name: 'Member' });
    assert.equal(svc2.getGuildAutoRole('G'), 'ROLE1');

    // ensureAutoRole returns the configured role even when an env AUTO_ROLE_ID is also set
    const roleObj = { id: 'ROLE1', name: 'VIP', managed: false };
    const guild = { id: 'G', roles: { cache: new Map([['ROLE1', roleObj]]) } };
    const resolved = await svc2.ensureAutoRole(guild);
    assert.equal(resolved.id, 'ROLE1');

    // clearing it returns null
    svc2.setGuildAutoRole('G', null, { id: 'owner', username: 'matija' });
    assert.equal(svc2.getGuildAutoRole('G'), null);
  } finally {
    rm(dir);
  }
});
