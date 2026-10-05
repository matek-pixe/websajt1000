'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Storage } = require('../src/storage');
const { tmpDir, rm } = require('./helpers');

test('fresh storage returns the empty defaults', () => {
  const dir = tmpDir();
  try {
    const s = new Storage(path.join(dir, 'db.json'));
    assert.deepEqual(s.data.roles, {});
    assert.deepEqual(s.data.tickets, {});
    assert.deepEqual(s.data.locks, {});
    assert.deepEqual(s.data.sos, {});
    assert.deepEqual(s.data.settings, { bypass: false, bypassUsers: {} });
  } finally {
    rm(dir);
  }
});

test('save is atomic and round-trips', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const s = new Storage(file);
    s.data.roles.G = { U1: { roles: ['r1'] } };
    s.save();
    // no leftover temp file
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0);
    const s2 = new Storage(file);
    assert.deepEqual(s2.data.roles.G.U1.roles, ['r1']);
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
    assert.deepEqual(s.data.roles, {});
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
    fs.writeFileSync(file, JSON.stringify({ roles: { G: { U1: { roles: ['x'] } } } }), 'utf8');
    const s = new Storage(file);
    assert.deepEqual(s.data.roles.G.U1.roles, ['x']);
    assert.deepEqual(s.data.tickets, {});
    assert.deepEqual(s.data.sos, {});
    assert.deepEqual(s.data.settings, { bypass: false, bypassUsers: {} });
  } finally {
    rm(dir);
  }
});

test('fresh tells a new database from a loaded one', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const first = new Storage(file);
    assert.equal(first.fresh, true);
    first.save();
    assert.equal(new Storage(file).fresh, false);
  } finally {
    rm(dir);
  }
});
