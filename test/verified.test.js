'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const { Storage } = require('../src/storage');
const { VerifiedService } = require('../src/services/verified');
const { tmpDir, rm } = require('./helpers');

const CFG = { verified: { roleId: 'VER' } };
const guild = (roleIds = ['VER'], channelIds = []) => ({
  id: 'G',
  ownerId: 'OWNER',
  roles: { cache: new Map(roleIds.map((id) => [id, {}])) },
  channels: { cache: new Map(channelIds.map((id) => [id, {}])) },
});
const member = (roles = [], perms = []) => ({ roles: { cache: new Set(roles) }, permissions: { has: (p) => perms.includes(p) } });
const opts = { isManager: (u) => u.id === 'MGR', isBypass: (u) => u.id === 'BYP' };

test('the verified role and the verify channel are found, saved ones first', () => {
  const dir = tmpDir();
  try {
    const storage = new Storage(path.join(dir, 'db.json'));
    const svc = new VerifiedService(storage, CFG);
    assert.equal(svc.getVerifiedRoleId(guild(['VER'])), 'VER', 'the configured role, when the server has it');
    assert.equal(svc.getVerifiedRoleId(guild(['OTHER'])), null, 'a server without it has no verified role');
    assert.equal(svc.getVerifyChannelId(guild()), null);

    storage.data.setup.G = { roles: { verified: 'SAVED' }, channels: { verify_ch: 'VCH' } };
    assert.equal(svc.getVerifiedRoleId(guild(['VER', 'SAVED'])), 'SAVED', 'the saved role wins');
    assert.equal(svc.getVerifiedRoleId(guild(['VER'])), 'VER', 'a saved role that is gone is ignored');
    assert.equal(svc.getVerifyChannelId(guild(['VER'], ['VCH'])), 'VCH');
    assert.equal(svc.getVerifyChannelId(guild(['VER'], [])), null, 'a channel that is gone is ignored');
  } finally {
    rm(dir);
  }
});

test('the gate: the verified role, owner, admins, manager and bypass pass; everyone else is sent to the verify channel', () => {
  const dir = tmpDir();
  try {
    const storage = new Storage(path.join(dir, 'db.json'));
    const svc = new VerifiedService(storage, CFG);
    const g = guild(['VER'], ['VCH']);
    storage.data.setup.G = { roles: {}, channels: { verify_ch: 'VCH' } };

    const no = svc.verifiedGate(g, member([]), { id: 'U1' }, opts);
    assert.deepEqual(no, { ok: false, roleId: 'VER', channelId: 'VCH' });
    assert.equal(svc.verifiedGate(g, member(['VER']), { id: 'U1' }, opts).ok, true);
    assert.equal(svc.verifiedGate(g, member([]), { id: 'OWNER' }, opts).ok, true);
    assert.equal(svc.verifiedGate(g, member([]), { id: 'MGR' }, opts).ok, true);
    assert.equal(svc.verifiedGate(g, member([]), { id: 'BYP' }, opts).ok, true);
    assert.equal(svc.verifiedGate(g, member([], [P.Administrator]), { id: 'U2' }, opts).ok, true);
    assert.equal(svc.verifiedGate(g, member([], [P.ManageGuild]), { id: 'U2' }, opts).ok, true);
    assert.equal(svc.verifiedGate(guildless(), member([]), { id: 'U1' }, opts).ok, false);

    // a server with no known verified role stays open
    assert.equal(svc.verifiedGate(guild(['OTHER']), member([]), { id: 'U1' }, opts).ok, true);
  } finally {
    rm(dir);
  }
});
const guildless = () => null;
