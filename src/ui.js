'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');

/**
 * One look for everything the bot posts.
 *
 * House style:
 *  - neutral cards; colour only when it means something (done, warning, problem)
 *  - at most one icon in a title, none in body text
 *  - plain sentences, no exclamation marks, no dashes used as punctuation
 *  - titles are 1 to 4 words in sentence case
 */

const COLORS = Object.freeze({
  neutral: 0x2b2d31, // same as Discord's dark embed background, so no side bar shows
  brand: 0x5865f2,
  ok: 0x3ba55d,
  warn: 0xfaa61a,
  danger: 0xed4245,
  info: 0x5865f2, // older call sites
});

const TONES = Object.freeze({
  neutral: COLORS.neutral,
  brand: COLORS.brand,
  info: COLORS.brand,
  ok: COLORS.ok,
  warn: COLORS.warn,
  danger: COLORS.danger,
});

const BRAND = '35xw';

/**
 * Build an embed in the house style.
 * `footer`: undefined -> "35xw", a string -> "35xw · string", false -> no footer.
 */
function card({ title, description, fields, tone = 'neutral', footer, timestamp = false, thumbnail } = {}) {
  const embed = new EmbedBuilder().setColor(TONES[tone] ?? COLORS.neutral);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (fields && fields.length) embed.addFields(fields);
  if (footer !== false) embed.setFooter({ text: footer ? `${BRAND} · ${footer}` : BRAND });
  if (timestamp) embed.setTimestamp();
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

const field = (name, value, inline = false) => ({ name, value: String(value), inline });

/** Reply (or edit the reply) privately, whichever is valid for the interaction's current state. */
async function ephemeral(interaction, payload) {
  const data = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (interaction.deferred || interaction.replied) {
    // The private flag is fixed when the reply is created; editReply must not carry it.
    delete data.flags;
    return interaction.editReply(data);
  }
  data.flags = MessageFlags.Ephemeral;
  return interaction.reply(data);
}

/** A short private message as a one-line card. */
function say(interaction, text, tone = 'neutral') {
  return ephemeral(interaction, { embeds: [card({ description: text, tone, footer: false })] });
}

const deny = (interaction, text) => say(interaction, text, 'danger');
const warn = (interaction, text) => say(interaction, text, 'warn');

// ---------- text helpers ----------

const mention = Object.freeze({
  user: (id) => `<@${id}>`,
  role: (id) => `<@&${id}>`,
  channel: (id) => `<#${id}>`,
});

/** Discord timestamp markup. Styles: t T d D f F R. */
const time = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (n) => Number(n || 0).toLocaleString('en-US');
const truncate = (s, max) => (String(s).length > max ? `${String(s).slice(0, max - 1)}…` : String(s));
const codeBlock = (text) => '```\n' + text + '\n```';

/** "a, b, c and 4 more", capped so it always fits an embed field. */
function joinList(items, { max = 8, limit = 1000 } = {}) {
  if (!items.length) return 'None';
  const shown = items.slice(0, max);
  let out = shown.join(', ');
  if (items.length > shown.length) out += ` and ${items.length - shown.length} more`;
  return truncate(out, limit);
}

/** One item per line, capped, with a "+N more" tail. */
function lines(items, { max = 10, limit = 1000 } = {}) {
  if (!items.length) return 'None';
  const shown = items.slice(0, max);
  let out = shown.join('\n');
  if (items.length > shown.length) out += `\n+${items.length - shown.length} more`;
  return truncate(out, limit);
}

// ---------- shared wording ----------

const COPY = Object.freeze({
  unknownCommand: 'That command does not exist.',
  serverOnly: 'This command only works inside a server.',
  managerOnly: (name) => `Only the bot manager can use /${name}.`,
  ownerOnly: (name) => `Only the server owner can use /${name}.`,
  adminOnly: (name) => `Only administrators can use /${name}.`,
  staffOnly: (name) => `Only staff can use /${name}.`,
  cooldown: (seconds, name) => `You can use /${name} again in ${seconds}s.`,
  notVerified: ({ roleId, channelId }) =>
    `This command is for verified members. ${channelId ? `Open a ticket in ${mention.channel(channelId)}` : 'Open a ticket'} to get ${mention.role(roleId)}.`,
  failed: 'Something went wrong. Try again in a moment.',
});

module.exports = {
  COLORS,
  BRAND,
  card,
  field,
  ephemeral,
  say,
  deny,
  warn,
  mention,
  time,
  plural,
  num,
  truncate,
  codeBlock,
  joinList,
  lines,
  COPY,
};
