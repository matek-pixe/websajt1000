'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Storage } = require('../src/storage');
const { BypassService } = require('../src/services/bypass');
const { tmpDir, rm } = require('./helpers');

const CFG = { manager: { id: 'MGR' } };

test('bypass is off by default, toggles, and persists across a reload', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const b = new BypassService(new Storage(file), CFG);
    assert.equal(b.isEnabled(), false);
    assert.equal(b.toggle(), true);
    assert.equal(b.isEnabled(), true);

    const b2 = new BypassService(new Storage(file), CFG);
    assert.equal(b2.isEnabled(), true); // survived the "restart"
    assert.equal(b2.set(false), false);
    assert.equal(b2.set(true), true);
    assert.equal(b2.toggle(), false);
  } finally {
    rm(dir);
  }
});

test('bypass applies only to the manager, and only while it is on', () => {
  const dir = tmpDir();
  try {
    const b = new BypassService(new Storage(path.join(dir, 'db.json')), CFG);
    const manager = { id: 'MGR' };
    const other = { id: 'U1' };
    assert.equal(b.applies(manager), false); // off
    b.set(true);
    assert.equal(b.applies(manager), true);
    assert.equal(b.applies(other), false); // never for anyone else
    assert.equal(b.applies(null), false);
  } finally {
    rm(dir);
  }
});

test('per-user grants: give, list, revoke, toggle; independent of the manager switch; persisted', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const b = new BypassService(new Storage(file), CFG);
    const alice = { id: '111111111111111111' };

    assert.equal(b.applies(alice), false);
    assert.equal(b.toggleUser(alice.id, 'MGR'), true); // granted
    assert.equal(b.has(alice.id), true);
    assert.equal(b.applies(alice), true); // even though the manager switch is OFF
    assert.equal(b.isEnabled(), false);
    assert.equal(b.skipsCooldown({ noCooldown: false }, alice), true);
    assert.deepEqual(b.list().map((r) => r.id), [alice.id]);
    assert.equal(b.list()[0].by, 'MGR');

    // survives a restart
    const b2 = new BypassService(new Storage(file), CFG);
    assert.equal(b2.has(alice.id), true);

    // toggle again -> revoked; revoking twice is a no-op
    assert.equal(b2.toggleUser(alice.id), false);
    assert.equal(b2.applies(alice), false);
    assert.equal(b2.revoke(alice.id), false);
    assert.deepEqual(b2.list(), []);

    // explicit grant/revoke
    assert.equal(b2.grant(alice.id), true);
    assert.equal(b2.revoke(alice.id), true);
  } finally {
    rm(dir);
  }
});

test('/b command: give / remove / list for other people, own switch unchanged', async () => {
  const dir = tmpDir();
  try {
    const b = new BypassService(new Storage(path.join(dir, 'db.json')), CFG);
    const cmd = require('../src/commands/bypass');
    const ctx = { bypass: b, config: { manager: { id: 'MGR' } } };
    const bob = { id: '222222222222222222', username: 'bob' };
    const run = async (mode, user) => {
      const st = [];
      await cmd.execute(
        { user: { id: 'MGR' }, options: { getString: () => mode, getUser: () => user }, async reply(p) { st.push(p); return {}; } },
        ctx,
      );
      return st[0].embeds[0].toJSON();
    };

    let e = await run(null, bob);
    assert.equal(e.title, '⚡ Bypass given');
    assert.equal(b.has(bob.id), true);
    assert.equal(b.isEnabled(), false); // own switch untouched

    e = await run('list', null);
    assert.equal(e.title, '⚡ Bypass list');
    assert.ok(e.fields[1].value.includes(`<@${bob.id}>`));
    assert.ok(e.fields[0].value.includes('OFF'));

    e = await run('off', bob);
    assert.equal(e.title, 'Bypass removed');
    assert.equal(b.has(bob.id), false);

    e = await run('on', bob);
    assert.equal(e.title, '⚡ Bypass given');
    assert.equal(b.has(bob.id), true);

    // targeting the manager themselves = own switch
    e = await run(null, { id: 'MGR', username: '35bf' });
    assert.equal(e.title, '⚡ Bypass ON');
    assert.equal(b.isEnabled(), true);
  } finally {
    rm(dir);
  }
});

test('skipsCooldown: noCooldown commands always skip; the manager skips only with bypass on', () => {
  const dir = tmpDir();
  try {
    const b = new BypassService(new Storage(path.join(dir, 'db.json')), CFG);
    const normal = { noCooldown: false };
    const free = { noCooldown: true };
    const manager = { id: 'MGR' };
    const other = { id: 'U1' };

    assert.equal(b.skipsCooldown(free, other), true);
    assert.equal(b.skipsCooldown(normal, manager), false);
    assert.equal(b.skipsCooldown(normal, other), false);
    b.set(true);
    assert.equal(b.skipsCooldown(normal, manager), true);
    assert.equal(b.skipsCooldown(normal, other), false);
  } finally {
    rm(dir);
  }
});
