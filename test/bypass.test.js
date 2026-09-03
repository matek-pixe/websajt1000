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
