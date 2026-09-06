'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Storage } = require('../src/storage');
const { AccountService } = require('../src/services/accounts');
const combo = require('../src/commands/combo');
const { tmpDir, rm, user } = require('./helpers');

function setup() {
  const dir = tmpDir();
  const accounts = new AccountService(new Storage(path.join(dir, 'db.json')), dir);
  return { dir, accounts };
}

function fakeInteraction({ failEdit = false } = {}) {
  const st = { edits: [] };
  return {
    user: { id: '42', username: 'matija' },
    deferred: false,
    replied: false,
    async deferReply(p) {
      st.deferred = p;
      this.deferred = true;
      return {};
    },
    async editReply(p) {
      if (failEdit) throw new Error('network down');
      st.edits.push(p);
      return {};
    },
    _st: st,
  };
}

const ctxFor = (accounts) => {
  const c = { accounts, refunded: 0, refundCooldown() { c.refunded += 1; } };
  return c;
};
const fields = (i) => i._st.edits.at(-1).embeds[0].toJSON().fields;

test('/combo gives one Steam and one FiveM account, formatted one below the other', async () => {
  const { dir, accounts } = setup();
  try {
    accounts.refill('steam', 'gamer:pw1', user(0));
    accounts.refill('fivem', 'mail@x.y:pw2:code', user(0));
    const i = fakeInteraction();
    const ctx = ctxFor(accounts);
    await combo.execute(i, ctx);

    assert.equal(i._st.deferred.flags, 64); // ephemeral
    const f = fields(i);
    assert.equal(f[0].name, '🎮 Steam');
    assert.ok(f[0].value.includes('👤 Username: gamer') && f[0].value.includes('🔑 Password: pw1'));
    assert.equal(f[1].name, '🚗 FiveM');
    assert.ok(f[1].value.includes('📧 Email:    mail@x.y') && f[1].value.includes('🔹 Extra 1:  code'));
    assert.equal(accounts.stats('steam').given, 1);
    assert.equal(accounts.stats('fivem').given, 1);
    assert.equal(ctx.refunded, 0);
  } finally {
    rm(dir);
  }
});

test('/combo still gives the available one when the other pool is empty', async () => {
  const { dir, accounts } = setup();
  try {
    accounts.refill('steam', 'only:steam', user(0));
    const i = fakeInteraction();
    const ctx = ctxFor(accounts);
    await combo.execute(i, ctx);
    const f = fields(i);
    assert.ok(f[0].value.includes('only'));
    assert.ok(f[1].value.includes('nema slobodnih'));
    assert.equal(ctx.refunded, 0);
  } finally {
    rm(dir);
  }
});

test('/combo with both pools empty refunds the cooldown and explains', async () => {
  const { dir, accounts } = setup();
  try {
    const i = fakeInteraction();
    const ctx = ctxFor(accounts);
    await combo.execute(i, ctx);
    assert.ok(i._st.edits.at(-1).embeds[0].toJSON().description.includes('prazne'));
    assert.equal(ctx.refunded, 1);
  } finally {
    rm(dir);
  }
});

test('/combo rolls both accounts back if delivery fails', async () => {
  const { dir, accounts } = setup();
  try {
    accounts.refill('steam', 's:1', user(0));
    accounts.refill('fivem', 'f:1', user(0));
    const i = fakeInteraction({ failEdit: true });
    const ctx = ctxFor(accounts);
    let threw = false;
    try {
      await combo.execute(i, ctx);
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    assert.equal(accounts.stats('steam').available, 1);
    assert.equal(accounts.stats('fivem').available, 1);
    assert.equal(accounts.stats('steam').given, 0);
    assert.equal(ctx.refunded, 1);
  } finally {
    rm(dir);
  }
});
