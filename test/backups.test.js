'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BackupService, parseCopy, isTicketChannel } = require('../src/services/backups');
const { G, makeServer, typical, ow } = require('./fakeServer');
const { tmpDir, rm } = require('./helpers');

const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + minutes * 60_000);

function setup(spec = typical(), opts = {}) {
  const dir = tmpDir();
  const server = makeServer(spec);
  const svc = new BackupService({ rest: server.rest, config: { dataDir: dir, backup: { everyMinutes: 30, keep: 3, ...opts } } });
  return { dir, server, svc, done: () => rm(dir) };
}

test('a copy holds every channel with its overwrites, every role and who holds which role', async () => {
  const k = setup();
  try {
    const made = await k.svc.take(k.server.guild, { reason: 'manual', at: at(0) });
    assert.equal(made.channels, 7);
    assert.equal(made.roles, 7);
    const copy = k.svc.read(made.file);
    assert.equal(copy.guildId, G);
    const vip = copy.channels.find((c) => c.id === 'vipchat');
    assert.equal(vip.parentId, 'CAT2');
    assert.equal(vip.overwrites.length, 3);
    assert.ok(copy.roles.find((r) => r.id === 'MODR'));
    const mod = copy.members.find((m) => m.id === 'MOD1');
    assert.deepEqual(mod.roles, ['MODR']);
    assert.equal(copy.members.find((m) => m.id === 'PLAIN'), undefined, 'people without roles are not listed');
    assert.equal(copy.takenAt, at(0).toISOString());
    // listed, newest first, and the one to recover from
    assert.equal(k.svc.list(G).length, 1);
    assert.equal(k.svc.best(G).file, made.file);
    assert.equal(k.svc.list('other').length, 0);
    assert.equal(k.svc.best('other'), null);
  } finally {
    k.done();
  }
});

test('bots are not listed with their roles, and a copy is never left half written', async () => {
  const spec = typical();
  spec.members.push({ id: 'ROBOT', bot: true, roles: ['MODR'] });
  const k = setup(spec);
  try {
    const made = await k.svc.take(k.server.guild, { at: at(0) });
    assert.equal(k.svc.read(made.file).members.find((m) => m.id === 'ROBOT'), undefined);
    assert.deepEqual(fs.readdirSync(k.svc.dirFor(G)).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    k.done();
  }
});

test('only the newest copies are kept, the rest is removed', async () => {
  const k = setup(typical(), { keep: 2 });
  try {
    for (let i = 0; i < 5; i += 1) await k.svc.take(k.server.guild, { at: at(i * 30) });
    const all = k.svc.list(G);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((c) => c.takenAt), [at(120).toISOString(), at(90).toISOString()]);
  } finally {
    k.done();
  }
});

test('a copy that has lost a channel or role pins the one before it, so an unnoticed attack cannot push the good copy out', async () => {
  const k = setup(typical(), { keep: 2 });
  try {
    const good = await k.svc.take(k.server.guild, { at: at(0) });
    k.server.deleteChannel('vipchat');
    k.server.deleteRole('VIPR');
    await k.svc.take(k.server.guild, { at: at(30) }); // sees the loss, pins `good`
    for (let i = 2; i < 8; i += 1) await k.svc.take(k.server.guild, { at: at(i * 30) });

    const all = k.svc.list(G);
    const pinned = all.filter((c) => c.incident);
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0].takenAt, at(0).toISOString());
    assert.equal(pinned[0].channels, 7, 'the pinned copy still has everything');
    assert.equal(all.filter((c) => !c.incident).length, 2, 'ordinary copies are still pruned');
    assert.ok(!all.some((c) => c.file === good.file), 'the ordinary file of the good copy is gone, the pinned one remains');
    // recovering uses the pinned copy, the one with the most in it
    assert.equal(k.svc.best(G).file, pinned[0].file);
  } finally {
    k.done();
  }
});

test('closed tickets and managed roles disappearing is normal and pins nothing', async () => {
  const spec = typical();
  spec.channels.push({ id: 't1', name: 'ticket-0001', parent_id: 'CAT2', permission_overwrites: [] });
  const k = setup(spec);
  try {
    await k.svc.take(k.server.guild, { at: at(0) });
    k.server.deleteChannel('t1');
    k.server.deleteRole('OTHERBOT');
    await k.svc.take(k.server.guild, { at: at(30) });
    assert.equal(k.svc.list(G).filter((c) => c.incident).length, 0);
    assert.equal(isTicketChannel({ type: 0, name: 'ticket-0042' }), true);
    assert.equal(isTicketChannel({ type: 0, name: 'tickets' }), false);
    assert.equal(isTicketChannel({ type: 2, name: 'ticket-0042' }), false);
  } finally {
    k.done();
  }
});

test('freeze pins the newest copy, stops new copies, and thaw lets them start again', async () => {
  const k = setup();
  try {
    assert.equal(k.svc.freeze(G), null, 'nothing to pin yet, but copies stop anyway');
    assert.equal(k.svc.isFrozen(G), true);
    k.svc.thaw(G);

    const good = await k.svc.take(k.server.guild, { at: at(0) });
    const pinned = k.svc.freeze(G);
    assert.equal(pinned.incident, true);
    assert.equal(path.basename(pinned.file), `incident-${good.name}`);
    assert.equal(k.svc.freeze(G), null, 'the second deletion does not pin again');

    k.server.deleteChannel('staff');
    assert.equal(await k.svc.take(k.server.guild, { at: at(30) }), null, 'no copy while frozen, the state after the attack is not saved');
    assert.equal(k.svc.list(G).length, 2);
    const forced = await k.svc.take(k.server.guild, { at: at(31), force: true });
    assert.ok(forced.file, 'a manual copy still works');

    k.svc.thaw(G);
    assert.equal(k.svc.isFrozen(G), false);
    assert.ok(await k.svc.take(k.server.guild, { at: at(60) }));
  } finally {
    k.done();
  }
});

test('best prefers a recent pinned copy, ignores an old one and falls back to the newest copy', async () => {
  const k = setup();
  try {
    const first = await k.svc.take(k.server.guild, { at: at(0) });
    const second = await k.svc.take(k.server.guild, { at: at(30) });
    assert.equal(k.svc.best(G).file, second.file, 'no pinned copy: the newest');

    const pinned = k.svc.freeze(G);
    assert.equal(k.svc.best(G).file, pinned.file);

    const old = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(pinned.file, old, old);
    assert.equal(k.svc.best(G).file, second.file, 'a pinned copy older than two days is not used on its own');
    assert.notEqual(first.file, second.file);
  } finally {
    k.done();
  }
});

test('a damaged file is skipped, and parseCopy only accepts a copy of this server', async () => {
  const k = setup();
  try {
    const made = await k.svc.take(k.server.guild, { at: at(0) });
    fs.writeFileSync(path.join(k.svc.dirFor(G), 'broken.json'), '{ nope', 'utf8');
    fs.writeFileSync(path.join(k.svc.dirFor(G), 'other.json'), JSON.stringify({ kind: 'something-else' }), 'utf8');
    assert.equal(k.svc.list(G).length, 1);

    const text = fs.readFileSync(made.file, 'utf8');
    assert.equal(parseCopy(text, G).channels.length, 7);
    assert.equal(parseCopy(text, '999'), null, 'another server');
    assert.equal(parseCopy('{ nope', G), null);
    assert.equal(parseCopy(JSON.stringify({ kind: '35xw-sos', snapshot: {} }), G), null, 'a /sos start file is not a copy');
    const old = JSON.parse(text);
    delete old.snapshot.members;
    assert.deepEqual(parseCopy(JSON.stringify(old), G).members, [], 'a copy without people still works');
  } finally {
    k.done();
  }
});

test('copies are taken on start and again when channels or roles change, never after a deletion', async () => {
  const { EventEmitter } = require('node:events');
  const { Events } = require('discord.js');
  const k = setup();
  try {
    k.svc.debounceMs = 5;
    const client = new EventEmitter();
    client.guilds = { cache: new Map([[G, k.server.guild]]) };
    k.svc.start(client);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(k.svc.list(G).length, 1, 'one at start');

    client.emit(Events.ChannelDelete, { guild: k.server.guild });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(k.svc.list(G).length, 1, 'a deletion does not trigger a copy');

    // a change makes a copy a moment later (the file name has one-second steps, so wait for the next one)
    await new Promise((r) => setTimeout(r, 1100));
    client.emit(Events.ChannelCreate, { guild: k.server.guild });
    client.emit(Events.GuildRoleUpdate, { guild: k.server.guild }, { guild: k.server.guild });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(k.svc.list(G).length, 2, 'two changes in a burst make one copy');
  } finally {
    k.svc.stop();
    k.done();
  }
});
