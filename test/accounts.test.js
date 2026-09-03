'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { Storage } = require('../src/storage');
const { AccountService, parseAccounts } = require('../src/services/accounts');
const { tmpDir, rm, user } = require('./helpers');

function svc() {
  const dir = tmpDir();
  const storage = new Storage(path.join(dir, 'db.json'));
  const accounts = new AccountService(storage, dir);
  return { dir, storage, accounts };
}

test('parseAccounts ignores blanks, comments, BOM and in-file duplicates', () => {
  const { accounts, duplicatesInFile } = parseAccounts('﻿a:1\n\n# comment\nb:2\r\na:1\n   c:3   ');
  assert.deepEqual(accounts, ['a:1', 'b:2', 'c:3']);
  assert.equal(duplicatesInFile, 1);
});

test('refill adds accounts and writes the file to disk', () => {
  const { dir, accounts } = svc();
  try {
    const res = accounts.refill('steam', 'a:1\nb:2\nc:3', user(99, 'boss'));
    assert.equal(res.added, 3);
    assert.equal(res.available, 3);
    assert.ok(fs.existsSync(path.join(dir, 'steam.txt')));
  } finally {
    rm(dir);
  }
});

test('claim never hands out the same account twice, even across a re-upload', () => {
  const { dir, accounts } = svc();
  try {
    accounts.refill('steam', 'a:1\nb:2', user(1));
    const first = accounts.claim('steam', user(1));
    const second = accounts.claim('steam', user(2));
    assert.notEqual(first, second);
    assert.equal(accounts.claim('steam', user(3)), null); // pool exhausted

    // Re-upload the SAME file: nothing should be handed out again.
    const res = accounts.refill('steam', 'a:1\nb:2', user(1));
    assert.equal(res.added, 0);
    assert.equal(res.alreadyGiven, 2);
    assert.equal(accounts.claim('steam', user(4)), null);
  } finally {
    rm(dir);
  }
});

test('a partially-used file re-upload only adds the untouched accounts', () => {
  const { dir, accounts } = svc();
  try {
    accounts.refill('steam', 'a:1\nb:2', user(1));
    accounts.claim('steam', user(1)); // takes a:1
    const res = accounts.refill('steam', 'a:1\nb:2\nc:3', user(1));
    assert.equal(res.added, 1); // only c:3 is new
    assert.equal(res.alreadyGiven, 1); // a:1
    assert.equal(res.alreadyAvailable, 1); // b:2 still waiting
  } finally {
    rm(dir);
  }
});

test('steam and fivem pools are fully independent', () => {
  const { dir, accounts } = svc();
  try {
    accounts.refill('steam', 's:1', user(1));
    accounts.refill('fivem', 'f:1', user(1));
    assert.equal(accounts.claim('steam', user(1)), 's:1');
    assert.equal(accounts.claim('fivem', user(1)), 'f:1');
  } finally {
    rm(dir);
  }
});

test('usage counts and stats leaderboard are per-pool and sorted', () => {
  const { dir, accounts } = svc();
  try {
    accounts.refill('steam', 'a\nb\nc\nd', user(1)); // 4 accounts
    accounts.claim('steam', user(10)); // user10: 1
    accounts.claim('steam', user(20)); // user20: 1
    accounts.claim('steam', user(20)); // user20: 2
    accounts.claim('steam', user(20)); // user20: 3
    const s = accounts.stats('steam', 5);
    assert.equal(s.given, 4); // 4 claims total
    assert.equal(s.available, 0);
    assert.equal(s.users, 2);
    assert.equal(s.top[0].userId, '20');
    assert.equal(s.top[0].count, 3);
    assert.equal(s.top[1].userId, '10');
    // fivem untouched
    assert.deepEqual(accounts.stats('fivem').top, []);
  } finally {
    rm(dir);
  }
});

test('claim persists across a reload (survives restart)', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const a1 = new AccountService(new Storage(file), dir);
    a1.refill('steam', 'a:1\nb:2', user(1));
    const got = a1.claim('steam', user(1));

    const a2 = new AccountService(new Storage(file), dir);
    // the account already given must not come back
    let seen = [];
    let x;
    while ((x = a2.claim('steam', user(2))) !== null) seen.push(x);
    assert.equal(seen.includes(got), false);
    assert.equal(seen.length, 1);
  } finally {
    rm(dir);
  }
});

test('unclaim returns a burned account to the pool and rolls back usage', () => {
  const { dir, accounts } = svc();
  try {
    accounts.refill('steam', 'a:1\nb:2', user(1));
    const got = accounts.claim('steam', user(7));
    let s = accounts.stats('steam');
    assert.equal(s.given, 1);
    assert.equal(s.top[0].userId, '7');

    // delivery failed -> put it back
    assert.equal(accounts.unclaim('steam', got), true);
    s = accounts.stats('steam');
    assert.equal(s.given, 0); // no longer marked given
    assert.equal(s.users, 0); // usage rolled back to 0 and dropped
    assert.equal(s.available, 2); // account is back in the pool

    // the returned account is handed out again (front of queue), never lost
    assert.equal(accounts.claim('steam', user(8)), got);

    // unclaiming something that was never given is a no-op
    assert.equal(accounts.unclaim('steam', 'never:given'), false);
  } finally {
    rm(dir);
  }
});

test('a __proto__ line in the file cannot poison the given registry', () => {
  const { dir, accounts } = svc();
  try {
    accounts.refill('steam', '__proto__\nreal:1', user(1));
    const a = accounts.claim('steam', user(1));
    const b = accounts.claim('steam', user(1));
    assert.notEqual(a, b);
    assert.equal(accounts.claim('steam', user(1)), null);
    // prototype not polluted
    assert.equal({}.polluted, undefined);
  } finally {
    rm(dir);
  }
});
