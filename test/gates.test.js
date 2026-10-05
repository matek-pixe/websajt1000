'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { refusal, isOwnerOrManager } = require('../src/gates');
const { commands } = require('../src/commands');

const isManager = (u) => u.id === 'MGR';

function call(name, { user = 'U1', owner = 'OWNER', inGuild = true, gate = { ok: true } } = {}) {
  const interaction = { commandName: name, user: { id: user }, guild: inGuild ? { ownerId: owner } : null, inGuild: () => inGuild };
  return refusal(commands.get(name), interaction, { isManager, verifiedGate: () => gate });
}

test('owner and manager count as the owner of a command, nobody else does', () => {
  const it = (id) => ({ user: { id }, guild: { ownerId: 'OWNER' } });
  assert.equal(isOwnerOrManager(it('OWNER'), isManager), true);
  assert.equal(isOwnerOrManager(it('MGR'), isManager), true);
  assert.equal(isOwnerOrManager(it('ADMIN'), isManager), false);
  assert.equal(isOwnerOrManager({ user: { id: 'OWNER' }, guild: null }, isManager), false);
});

test('the sos command is for the server owner and the manager, an admin may not run it', () => {
  for (const name of ['sos']) {
    assert.equal(call(name, { user: 'OWNER' }), null, name);
    assert.equal(call(name, { user: 'MGR' }), null, name);
    assert.match(call(name, { user: 'ADMIN' }), /Only the server owner can use/, name);
    assert.match(call(name, { user: 'OWNER', inGuild: false }), /inside a server/, name);
  }
});

test('manager commands refuse everyone else, even the server owner', () => {
  for (const name of ['b']) {
    assert.equal(call(name, { user: 'MGR', inGuild: false }), null, name);
    assert.match(call(name, { user: 'OWNER' }), /Only the bot manager can use/, name);
  }
});

test('verified-only commands need the verified role and a server; the refusal points at the ticket channel', () => {
  for (const name of ['stats']) {
    assert.equal(call(name), null, name);
    assert.match(call(name, { inGuild: false }), /inside a server/, name);
    const text = call(name, { gate: { ok: false, roleId: '111', channelId: '222' } });
    assert.match(text, /verified members/, name);
    assert.match(text, /<#222>/, name);
    assert.match(text, /<@&111>/, name);
    assert.match(call(name, { gate: { ok: false, roleId: '111', channelId: null } }), /Open a ticket to get <@&111>/, name);
  }
});

test('commands without special rules pass for anyone in a server', () => {
  for (const name of ['v', 'close', 'add']) assert.equal(call(name), null, name);
});

test('admin commands are marked for the command log', () => {
  for (const name of ['v', 'sos']) assert.equal(commands.get(name).audit, true, name);
  for (const name of ['b', 'sos']) assert.ok(commands.get(name).managerOnly || commands.get(name).ownerOnly, name);
});
