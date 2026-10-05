'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AuditLogEvent: A, Events, PermissionFlagsBits } = require('discord.js');
const { AntiNukeService, SIGNATURE } = require('../src/services/antinuke');
const { commands } = require('../src/commands');

const CONFIG = {
  manager: { id: 'MGR' },
  antiNuke: { banAt: 2, windowMs: 10 * 60 * 1000, trustedIds: ['TRUST'] },
  tickets: { notify: { channelId: 'STAFF', roleIds: ['R1', 'GONE'] } },
};

function mk({ dmFails = false, banFails = false, dmSlow = false, perms = null, staff = true, staffFails = false, logChannel = true } = {}) {
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
  const alerts = [];
  const guild = {
    id: 'G',
    name: 'Test server',
    ownerId: 'OWN',
    roles: { cache: new Map([['R1', {}]]) },
    channels: {
      cache: new Map(
        staff
          ? [['STAFF', { send: async (p) => { if (staffFails) throw new Error('Missing Access'); events.push('alert'); alerts.push(p); } }]]
          : [],
      ),
    },
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
  const logChan = { send: async (p) => { events.push('log-alert'); alerts.push(p); } };
  const logs = { post: (g, e) => posted.push(e), channelFor: () => (logChannel ? logChan : null) };
  const svc = new AntiNukeService({ client, storage: null, config: CONFIG, logs });
  svc.dmTimeoutMs = 30;
  const del = (executorId, at = Date.now()) => svc.onAudit({ action: A.ChannelDelete, executorId, createdTimestamp: at }, guild);
  return { svc, guild, client, bans, dms, events, posted, alerts, del };
}

test('one deleted channel is fine, the second gets a ban', async () => {
  const t = mk();
  assert.equal(await t.del('BAD'), null);
  assert.equal(t.bans.length, 0);
  const r = await t.del('BAD');
  assert.equal(r.banned, true);
  assert.equal(r.count, 2);
  assert.deepEqual(t.bans.map((b) => b.id), ['BAD']);
});

test('they are told BEFORE the ban: the private message and the alert in the server, then the ban', async () => {
  const t = mk();
  await t.del('BAD');
  await t.del('BAD');
  const at = (e) => t.events.indexOf(e);
  assert.ok(at('dm:BAD') >= 0 && at('alert') >= 0 && at('ban:BAD') >= 0);
  assert.ok(at('dm:BAD') < at('ban:BAD'), 'the private message comes first');
  assert.ok(at('alert') < at('ban:BAD'), 'the server is told first');

  const dm = t.dms.find((d) => d.id === 'BAD').payload.embeds[0].toJSON();
  assert.equal(dm.footer.text, 'Anti-nuke system made by 35bf');
  assert.equal(SIGNATURE, 'Anti-nuke system made by 35bf');
  assert.match(dm.description, /Test server/);
  assert.match(dm.description, /Deleting 2 channels gets you banned/);
  assert.match(dm.description, /banned from the server now/);

  const alert = t.alerts[0];
  assert.equal(alert.content, '<@&R1>', 'the staff roles are pinged, a role that does not exist is left out');
  assert.deepEqual(alert.allowedMentions, { roles: ['R1'], users: [] });
  const e = alert.embeds[0].toJSON();
  assert.equal(e.title, 'Anti-nuke');
  assert.match(e.description, /<@BAD> `BAD#0` deleted 2 channels within 10 minutes\. They are being banned now\./);
  assert.equal(e.footer.text, SIGNATURE);
});

test('without a staff channel the alert goes to the server log channel', async () => {
  const t = mk({ staff: false });
  await t.del('BAD');
  await t.del('BAD');
  assert.ok(t.events.indexOf('log-alert') >= 0 && t.events.indexOf('log-alert') < t.events.indexOf('ban:BAD'));
  const none = mk({ staff: false, logChannel: false });
  await none.del('BAD');
  const r = await none.del('BAD');
  assert.equal(r.banned, true, 'with nowhere to post, the ban still happens');
  assert.equal(r.announced, false);
});

test('a closed DM, a slow DM or a staff channel that refuses never stops the ban', async () => {
  for (const opts of [{ dmFails: true }, { dmSlow: true }, { staffFails: true }]) {
    const t = mk(opts);
    await t.del('BAD');
    const r = await t.del('BAD');
    assert.equal(r.banned, true, JSON.stringify(opts));
    assert.deepEqual(t.bans.map((b) => b.id), ['BAD']);
  }
  const t = mk({ dmFails: true });
  await t.del('BAD');
  const r = await t.del('BAD');
  assert.equal(r.warned, false);
  assert.equal(r.announced, true);
});

test('the owner, the manager, the bot and trusted ids are never counted', async () => {
  const t = mk();
  for (const id of ['OWN', 'MGR', 'BOT', 'TRUST']) {
    for (let i = 0; i < 10; i++) assert.equal(await t.del(id), null);
  }
  assert.equal(t.bans.length, 0);
});

test('only channel deletions count, and the count is per person', async () => {
  const t = mk();
  for (let i = 0; i < 10; i++) {
    await t.svc.onAudit({ action: A.ChannelCreate, executorId: 'BAD', createdTimestamp: Date.now() }, t.guild);
    await t.svc.onAudit({ action: A.RoleDelete, executorId: 'BAD', createdTimestamp: Date.now() }, t.guild);
    await t.svc.onAudit({ action: A.ChannelDelete, executorId: null, createdTimestamp: Date.now() }, t.guild);
  }
  await t.del('A');
  await t.del('B');
  assert.equal(t.bans.length, 0, 'one each is fine');
});

test('deletions older than the window stop counting', async () => {
  const t = mk();
  const now = Date.now();
  await t.del('SLOW', now - 11 * 60 * 1000);
  assert.equal(await t.del('SLOW', now), null, 'only one inside the window');
  assert.equal(t.bans.length, 0);
});

test('a burst of deletions bans once', async () => {
  const t = mk();
  for (let i = 0; i < 12; i++) await t.del('BAD');
  assert.equal(t.bans.length, 1);
  assert.equal(t.dms.filter((d) => d.id === 'BAD').length, 1);
  assert.equal(t.alerts.length, 1);
});

test('the owner is told afterwards, and so is the server log', async () => {
  const t = mk();
  await t.del('BAD');
  await t.del('BAD');
  const owners = t.dms.filter((d) => d.owner).map((d) => d.id).sort();
  assert.deepEqual(owners, ['MGR', 'OWN']);
  assert.equal(t.posted.length, 1);
  const e = t.posted[0].toJSON();
  assert.equal(e.title, 'Anti-nuke ban');
  assert.match(e.description, /deleted 2 channels within 10 minutes and was banned/);
  assert.equal(e.fields.find((f) => f.name === 'Server told').value, 'Yes');
  assert.equal(e.footer.text, SIGNATURE);
});

test('when the ban fails the owner hears exactly why', async () => {
  const t = mk({ banFails: true });
  await t.del('BAD');
  const r = await t.del('BAD');
  assert.equal(r.banned, false);
  assert.equal(r.error, 'Missing Permissions');
  const e = t.posted[0].toJSON();
  assert.equal(e.title, 'Anti-nuke could not ban');
  assert.match(e.description, /Missing Permissions/);
  assert.ok(t.dms.some((d) => d.owner && d.id === 'OWN'));
});

test('attach listens to the audit log gateway event', async () => {
  const t = mk();
  t.svc.attach();
  for (let i = 0; i < 2; i++) t.client.emit(Events.GuildAuditLogEntryCreate, { action: A.ChannelDelete, executorId: 'BAD', createdTimestamp: Date.now() }, t.guild);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.bans.length, 1);
});

test('health reports missing permissions', () => {
  const ok = mk();
  const bad = mk({ perms: [PermissionFlagsBits.ViewAuditLog] });
  assert.deepEqual(ok.svc.health(ok.guild), { canBan: true, canSeeAudit: true });
  assert.deepEqual(bad.svc.health(bad.guild), { canBan: false, canSeeAudit: true });
});

test('it is always on: there is no command and no switch', () => {
  assert.equal(commands.has('antinuke'), false);
  const t = mk();
  assert.equal(t.svc.isOn, undefined);
  assert.equal(t.svc.set, undefined);
});

test('the first channel or role deleted by somebody who is not exempt keeps the last good copy, once per deletion', async () => {
  const t = mk();
  const seen = [];
  t.svc.onSuspect = (g, id) => seen.push([g.id, id]);
  await t.svc.onAudit({ action: A.RoleDelete, executorId: 'BAD', createdTimestamp: Date.now() }, t.guild);
  assert.deepEqual(seen, [['G', 'BAD']], 'a deleted role counts as a warning sign');
  assert.equal(t.bans.length, 0, 'but only deleted channels get somebody banned');
  await t.del('BAD');
  assert.equal(seen.length, 2);

  // the owner, the manager, this bot and trusted ids never set it off
  for (const id of ['OWN', 'MGR', 'BOT', 'TRUST']) await t.del(id);
  await t.svc.onAudit({ action: A.RoleDelete, executorId: 'OWN', createdTimestamp: Date.now() }, t.guild);
  assert.equal(seen.length, 2);

  // other actions never do
  await t.svc.onAudit({ action: A.ChannelCreate, executorId: 'BAD', createdTimestamp: Date.now() }, t.guild);
  assert.equal(seen.length, 2);
});

test('a failing suspect handler never stops the ban, and the owner report points at /sos recover', async () => {
  const t = mk();
  t.svc.onSuspect = () => {
    throw new Error('disk full');
  };
  await t.del('BAD');
  const r = await t.del('BAD');
  assert.equal(r.banned, true);
  const e = t.posted[0].toJSON();
  assert.match(e.fields.find((f) => f.name === 'Next step').value, /\/sos recover/);
});
