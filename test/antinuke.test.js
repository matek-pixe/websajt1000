'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AuditLogEvent: A, Events, PermissionFlagsBits } = require('discord.js');
const { Storage } = require('../src/storage');
const { AntiNukeService, SIGNATURE } = require('../src/services/antinuke');
const antinuke = require('../src/commands/antinuke');
const { tmpDir, rm } = require('./helpers');

const CONFIG = { manager: { id: 'MGR' }, antiNuke: { maxChannels: 3, windowMs: 10 * 60 * 1000, trustedIds: ['TRUST'] } };

function mk({ dmFails = false, banFails = false, dmSlow = false, perms = null } = {}) {
  const dir = tmpDir();
  const events = []; // order of what happened
  const client = new EventEmitter();
  client.user = { id: 'BOT' };
  const dms = [];
  client.users = {
    fetch: async (id) => ({
      id,
      tag: `${id}#0`,
      send: async (p) => {
        if (dmSlow) await new Promise((r) => setTimeout(r, 300).unref());
        if (dmFails) throw new Error('Cannot send messages to this user');
        events.push(`dm:${id}`);
        dms.push({ id, payload: p });
      },
    }),
    send: async (id, p) => {
      events.push(`owner-dm:${id}`);
      dms.push({ id, payload: p, owner: true });
    },
  };
  const bans = [];
  const guild = {
    id: 'G',
    name: 'Test server',
    ownerId: 'OWN',
    members: {
      cache: new Map([['MGR', {}]]),
      me: { permissions: { has: (f) => (perms ? perms.includes(f) : true) } },
      ban: async (id, o) => {
        if (banFails) throw new Error('Missing Permissions');
        events.push(`ban:${id}`);
        bans.push({ id, ...o });
      },
    },
  };
  const posted = [];
  const logs = { post: (g, e) => posted.push(e) };
  const storage = new Storage(path.join(dir, 'db.json'));
  const svc = new AntiNukeService({ client, storage, config: CONFIG, logs });
  svc.dmTimeoutMs = 30;
  const del = (executorId, at = Date.now()) => svc.onAudit({ action: A.ChannelDelete, executorId, createdTimestamp: at }, guild);
  return { svc, guild, client, bans, dms, events, posted, del, storage, cleanup: () => rm(dir) };
}

test('three deleted channels are fine, the fourth gets a warning and a ban', async () => {
  const t = mk();
  try {
    for (let i = 0; i < 3; i++) assert.equal(await t.del('BAD'), null);
    assert.equal(t.bans.length, 0);
    const r = await t.del('BAD');
    assert.equal(r.banned, true);
    assert.equal(r.count, 4);
    assert.equal(t.bans.length, 1);
    assert.equal(t.bans[0].id, 'BAD');
  } finally {
    t.cleanup();
  }
});

test('the private warning goes out BEFORE the ban and is signed', async () => {
  const t = mk();
  try {
    for (let i = 0; i < 4; i++) await t.del('BAD');
    assert.ok(t.events.indexOf('dm:BAD') >= 0 && t.events.indexOf('dm:BAD') < t.events.indexOf('ban:BAD'));
    const embed = t.dms.find((d) => d.id === 'BAD').payload.embeds[0].toJSON();
    assert.equal(embed.footer.text, 'Anti-nuke system made by 35bf');
    assert.equal(SIGNATURE, 'Anti-nuke system made by 35bf');
    assert.match(embed.description, /Test server/);
    assert.match(embed.description, /banned/);
  } finally {
    t.cleanup();
  }
});

test('a closed DM or a slow DM never stops the ban', async () => {
  for (const opts of [{ dmFails: true }, { dmSlow: true }]) {
    const t = mk(opts);
    try {
      for (let i = 0; i < 3; i++) await t.del('BAD');
      const r = await t.del('BAD');
      assert.equal(r.banned, true);
      assert.equal(r.warned, false);
      assert.deepEqual(t.bans.map((b) => b.id), ['BAD']);
    } finally {
      t.cleanup();
    }
  }
});

test('the owner, the manager, the bot and trusted ids are never counted', async () => {
  const t = mk();
  try {
    for (const id of ['OWN', 'MGR', 'BOT', 'TRUST']) {
      for (let i = 0; i < 10; i++) assert.equal(await t.del(id), null);
    }
    assert.equal(t.bans.length, 0);
  } finally {
    t.cleanup();
  }
});

test('only channel deletions count, and the count is per person', async () => {
  const t = mk();
  try {
    for (let i = 0; i < 10; i++) {
      await t.svc.onAudit({ action: A.ChannelCreate, executorId: 'BAD', createdTimestamp: Date.now() }, t.guild);
      await t.svc.onAudit({ action: A.RoleDelete, executorId: 'BAD', createdTimestamp: Date.now() }, t.guild);
      await t.svc.onAudit({ action: A.ChannelDelete, executorId: null, createdTimestamp: Date.now() }, t.guild);
    }
    for (let i = 0; i < 3; i++) {
      await t.del('A');
      await t.del('B');
    }
    assert.equal(t.bans.length, 0);
  } finally {
    t.cleanup();
  }
});

test('deletions older than the window stop counting', async () => {
  const t = mk();
  try {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await t.del('SLOW', now - 11 * 60 * 1000 + i);
    assert.equal(await t.del('SLOW', now), null); // only 1 inside the window
    assert.equal(t.bans.length, 0);
  } finally {
    t.cleanup();
  }
});

test('a burst of deletions bans once', async () => {
  const t = mk();
  try {
    for (let i = 0; i < 12; i++) await t.del('BAD');
    assert.equal(t.bans.length, 1);
    assert.equal(t.dms.filter((d) => d.id === 'BAD').length, 1);
  } finally {
    t.cleanup();
  }
});

test('the owner is told, and so is the server log', async () => {
  const t = mk();
  try {
    for (let i = 0; i < 4; i++) await t.del('BAD');
    const owners = t.dms.filter((d) => d.owner).map((d) => d.id).sort();
    assert.deepEqual(owners, ['MGR', 'OWN']);
    assert.equal(t.posted.length, 1);
    const e = t.posted[0].toJSON();
    assert.equal(e.title, 'Anti-nuke ban');
    assert.match(e.description, /deleted 4 channels within 10 minutes and was banned/);
    assert.equal(e.footer.text, SIGNATURE);
  } finally {
    t.cleanup();
  }
});

test('when the ban fails the owner hears exactly why', async () => {
  const t = mk({ banFails: true });
  try {
    for (let i = 0; i < 3; i++) await t.del('BAD');
    const r = await t.del('BAD');
    assert.equal(r.banned, false);
    assert.equal(r.error, 'Missing Permissions');
    const e = t.posted[0].toJSON();
    assert.equal(e.title, 'Anti-nuke could not ban');
    assert.match(e.description, /Missing Permissions/);
    assert.ok(t.dms.some((d) => d.owner && d.id === 'OWN'));
  } finally {
    t.cleanup();
  }
});

test('the switch is per server and survives a restart', async () => {
  const t = mk();
  try {
    assert.equal(t.svc.isOn('G'), true);
    t.svc.set('G', false);
    for (let i = 0; i < 6; i++) await t.del('BAD');
    assert.equal(t.bans.length, 0);
    assert.equal(t.svc.isOn('G'), false);
    assert.equal(t.svc.isOn('OTHER'), true);

    const again = new AntiNukeService({ client: t.client, storage: new Storage(t.storage.file), config: CONFIG });
    assert.equal(again.isOn('G'), false);
    again.set('G', true);
    assert.equal(again.isOn('G'), true);
  } finally {
    t.cleanup();
  }
});

test('attach listens to the audit log gateway event', async () => {
  const t = mk();
  try {
    t.svc.attach();
    for (let i = 0; i < 4; i++) t.client.emit(Events.GuildAuditLogEntryCreate, { action: A.ChannelDelete, executorId: 'BAD', createdTimestamp: Date.now() }, t.guild);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.bans.length, 1);
  } finally {
    t.cleanup();
  }
});

test('health reports missing permissions', () => {
  const ok = mk();
  const bad = mk({ perms: [PermissionFlagsBits.ViewAuditLog] });
  try {
    assert.deepEqual(ok.svc.health(ok.guild), { on: true, canBan: true, canSeeAudit: true });
    assert.deepEqual(bad.svc.health(bad.guild), { on: true, canBan: false, canSeeAudit: true });
  } finally {
    ok.cleanup();
    bad.cleanup();
  }
});

test('/antinuke: status does not spend the cooldown, on and off switch it', async () => {
  const t = mk();
  try {
    const replies = [];
    let refunds = 0;
    const call = async (mode) => {
      const interaction = {
        guild: t.guild,
        options: { getString: () => mode },
        deferred: false,
        replied: false,
        reply: async (p) => replies.push(p),
      };
      await antinuke.execute(interaction, { antiNuke: t.svc, refundCooldown: () => (refunds += 1) });
      return replies[replies.length - 1].embeds[0].toJSON();
    };
    assert.equal((await call(null)).title, 'Anti-nuke is on');
    assert.equal(refunds, 1);
    assert.equal((await call('off')).title, 'Anti-nuke is off');
    assert.equal(t.svc.isOn('G'), false);
    assert.equal((await call('on')).title, 'Anti-nuke is on');
    assert.equal(refunds, 1);
    assert.equal(antinuke.ownerOnly, true);
    assert.ok(antinuke.data.toJSON().description.length <= 100);
  } finally {
    t.cleanup();
  }
});
