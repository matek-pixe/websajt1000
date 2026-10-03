'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const { Storage } = require('../src/storage');
const O = require('../src/services/overwrites');
const { LockdownService } = require('../src/services/lockdown');
const { tmpDir, rm } = require('./helpers');

const G = '100';
const VIEW = P.ViewChannel;
const SEND = P.SendMessages;
const ADMIN = P.Administrator;
const ow = (id, type, allow = 0n, deny = 0n) => ({ id, type, allow: String(allow), deny: String(deny) });

/** A tiny model of a Discord server that answers the REST calls the lockdown code makes. */
function makeServer({ roles, channels, members, ownerId = 'OWNER', botId = 'BOT' }) {
  const state = {
    roles: new Map(roles.map((r) => [r.id, { managed: false, position: 1, ...r, permissions: BigInt(r.permissions || 0) }])),
    channels: new Map(channels.map((c, i) => [c.id, { type: 0, position: i, parent_id: null, name: c.id, ...c, permission_overwrites: (c.permission_overwrites || []).map((o) => ({ ...o })) }])),
    members: new Map(members.map((m) => [m.id, { ...m }])),
  };
  const calls = [];
  const server = { state, calls, failWhen: null, G };
  const err = (code, message = `error ${code}`) => Object.assign(new Error(message), { code });

  server.rest = {
    async get(route) {
      calls.push(['GET', route]);
      let m;
      if (route === `/guilds/${G}/channels`) return [...state.channels.values()].map((c) => structuredClone(c));
      if (route === `/guilds/${G}/roles`) return [...state.roles.values()].map((r) => ({ ...r, permissions: String(r.permissions) }));
      if ((m = /^\/channels\/(\w+)$/.exec(route))) {
        if (!state.channels.has(m[1])) throw err(10003);
        return structuredClone(state.channels.get(m[1]));
      }
      throw new Error(`unexpected GET ${route}`);
    },
    async put(route, { body }) {
      const m = /^\/channels\/(\w+)\/permissions\/(\w+)$/.exec(route);
      calls.push(['PUT', route, body]);
      if (server.failWhen) { const e = server.failWhen('PUT', route, body); if (e) throw e; }
      const ch = state.channels.get(m[1]);
      if (!ch) throw err(10003);
      if (body.type === 0 && !state.roles.has(m[2])) throw err(10011);
      if (body.type === 1 && !state.members.has(m[2])) throw err(10013);
      const list = ch.permission_overwrites;
      const i = list.findIndex((o) => o.id === m[2]);
      const next = { id: m[2], type: body.type, allow: String(body.allow), deny: String(body.deny) };
      if (i >= 0) list[i] = next; else list.push(next);
    },
    async delete(route) {
      const m = /^\/channels\/(\w+)\/permissions\/(\w+)$/.exec(route);
      calls.push(['DELETE', route]);
      if (server.failWhen) { const e = server.failWhen('DELETE', route); if (e) throw e; }
      const ch = state.channels.get(m[1]);
      if (!ch) throw err(10003);
      ch.permission_overwrites = ch.permission_overwrites.filter((o) => o.id !== m[2]);
    },
    async patch(route, { body }) {
      const m = /^\/guilds\/\w+\/roles\/(\w+)$/.exec(route);
      calls.push(['PATCH', route, body]);
      if (server.failWhen) { const e = server.failWhen('PATCH', route, body); if (e) throw e; }
      if (!state.roles.has(m[1])) throw err(10011);
      state.roles.get(m[1]).permissions = BigInt(body.permissions);
    },
  };

  const botMember = state.members.get(botId);
  const botPerms = () => [...(botMember.roles || [])].reduce((a, id) => a | (state.roles.get(id) ? state.roles.get(id).permissions : 0n), 0n);
  const botRoleList = () => (botMember.roles || []).map((id) => state.roles.get(id)).filter(Boolean);
  server.guild = {
    id: G,
    name: 'Test Server',
    ownerId,
    members: {
      cache: new Map([...state.members.keys()].map((id) => [id, {}])),
      fetch: async (id) => (state.members.has(id) ? {} : null),
      fetchMe: async () => server.guild.members.me,
      me: {
        id: botId,
        permissions: { has: (f) => !!(botPerms() & ADMIN) || !!(botPerms() & f) },
        roles: { cache: new Map((botMember.roles || []).map((id) => [id, {}])), get highest() { return { position: Math.max(0, ...botRoleList().map((r) => r.position)) }; } },
      },
    },
  };

  /** What the server looks like now, in a form two states can be compared in. */
  server.dump = () => ({
    roles: [...state.roles.values()].map((r) => [r.id, String(r.permissions)]).sort(),
    channels: [...state.channels.values()].map((c) => [c.id, c.permission_overwrites.map((o) => `${o.id}:${o.type}:${o.allow}:${o.deny}`).sort()]).sort(),
  });
  /** Can this member see this channel right now, by Discord's rules. */
  server.canSee = (memberId, channelId) => {
    const roleList = [...state.roles.values()].map((r) => ({ id: r.id, permissions: String(r.permissions) }));
    const mem = state.members.get(memberId);
    return O.memberCanView({
      memberId,
      roleIds: mem.roles || [],
      roles: roleList,
      channel: { overwrites: state.channels.get(channelId).permission_overwrites },
      everyoneId: G,
      ownerId,
    });
  };
  return server;
}

function kit(serverOpts, { manager = 'MGR' } = {}) {
  const dir = tmpDir();
  const server = makeServer(serverOpts);
  const storage = new Storage(path.join(dir, 'db.json'));
  const svc = new LockdownService({ storage, config: { manager: { id: manager }, dataDir: dir }, rest: server.rest });
  return { dir, server, storage, svc, done: () => rm(dir) };
}

/** A realistic little server. */
function typical() {
  return {
    roles: [
      { id: G, name: '@everyone', permissions: VIEW | SEND, position: 0 },
      { id: 'ADMINR', name: 'Admin', permissions: ADMIN, position: 3 },
      { id: 'HIGHADM', name: 'Head admin', permissions: ADMIN, position: 9 }, // above the bot
      { id: 'MODR', name: 'Mod', permissions: VIEW | P.ManageMessages, position: 2 },
      { id: 'VIPR', name: 'VIP', permissions: VIEW, position: 1 },
      { id: 'BOTR', name: '35xw', permissions: ADMIN, position: 5, managed: true },
      { id: 'OTHERBOT', name: 'Other bot', permissions: ADMIN, position: 4, managed: true },
    ],
    channels: [
      { id: 'CAT1', type: 4, name: 'INFO', permission_overwrites: [ow(G, 0, 0n, SEND)] },
      { id: 'rules', parent_id: 'CAT1', permission_overwrites: [ow(G, 0, 0n, SEND)] },
      { id: 'CAT2', type: 4, name: 'GENERAL', permission_overwrites: [] },
      { id: 'chat', parent_id: 'CAT2', permission_overwrites: [] },
      { id: 'vipchat', parent_id: 'CAT2', permission_overwrites: [ow(G, 0, 0n, VIEW), ow('VIPR', 0, VIEW | SEND, 0n), ow('LEFT', 1, VIEW, 0n)] },
      { id: 'staff', parent_id: 'CAT2', permission_overwrites: [ow(G, 0, 0n, VIEW), ow('MODR', 0, VIEW | SEND, 0n), ow('U_ALLOWED', 1, VIEW, 0n)] },
      { id: 'voice', type: 2, parent_id: 'CAT2', permission_overwrites: [ow('MODR', 0, 0n, VIEW)] },
    ],
    members: [
      { id: 'OWNER', roles: [] },
      { id: 'MGR', roles: ['ADMINR'] },
      { id: 'BOT', roles: ['BOTR'] },
      { id: 'ADMIN1', roles: ['ADMINR'] },
      { id: 'HEAD', roles: ['HIGHADM'] },
      { id: 'MOD1', roles: ['MODR'] },
      { id: 'VIP1', roles: ['VIPR'] },
      { id: 'PLAIN', roles: [] },
      { id: 'U_ALLOWED', roles: [] },
    ],
  };
}


module.exports = { G, VIEW, SEND, ADMIN, ow, makeServer, kit, typical };
