'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Storage } = require('../src/storage');
const { tmpDir, rm } = require('./helpers');

test('fresh storage returns defaults with both pools', () => {
  const dir = tmpDir();
  try {
    const s = new Storage(path.join(dir, 'db.json'));
    assert.deepEqual(s.data.pools.steam.available, []);
    assert.deepEqual(s.data.pools.fivem.available, []);
    assert.deepEqual(s.data.pools.steam.given, {});
    assert.ok(s.data.usage.steam && s.data.usage.fivem);
    assert.deepEqual(s.data.roles, {});
  } finally {
    rm(dir);
  }
});

test('save is atomic and round-trips', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const s = new Storage(file);
    s.data.pools.steam.available.push('a:1');
    s.save();
    // no leftover temp file
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0);
    const s2 = new Storage(file);
    assert.deepEqual(s2.data.pools.steam.available, ['a:1']);
  } finally {
    rm(dir);
  }
});

test('corrupt db is backed up and replaced with defaults', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    fs.writeFileSync(file, '{not valid json', 'utf8');
    const s = new Storage(file);
    assert.deepEqual(s.data.pools.steam.available, []);
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.equal(backups.length, 1);
  } finally {
    rm(dir);
  }
});

test('missing keys in an old db are filled from defaults', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    fs.writeFileSync(file, JSON.stringify({ pools: { steam: { available: ['x'] } } }), 'utf8');
    const s = new Storage(file);
    assert.deepEqual(s.data.pools.steam.available, ['x']);
    assert.deepEqual(s.data.pools.steam.given, {});
    assert.ok(s.data.pools.fivem);
    assert.ok(s.data.usage.fivem);
    assert.deepEqual(s.data.roles, {});
  } finally {
    rm(dir);
  }
});
