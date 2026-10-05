'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { RecoverService, applyRecovered, resolve } = require('../src/services/recover');
const { BackupService } = require('../src/services/backups');
const { G, VIEW, SEND, kit, typical, ow } = require('./fakeServer');

const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + minutes * 60_000);
const bits = (o, k) => BigInt(o[k]);

/** A server, a backup service and a recover service on top of it. */
function setup(spec = typical()) {
  const k = kit(spec);
  const backups = new BackupService({ rest: k.server.rest, config: { dataDir: k.dir, backup: { everyMinutes: 30, keep: 5 } } });
  const config = {
    logs: { channelId: 'staff' },
    verified: { roleId: 'VIPR' },
    autoRole: { id: 'VIPR', name: 'member' },
    tickets: { notify: { channelId: 'staff', roleIds: ['MODR', 'ADMINR'] } },
    web: { roleIds: ['VIPR'] },
  };
  const recover = new RecoverService({ storage: k.storage, config, rest: k.server.rest });
  const copy = async () => backups.read((await backups.take(k.server.guild, { at: at(0) })).file);
  return { ...k, backups, recover, config, copy };
}

/** The usual attack: two roles, a category, and two channels in it, deleted. */
function attack(server) {
  server.deleteChannel('vipchat');
  server.deleteChannel('staff');
  server.deleteChannel('CAT2');
  server.deleteRole('MODR');
  server.deleteRole('VIPR');
}

const names = (list) => list.map((x) => x.name).sort();
const run = async (k, copy, by = 'OWNER') => {
  const plan = await k.recover.plan(k.server.guild, copy);
  return { plan, res: await k.recover.execute(k.server.guild, plan, by) };
};

test('the plan lists what is missing and nothing else, and changes nothing', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    const whole = await k.recover.plan(k.server.guild, copy);
    assert.equal(whole.empty, true, 'a server that lost nothing has nothing to recover');

    attack(k.server);
    const before = k.server.dump();
    const calls = k.server.calls.length;
    const plan = await k.recover.plan(k.server.guild, copy);
    assert.deepEqual(names(plan.roles), ['Mod', 'VIP']);
    assert.deepEqual(names(plan.channels), ['GENERAL', 'staff', 'vipchat']);
    assert.deepEqual(names(plan.reparent), ['chat', 'voice'], 'the channels the deleted category left behind');
    assert.equal(plan.gives, 2, 'MOD1 and VIP1');
    assert.deepEqual(plan.permissions.map((o) => [o.name, o.role]), [['voice', 'MODR']], 'the permission the deleted role lost on a channel that still exists');
    assert.equal(plan.empty, false);
    assert.equal(plan.copy.channels, 7);
    assert.deepEqual(k.server.dump(), before);
    assert.ok(k.server.calls.slice(calls).every(([m]) => m === 'GET'), 'planning only reads');
  } finally {
    k.done();
  }
});

test('recover makes the roles and channels again with their settings and permissions, and gives the roles back', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    const untouched = k.server.dump();
    attack(k.server);
    const { res } = await run(k, copy);

    assert.equal(res.ok, true);
    assert.deepEqual(res.roles.made.sort(), ['Mod', 'VIP']);
    assert.deepEqual(res.channels.made, ['GENERAL', 'vipchat', 'staff'], 'the category first, then the rest in their order');
    assert.equal(res.roles.given, 2);
    assert.equal(res.channels.moved, 2);
    assert.equal(res.channels.restored, 1);
    assert.equal(res.channels.droppedOverwrites, 1, 'the person who left the server');
    assert.deepEqual([res.roles.failed, res.channels.failed], [[], []]);

    const mod = k.server.roleByName('Mod')[0];
    const vip = k.server.roleByName('VIP')[0];
    assert.equal(mod.permissions, VIEW | P.ManageMessages, 'same permissions');
    const cat = k.server.channelByName('GENERAL')[0];
    assert.equal(cat.type, 4);
    const vipchat = k.server.channelByName('vipchat')[0];
    const staff = k.server.channelByName('staff')[0];
    assert.equal(vipchat.parent_id, cat.id, 'in the new category');
    assert.equal(staff.parent_id, cat.id);
    assert.equal(k.server.state.channels.get('chat').parent_id, cat.id, 'the channels the category left behind are back in it');
    assert.equal(k.server.state.channels.get('voice').parent_id, cat.id);

    // the overwrites point at the NEW roles, and the same people see the same things as before
    const ids = vipchat.permission_overwrites.map((o) => o.id).sort();
    assert.deepEqual(ids, [G, vip.id].sort());
    assert.equal(k.server.canSee('VIP1', vipchat.id), true);
    assert.equal(k.server.canSee('PLAIN', vipchat.id), false);
    assert.equal(k.server.canSee('MOD1', staff.id), true);
    assert.equal(k.server.canSee('U_ALLOWED', staff.id), true, 'a person with their own overwrite still has it');
    assert.equal(k.server.canSee('PLAIN', staff.id), false);
    assert.ok(k.server.state.members.get('MOD1').roles.includes(mod.id));
    assert.ok(k.server.state.members.get('VIP1').roles.includes(vip.id));
    assert.ok(!k.server.state.members.get('PLAIN').roles.includes(vip.id));

    // the voice channel that only lost the deleted role's permission has it again, for the new role
    const voice = k.server.state.channels.get('voice');
    assert.deepEqual(voice.permission_overwrites.map((o) => [o.id, o.type, o.allow, o.deny]), [[mod.id, 0, '0', String(VIEW)]]);

    // everything that was never deleted is exactly as it was
    const now = k.server.dump();
    for (const [id, o] of untouched.channels) {
      if (['vipchat', 'staff', 'CAT2', 'voice'].includes(id)) continue;
      assert.deepEqual(now.channels.find(([x]) => x === id), [id, o], id);
    }
    for (const [id, perms] of untouched.roles) {
      if (['MODR', 'VIPR'].includes(id)) continue;
      assert.deepEqual(now.roles.find(([x]) => x === id), [id, perms], id);
    }
  } finally {
    k.done();
  }
});

test('running recover again makes nothing twice', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    attack(k.server);
    await run(k, copy);
    const state = JSON.stringify(k.server.dump());
    const made = k.server.calls.filter(([m]) => m === 'POST').length;

    const again = await k.recover.plan(k.server.guild, copy);
    assert.equal(again.empty, true);
    const second = await k.recover.execute(k.server.guild, again, 'OWNER');
    assert.deepEqual([second.roles.made, second.channels.made, second.roles.given], [[], [], 0]);
    assert.equal(k.server.calls.filter(([m]) => m === 'POST').length, made);
    assert.equal(JSON.stringify(k.server.dump()), state);
    assert.equal(k.server.channelByName('vipchat').length, 1);
    assert.equal(k.server.roleByName('Mod').length, 1);
  } finally {
    k.done();
  }
});

test('a role or channel somebody already made again by hand is linked, never made twice', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    attack(k.server);
    // the bot made a new "VIP" role itself and an admin made a "staff" channel by hand
    const vip = await k.server.rest.post(`/guilds/${G}/roles`, { body: { name: 'vip', permissions: '1' } });
    const staff = await k.server.rest.post(`/guilds/${G}/channels`, { body: { name: 'Staff', type: 0 } });

    const plan = await k.recover.plan(k.server.guild, copy);
    assert.deepEqual(names(plan.roles), ['Mod']);
    assert.deepEqual(plan.adoptRoles.map((a) => [a.name, a.to]), [['VIP', vip.id]]);
    assert.deepEqual(names(plan.channels), ['GENERAL', 'vipchat']);
    assert.deepEqual(plan.adoptChannels.map((a) => [a.name, a.to]), [['staff', staff.id]]);
    assert.equal(plan.gives, 2);

    const res = await k.recover.execute(k.server.guild, plan, 'OWNER');
    assert.deepEqual(res.roles.adopted, ['VIP']);
    assert.deepEqual(res.channels.adopted, ['staff']);
    assert.equal(k.server.roleByName('VIP').length + k.server.roleByName('vip').length, 1);
    assert.equal(k.server.channelByName('vipchat').length, 1);
    assert.equal(k.server.channelByName('Staff').length + k.server.channelByName('staff').length, 1);
    // people who had the deleted role hold the one that stands in for it, and the new channel lets it in
    assert.ok(k.server.state.members.get('VIP1').roles.includes(vip.id));
    const vipchat = k.server.channelByName('vipchat')[0];
    assert.ok(vipchat.permission_overwrites.some((o) => o.id === vip.id));
    // the linked channel joins its category again
    assert.equal(k.server.state.channels.get(staff.id).parent_id, k.server.channelByName('GENERAL')[0].id);
  } finally {
    k.done();
  }
});

test('only what was in the preview is made, and what was made by hand meanwhile is not doubled', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    k.server.deleteChannel('vipchat');
    const plan = await k.recover.plan(k.server.guild, copy);
    assert.deepEqual(names(plan.channels), ['vipchat']);

    k.server.deleteChannel('staff'); // deleted after the preview: not approved, not made
    const res = await k.recover.execute(k.server.guild, plan, 'OWNER');
    assert.deepEqual(res.channels.made, ['vipchat']);
    assert.equal(k.server.channelByName('staff').length, 0);

    // somebody makes the channel by hand between the preview and the button
    const k2 = setup();
    try {
      const copy2 = await k2.copy();
      k2.server.deleteChannel('vipchat');
      const plan2 = await k2.recover.plan(k2.server.guild, copy2);
      await k2.server.rest.post(`/guilds/${G}/channels`, { body: { name: 'vipchat', type: 0, parent_id: 'CAT2' } });
      const res2 = await k2.recover.execute(k2.server.guild, plan2, 'OWNER');
      assert.deepEqual(res2.channels.made, []);
      assert.equal(k2.server.channelByName('vipchat').length, 1);
    } finally {
      k2.done();
    }
  } finally {
    k.done();
  }
});

test('people who left are not given roles, and a failure on one thing never stops the rest', async () => {
  const spec = typical();
  spec.members.push({ id: 'LATE', roles: ['VIPR'] });
  spec.members.push({ id: 'VIP2', roles: ['VIPR'] });
  const k = setup(spec);
  try {
    const copy = await k.copy();
    attack(k.server);
    k.server.removeMember('LATE');
    k.server.failWhen = (m, route, body) => {
      if (m === 'POST' && body && body.name === 'vipchat') return Object.assign(new Error('Missing Permissions'), { code: 50013 });
      if (m === 'PUT' && route.includes('/members/VIP2/roles/')) return Object.assign(new Error('rate'), { code: 0 });
      return null;
    };
    const { res } = await run(k, copy);
    assert.deepEqual(res.channels.failed.map((f) => f.name), ['vipchat']);
    assert.match(res.channels.failed[0].error, /Missing Permissions/);
    assert.deepEqual(res.channels.made, ['GENERAL', 'staff'], 'the rest was still made');
    assert.equal(res.roles.given, 2, 'MOD1 and VIP1');
    assert.equal(res.roles.giveFailed, 1, 'VIP2');
    assert.ok(!(k.server.state.members.has('LATE')));

    // once the problem is gone, running it again finishes what is left
    k.server.failWhen = null;
    const next = await k.recover.plan(k.server.guild, copy);
    assert.deepEqual(names(next.channels), ['vipchat']);
    const done = await k.recover.execute(k.server.guild, next, 'OWNER');
    assert.deepEqual(done.channels.made, ['vipchat']);
    // and the channel is made inside the category that was made the first time
    assert.equal(k.server.channelByName('vipchat')[0].parent_id, k.server.channelByName('GENERAL')[0].id);
  } finally {
    k.done();
  }
});

test('ticket channels, managed roles and the @everyone role are never made again', async () => {
  const spec = typical();
  spec.channels.push({ id: 't1', name: 'ticket-0007', parent_id: 'CAT2', permission_overwrites: [] });
  const k = setup(spec);
  try {
    const copy = await k.copy();
    k.server.deleteChannel('t1');
    k.server.deleteRole('OTHERBOT');
    const plan = await k.recover.plan(k.server.guild, copy);
    assert.equal(plan.empty, true);
  } finally {
    k.done();
  }
});

test('a deleted category frees its channels, they only go back when the category itself was missing', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    // an admin moves "chat" out of its category on purpose; the category stays
    await k.server.rest.patch('/channels/chat', { body: { parent_id: null } });
    const plan = await k.recover.plan(k.server.guild, copy);
    assert.deepEqual(plan.reparent, []);
    assert.equal(plan.empty, true);
  } finally {
    k.done();
  }
});

test('the saved ids and the settings follow what was made again, also after a restart and after a second recovery', async () => {
  const k = setup();
  try {
    k.storage.data.tickets[G] = { staffRoleId: 'MODR', categoryId: 'CAT2', counter: 3 };
    k.storage.data.autoRoles[G] = { roleId: 'VIPR' };
    k.storage.data.setup[G] = { roles: { verified: 'VIPR' }, channels: { verify_ch: 'staff', other: 'chat' } };
    const copy = await k.copy();
    attack(k.server);
    await run(k, copy);

    const mod = k.server.roleByName('Mod')[0].id;
    const vip = k.server.roleByName('VIP')[0].id;
    const staff = k.server.channelByName('staff')[0].id;
    const cat = k.server.channelByName('GENERAL')[0].id;
    assert.deepEqual([k.storage.data.tickets[G].staffRoleId, k.storage.data.tickets[G].categoryId, k.storage.data.tickets[G].counter], [mod, cat, 3]);
    assert.equal(k.storage.data.autoRoles[G].roleId, vip);
    assert.deepEqual(k.storage.data.setup[G], { roles: { verified: vip }, channels: { verify_ch: staff, other: 'chat' } });
    assert.equal(k.config.logs.channelId, staff);
    assert.equal(k.config.tickets.notify.channelId, staff);
    assert.deepEqual(k.config.tickets.notify.roleIds, [mod, 'ADMINR']);
    assert.equal(k.config.verified.roleId, vip);
    assert.equal(k.config.autoRole.id, vip);
    assert.deepEqual(k.config.web.roleIds, [vip]);

    // the host restarts: the settings come from the environment again, with the old ids
    const fresh = { logs: { channelId: 'staff' }, verified: { roleId: 'VIPR' }, autoRole: { id: 'VIPR' }, tickets: { notify: { channelId: 'staff', roleIds: ['MODR'] } }, web: { roleIds: ['VIPR'] } };
    applyRecovered(fresh, k.storage);
    assert.deepEqual([fresh.logs.channelId, fresh.verified.roleId, fresh.autoRole.id, fresh.tickets.notify.roleIds, fresh.web.roleIds], [staff, vip, vip, [mod], [vip]]);

    // the same channel is deleted a second time and made again: the old id still leads to the newest one
    k.server.deleteChannel(staff);
    const copy2 = await k.copy();
    assert.ok(copy2, 'a copy after the first recovery');
    const map = k.storage.data.recovered[G];
    assert.equal(resolve(map.channels, 'staff'), staff);
    map.channels[staff] = 'NEWER';
    assert.equal(resolve(map.channels, 'staff'), 'NEWER');
    assert.equal(resolve({ a: 'b', b: 'a' }, 'a').length > 0, true, 'a loop cannot hang');
    const survives = { logs: { channelId: 'staff' }, verified: {}, autoRole: {} };
    applyRecovered(survives, k.storage);
    assert.equal(survives.logs.channelId, 'NEWER');
  } finally {
    k.done();
  }
});

test('the preview belongs to the person who asked, works once and expires', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    k.server.deleteChannel('staff');
    const plan = await k.recover.plan(k.server.guild, copy);
    const token = k.recover.createPending('OWNER', G, plan);
    assert.equal(k.recover.takePending(token, { guildId: G, userId: 'SOMEONE' }), null);
    assert.equal(k.recover.takePending(token, { guildId: '999', userId: 'OWNER' }), null);
    assert.equal(k.recover.takePending(token, { guildId: G, userId: 'OWNER' }), plan);
    assert.equal(k.recover.takePending(token, { guildId: G, userId: 'OWNER' }), null, 'once');

    k.recover.confirmTtlMs = -1;
    const old = k.recover.createPending('OWNER', G, plan);
    assert.equal(k.recover.takePending(old, { guildId: G, userId: 'OWNER' }), null, 'expired');
    k.recover.confirmTtlMs = 60_000;
    const dropped = k.recover.createPending('OWNER', G, plan);
    k.recover.dropPending(dropped);
    assert.equal(k.recover.takePending(dropped, { guildId: G, userId: 'OWNER' }), null);
  } finally {
    k.done();
  }
});

test('two recoveries at once: the second one waits outside', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    k.server.deleteChannel('staff');
    const plan = await k.recover.plan(k.server.guild, copy);
    const [a, b] = await Promise.all([k.recover.execute(k.server.guild, plan, 'OWNER'), k.recover.execute(k.server.guild, plan, 'OWNER')]);
    assert.equal([a, b].filter((r) => r.reason === 'busy').length, 1);
    assert.equal(k.server.channelByName('staff').length, 1);
  } finally {
    k.done();
  }
});

test('progress is reported while it runs', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    attack(k.server);
    const plan = await k.recover.plan(k.server.guild, copy);
    const seen = [];
    await k.recover.execute(k.server.guild, plan, 'OWNER', { onProgress: (p) => seen.push(p) });
    assert.ok(seen.length >= 5);
    assert.equal(seen[seen.length - 1].done, seen[seen.length - 1].total);
  } finally {
    k.done();
  }
});

test('a role that cannot be made drops its permissions from the new channels instead of failing them', async () => {
  const k = setup();
  try {
    const copy = await k.copy();
    attack(k.server);
    k.server.failWhen = (m, route, body) => (m === 'POST' && body && body.name === 'VIP' ? Object.assign(new Error('Missing Permissions'), { code: 50013 }) : null);
    const { res } = await run(k, copy);
    assert.deepEqual(res.roles.failed.map((f) => f.name), ['VIP']);
    assert.deepEqual(res.channels.failed, []);
    assert.equal(res.channels.droppedOverwrites, 2, 'the VIP overwrite and the person who left');
  } finally {
    k.done();
  }
});

// ---------- 150 random servers, a random attack, then recover ----------

const O = require('../src/services/overwrites');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomServer(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const flags = [VIEW, SEND, P.ManageMessages, P.Connect, P.Speak, P.AttachFiles];
  const someBits = () => flags.reduce((acc, f) => (rand() < 0.4 ? acc | f : acc), 0n);
  const roles = [
    { id: G, name: '@everyone', permissions: VIEW | SEND, position: 0 },
    { id: 'BOTR', name: '35xw', permissions: P.Administrator, position: 50, managed: true },
  ];
  const roleCount = 3 + Math.floor(rand() * 6);
  for (let i = 0; i < roleCount; i += 1) roles.push({ id: `R${i}`, name: `role${i}`, permissions: rand() < 0.1 ? P.Administrator : someBits(), position: i + 1, color: Math.floor(rand() * 16777215), hoist: rand() < 0.3 });

  const members = [{ id: 'OWNER', roles: [] }, { id: 'BOT', roles: ['BOTR'] }];
  const memberCount = 4 + Math.floor(rand() * 6);
  for (let i = 0; i < memberCount; i += 1) {
    const mine = roles.filter((r) => r.id.startsWith('R') && rand() < 0.4).map((r) => r.id);
    members.push({ id: `M${i}`, roles: mine });
  }

  const overwrites = () => {
    const out = [];
    const n = Math.floor(rand() * 4);
    const used = new Set();
    for (let i = 0; i < n; i += 1) {
      const kind = rand();
      const target = kind < 0.15 ? { id: G, type: 0 } : kind < 0.75 ? { id: pick(roles.filter((r) => r.id.startsWith('R'))).id, type: 0 } : { id: pick(members).id, type: 1 };
      if (used.has(target.id)) continue;
      used.add(target.id);
      const allow = someBits();
      out.push(ow(target.id, target.type, allow, someBits() & ~allow));
    }
    return out;
  };

  const channels = [];
  const categories = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < categories; i += 1) channels.push({ id: `K${i}`, type: 4, name: `cat${i}`, permission_overwrites: overwrites() });
  const chanCount = 3 + Math.floor(rand() * 8);
  for (let i = 0; i < chanCount; i += 1) channels.push({ id: `C${i}`, type: rand() < 0.3 ? 2 : 0, name: `chan${i}`, parent_id: rand() < 0.7 ? `K${Math.floor(rand() * categories)}` : null, topic: rand() < 0.5 ? `topic ${i}` : null, permission_overwrites: overwrites() });
  return { roles, channels, members };
}

/** Everything a person could notice, by NAME so ids do not matter: who can do what where, who holds which role. */
function observe(server) {
  const roleList = [...server.state.roles.values()].map((r) => ({ id: r.id, permissions: String(r.permissions) }));
  const roleName = (id) => (server.state.roles.get(id) || {}).name;
  const chanName = (id) => (server.state.channels.get(id) || {}).name;
  const out = { perms: {}, parent: {}, roles: {}, memberRoles: {}, topic: {} };
  for (const c of server.state.channels.values()) {
    out.parent[c.name] = c.parent_id ? chanName(c.parent_id) : null;
    out.topic[c.name] = c.topic || null;
    for (const m of server.state.members.values()) {
      out.perms[`${m.id}|${c.name}`] = String(O.memberPerms({ memberId: m.id, roleIds: m.roles || [], roles: roleList, channel: { overwrites: c.permission_overwrites }, everyoneId: G, ownerId: 'OWNER' }));
    }
  }
  for (const r of server.state.roles.values()) out.roles[r.name] = String(r.permissions);
  for (const m of server.state.members.values()) out.memberRoles[m.id] = (m.roles || []).map(roleName).sort();
  return out;
}

test('150 random servers: after a random attack and /sos recover everybody can do the same things in the same channels as before', async () => {
  for (let seed = 1; seed <= 150; seed += 1) {
    const rand = rng(seed);
    const k = setup(randomServer(rand));
    try {
      const before = observe(k.server);
      const copy = await k.copy();
      const roleCount = k.server.state.roles.size;
      const chanCount = k.server.state.channels.size;

      let hit = 0;
      for (const r of [...k.server.state.roles.values()]) if (r.id.startsWith('R') && rand() < 0.4) (k.server.deleteRole(r.id), (hit += 1));
      for (const c of [...k.server.state.channels.values()]) if (rand() < 0.4) (k.server.deleteChannel(c.id), (hit += 1));

      const plan = await k.recover.plan(k.server.guild, copy);
      const { res } = { res: await k.recover.execute(k.server.guild, plan, 'OWNER') };
      assert.equal(res.ok, true, `seed ${seed}`);
      assert.deepEqual([res.roles.failed, res.channels.failed, res.roles.giveFailed, res.channels.moveFailed, res.channels.restoreFailed], [[], [], 0, 0, 0], `seed ${seed}`);
      assert.equal(k.server.state.roles.size, roleCount, `seed ${seed}: as many roles as before`);
      assert.equal(k.server.state.channels.size, chanCount, `seed ${seed}: as many channels as before`);
      assert.deepEqual(observe(k.server), before, `seed ${seed}: everybody can do the same things as before (${hit} deleted)`);

      // and a second run changes nothing
      const calls = k.server.calls.filter(([m]) => m !== 'GET').length;
      const again = await k.recover.plan(k.server.guild, copy);
      assert.equal(again.empty, true, `seed ${seed}: nothing left to recover`);
      await k.recover.execute(k.server.guild, again, 'OWNER');
      assert.equal(k.server.calls.filter(([m]) => m !== 'GET').length, calls, `seed ${seed}: nothing written the second time`);
    } finally {
      k.done();
    }
  }
});
