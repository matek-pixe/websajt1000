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
    assert.deepEqual(s.data.recovered, {});
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

test('an old database gets the recovered map, and a hand-edited one is repaired', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, roles: {}, recovered: 'oops' }));
    assert.deepEqual(new Storage(file).data.recovered, {});
    fs.writeFileSync(file, JSON.stringify({ version: 1, roles: {} }));
    assert.deepEqual(new Storage(file).data.recovered, {});
  } finally {
    rm(dir);
  }
});

test('config: copies every 30 minutes and keeps 12 by default, and bad values fall back', () => {
  const run = (env) => JSON.parse(require('node:child_process').execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./src/config').backup))"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  assert.deepEqual(run({}), { everyMinutes: 30, keep: 12 });
  assert.deepEqual(run({ BACKUP_EVERY_MINUTES: '10', BACKUP_KEEP: '24' }), { everyMinutes: 10, keep: 24 });
  assert.deepEqual(run({ BACKUP_EVERY_MINUTES: 'abc', BACKUP_KEEP: '0' }), { everyMinutes: 30, keep: 12 });
});
