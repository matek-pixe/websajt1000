'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType } = require('discord.js');
const nuke = require('../src/commands/nuke');
const { Cooldown } = require('../src/services/cooldown');

const T = ChannelType;

function mkGuild(list) {
  const cache = new Map();
  cache.find = (fn) => [...cache.values()].find(fn);
  const g = { id: 'G', name: 'Guild', rulesChannelId: 'rules', publicUpdatesChannelId: null, channels: { cache }, deleted: [] };
  const add = (o) => {
    const ch = {
      ...o,
      sent: [],
      async delete() {
        if (o.fails) throw new Error('Missing Access');
        g.deleted.push(o.id);
        cache.delete(o.id);
      },
      async send(p) {
        ch.sent.push(p);
      },
    };
    cache.set(o.id, ch);
    return ch;
  };
  g.channels.fetch = async () => cache;
  g.channels.create = async (o) => add({ id: `new-${o.name}`, name: o.name, type: o.type });
  for (const c of list) add(c);
  return g;
}

function press(g, { userId = 'OWNER', log = [] } = {}) {
  const st = { updates: [], edits: [], replies: [] };
  const it = {
    customId: 'n:confirm',
    guild: g,
    guildId: g.id,
    user: { id: userId },
    deferred: false,
    replied: false,
    async update(p) {
      st.updates.push(p);
    },
    async editReply(p) {
      st.edits.push(p);
    },
    async reply(p) {
      st.replies.push(p);
    },
  };
  const ctx = {
    config: { finalChannelName: 'zavrseno', nukeDelayMs: 0 },
    cooldown: new Cooldown(30_000),
    isBypass: () => false,
    isOwnerOrManager: () => userId === 'OWNER' || userId === 'MGR',
    logs: {
      hold: (id) => {
        log.push(['hold', id]);
        return () => log.push(['release', id]);
      },
      post: (guild, embed) => log.push(['post', embed.toJSON().title]),
      flush: async () => log.push(['flush']),
    },
  };
  return { it, ctx, st, log };
}

test('/n writes the start to the server log first, mutes the log while it runs, and leaves only zavrseno', async () => {
  const g = mkGuild([
    { id: 'c1', name: 'general', type: T.GuildText },
    { id: 'cat', name: 'stuff', type: T.GuildCategory },
    { id: 'c2', name: 'chat', type: T.GuildText, parentId: 'cat' },
    { id: 'rules', name: 'rules', type: T.GuildText },
    { id: 'stuck', name: 'stuck', type: T.GuildText, fails: true },
  ]);
  const { it, ctx, st, log } = press(g);
  await nuke.handleButton(it, ctx);
  assert.deepEqual(log, [['hold', 'G'], ['post', 'Server wipe started'], ['flush'], ['release', 'G']]);
  assert.deepEqual(g.deleted.sort(), ['c1', 'c2', 'cat']);
  const left = [...g.channels.cache.values()].map((c) => c.name).sort();
  assert.deepEqual(left, ['rules', 'stuck', 'zavrseno']); // the ones Discord or a failure kept, plus the keeper
  assert.equal(st.updates.length, 1);
  assert.equal(st.updates[0].embeds[0].toJSON().title, 'Deleting channels');
  assert.equal(g.channels.cache.get('new-zavrseno').sent[0].embeds[0].toJSON().title, 'Server cleared');
});

test('/n: an admin who is not the owner cannot confirm, and a second run on the same server is refused', async () => {
  const g = mkGuild([{ id: 'c1', name: 'general', type: T.GuildText }]);
  const denied = press(g, { userId: 'ADMIN' });
  await nuke.handleButton(denied.it, denied.ctx);
  assert.equal(g.deleted.length, 0);
  assert.match(denied.st.replies[0].embeds[0].toJSON().description, /server owner/);
  assert.deepEqual(denied.log, []);

  // cancel leaves everything alone
  const cancel = press(g);
  cancel.it.customId = 'n:cancel';
  await nuke.handleButton(cancel.it, cancel.ctx);
  assert.equal(g.deleted.length, 0);
  assert.equal(cancel.st.updates[0].components.length, 0);
});
