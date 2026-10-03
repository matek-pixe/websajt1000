'use strict';

const fs = require('node:fs');
const { SlashCommandBuilder, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder } = require('discord.js');
const { card, field, ephemeral, deny, say, mention, num, lines, plural, time, COPY } = require('../ui');
const { parseBackup } = require('../services/lockdown');
const { allowed } = require('../services/transcriptMedia');

const progressCard = (title, done, total) =>
  card({ title, description: total ? `${num(done)} of ${num(total)} done. Do not stop the bot.` : 'Working. Do not stop the bot.', tone: 'warn', footer: 'sos' });

/** Show a result where the owner can still see it: the reply, else a direct message. */
async function deliver(interaction, payload) {
  try {
    await interaction.editReply({ ...payload, components: [] });
    return;
  } catch {
    /* the reply may have expired during a long run */
  }
  try {
    await interaction.user.send({ content: `Result of /sos on **${interaction.guild.name}**`, ...payload });
    return;
  } catch {
    /* direct messages may be closed */
  }
  console.warn('[35xw] /sos: could not deliver the result anywhere');
}

/** Edit a progress card now and then, never more than every few seconds, never failing. */
function throttled(interaction, title) {
  let last = 0;
  let editable = true;
  return async ({ done, total }) => {
    if (!editable || Date.now() - last < 4000) return;
    last = Date.now();
    try {
      await interaction.editReply({ embeds: [progressCard(title, done, total)] });
    } catch {
      editable = false;
    }
  };
}

function previewCard(scan) {
  const { summary: s, plan } = scan;
  const kinds = Object.entries(s.kinds).map(([k, n]) => `${n} ${k}`).join(', ');
  const stay = [mention.user(plan.ownerId), ...(plan.managerId && plan.managerId !== plan.ownerId ? [mention.user(plan.managerId)] : []), 'this bot'];
  const adminLine = scan.keepAdmins
    ? 'Admin roles are kept (keep_admins), so admins can still see everything.'
    : plan.strip.length
      ? `These lose Administrator until /sos end:\n${lines(plan.strip.map((r) => r.name), { max: 10, limit: 500 })}`
      : 'No role has Administrator.';
  const fields = [
    field('Channels', `${num(s.total)} (${kinds}). ${num(s.everyone)} visible to everyone today, ${num(s.restricted)} restricted.`),
    field('What changes', `${plural(s.toChange, 'channel')} get new permissions: ${num(s.flipped)} overwrites switched, ${num(s.adds)} added.`),
    field('Still sees everything', stay.join(', ')),
    field('Administrator roles', adminLine),
  ];
  if (plan.stuck.length) {
    fields.push(field('Cannot be hidden from', lines(plan.stuck.map((r) => `${r.name}: ${r.reason}`), { max: 8, limit: 800 })));
  }
  fields.push(
    field(
      'Good to know',
      'Everything is saved to a file and to the database before the first change, and I send you a copy. New channels made while SOS is on are not covered. People in voice channels are disconnected.' +
        (scan.community && scan.community.length ? ' Discord may refuse to hide the Community rules and updates channels, they have to stay public.' : ''),
    ),
  );
  return card({
    title: 'SOS preview',
    description: 'Nothing has changed yet. Start saves the whole server, then hides every channel from everyone except the owner. `/sos end` puts everything back exactly as it was. The attached file shows who can see what today.',
    fields,
    tone: 'warn',
    footer: 'sos',
  });
}

function startedCard(res, who) {
  const problems = res.failed.map((f) => `${f.kind === 'role' ? 'Role' : 'Channel'} ${f.name}: ${f.error}`);
  return card({
    title: res.failed.length ? 'SOS is on, with problems' : 'SOS is on',
    description: `Every channel is hidden from everyone except ${who}. Run \`/sos end\` to put everything back exactly as it was.`,
    fields: [
      field('Channels hidden', `${num(res.hidden)} of ${num(res.channels)}`, true),
      field('Admin roles lowered', `${num(res.stripped)} of ${num(res.strip)}`, true),
      ...(problems.length ? [field('Could not change', lines(problems, { max: 8, limit: 900 }))] : []),
      field('Saved copy', `\`${res.backupFile.split(/[\\/]/).slice(-2).join('/')}\` on the bot's disk, and a copy in your DMs.`),
    ],
    tone: res.failed.length ? 'danger' : 'ok',
    footer: 'sos',
  });
}

function endedCard(res) {
  const c = res.channels;
  const problems = [
    ...c.failed.map((f) => `${f.channel}: ${f.error}`),
    ...c.mismatches.map((m) => `${m.channel}: does not match the saved copy yet`),
    ...res.roles.failed.map((f) => `Role ${f.name}: ${f.error}`),
    ...res.roleMismatch.map((n) => `Role ${n}: does not match the saved copy yet`),
  ];
  const notes = [
    ...(c.gone.length ? [`${plural(c.gone.length, 'channel')} deleted meanwhile: ${c.gone.slice(0, 5).join(', ')}`] : []),
    ...(c.lost.length ? [`${plural(c.lost.length, 'overwrite')} belonged to roles or members that no longer exist`] : []),
    ...(res.roles.gone.length ? [`${plural(res.roles.gone.length, 'role')} deleted meanwhile: ${res.roles.gone.join(', ')}`] : []),
  ];
  return card({
    title: res.ok ? 'Everything is back' : 'Restore not finished',
    description: res.ok
      ? `I read ${plural(res.checked, 'channel')} and the changed roles again and compared them with the saved copy. They are identical.`
      : 'Some things could not be put back or do not match yet. SOS stays on and nothing is forgotten. Run `/sos end` again.',
    fields: [
      field('Channels', `${num(c.restored)} restored, ${num(c.unchanged)} were already right`, true),
      field('Roles', `${num(res.roles.restored)} restored`, true),
      ...(notes.length ? [field('Noted', lines(notes, { max: 6, limit: 900 }))] : []),
      ...(problems.length ? [field('Still to fix', lines(problems, { max: 8, limit: 900 }))] : []),
    ],
    tone: res.ok ? 'ok' : 'danger',
    footer: 'sos',
  });
}

/** The backup file the owner attached, checked and parsed. Returns { record } or { error }. */
async function readBackup(attachment, guildId) {
  if (!/\.json$/i.test(attachment.name || '')) return { error: 'The backup must be the .json file I sent you.' };
  if ((attachment.size || 0) > 20 * 1024 * 1024) return { error: 'That file is too large to be a backup.' };
  if (!allowed(attachment.url)) return { error: 'I can only read attachments from Discord.' };
  try {
    const res = await fetch(attachment.url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { error: 'I could not download that file.' };
    const record = parseBackup(await res.text(), guildId);
    return record ? { record } : { error: 'That is not a backup of this server made by /sos start.' };
  } catch {
    return { error: 'I could not read that file.' };
  }
}

/**
 * /sos: an emergency button for the owner.
 *   start   saves everything first, then nobody but the owner sees any channel
 *   end     puts everything back exactly as it was, and proves it
 *   status  shows whether it is on
 */
module.exports = {
  ownerOnly: true,
  noCooldown: true, // an emergency tool must never wait
  audit: true, // leaves a line in the server log
  buttonPrefix: 'sos:',
  data: new SlashCommandBuilder()
    .setName('sos')
    .setDescription('Emergency: hide every channel from everyone except the owner (owner only)')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Save the whole server, then hide every channel from everyone except the owner')
        .addBooleanOption((opt) => opt.setName('keep_admins').setDescription('Leave the Administrator roles alone, default is no').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('Put every channel and role back exactly as it was')
        .addAttachmentOption((opt) => opt.setName('backup').setDescription('Only if I forgot the saved copy: the .json file I sent you').setRequired(false)),
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Show whether SOS is on')),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'status') return status(interaction, ctx);
    if (sub === 'start') return start(interaction, ctx);
    return end(interaction, ctx);
  },

  async handleButton(interaction, ctx) {
    if (!ctx.isOwnerOrManager()) return deny(interaction, COPY.ownerOnly('sos'));
    const [, action, token] = interaction.customId.split(':');
    if (action === 'no') {
      ctx.lockdown.dropPending(token);
      return interaction.update({ embeds: [card({ title: 'Cancelled', description: 'Nothing was changed.', footer: 'sos' })], components: [], attachments: [] });
    }
    if (action !== 'go') return undefined;

    const scan = ctx.lockdown.takePending(token, { guildId: interaction.guildId, userId: interaction.user.id });
    if (!scan) {
      return interaction.update({
        embeds: [card({ title: 'Preview expired', description: 'Run /sos start again to see the current state.', tone: 'warn', footer: 'sos' })],
        components: [],
        attachments: [],
      });
    }
    await interaction.update({ embeds: [progressCard('Saving the server and hiding every channel', 0, scan.plan.channels.length + scan.plan.strip.length)], components: [], attachments: [] });

    const guild = interaction.guild;
    const release = ctx.logs ? ctx.logs.hold(guild.id) : () => {};
    let res;
    try {
      res = await ctx.lockdown.start(guild, scan, interaction.user.id, { onProgress: throttled(interaction, 'Hiding every channel') });
    } catch (err) {
      console.error('[35xw] /sos start failed:', err);
      res = { ok: false, reason: 'error', error: err.message };
    } finally {
      release();
    }

    if (!res.ok) {
      const text =
        res.reason === 'active'
          ? 'SOS is already on. Run /sos end first.'
          : res.reason === 'busy'
            ? 'Another SOS action is still running.'
            : `Nothing was hidden. ${res.error ? `${res.error}. ` : ''}Check the bot's console, then try again.`;
      return deliver(interaction, { embeds: [card({ title: 'SOS did not start', description: text, tone: 'danger', footer: 'sos' })] });
    }

    const who = [mention.user(scan.plan.ownerId), ...(scan.plan.managerId && scan.plan.managerId !== scan.plan.ownerId ? [mention.user(scan.plan.managerId)] : [])].join(' and ');
    if (ctx.logs) ctx.logs.post(guild, card({ title: 'SOS started', description: `${mention.user(interaction.user.id)} hid every channel. ${plural(res.hidden, 'channel')} changed.`, tone: 'danger', footer: 'sos', timestamp: true }));
    await deliver(interaction, { embeds: [startedCard(res, who)] });
    // A copy outside the server and outside the bot's disk, in case both are ever lost.
    try {
      await interaction.user.send({ content: `Saved copy of **${guild.name}** before SOS. Keep it. If I ever lose my own copy, give this file to \`/sos end backup:\`.`, files: [new AttachmentBuilder(fs.readFileSync(res.backupFile), { name: res.backupFile.split(/[\\/]/).pop() })] });
    } catch {
      console.warn('[35xw] /sos: could not DM the backup copy');
    }
    return undefined;
  },
};

async function status(interaction, ctx) {
  const s = ctx.lockdown.state(interaction.guildId);
  if (!s || !s.active) {
    return ephemeral(interaction, {
      embeds: [card({ title: 'SOS is off', description: s && s.endedAt ? `Last ended ${time(new Date(s.endedAt).getTime(), 'R')}.` : 'It has not been used on this server.', footer: 'sos' })],
    });
  }
  return ephemeral(interaction, {
    embeds: [
      card({
        title: 'SOS is on',
        description: s.phase === 'restore_incomplete' ? 'The last `/sos end` could not finish. Run it again.' : s.phase === 'applying' ? 'It was still hiding channels when it stopped. `/sos end` puts everything back.' : 'Every channel is hidden. `/sos end` puts everything back.',
        fields: [
          field('Started', `${time(new Date(s.startedAt).getTime(), 'R')} by ${mention.user(s.startedBy)}`, true),
          field('Saved copy', `${num(s.snapshot.channels.length)} channels, ${num(s.snapshot.roles.length)} roles`, true),
          ...(s.failed && s.failed.length ? [field('Could not be hidden', lines(s.failed.map((f) => f.name), { max: 8, limit: 600 }))] : []),
          field('File', `\`${String(s.backupFile).split(/[\\/]/).slice(-2).join('/')}\``),
        ],
        tone: 'warn',
        footer: 'sos',
      }),
    ],
  });
}

async function start(interaction, ctx) {
  const keepAdmins = interaction.options.getBoolean('keep_admins') || false;
  let scan;
  try {
    scan = await ctx.lockdown.scan(interaction.guild, { keepAdmins });
  } catch (err) {
    console.error('[35xw] /sos scan failed:', err);
    return deny(interaction, `I could not read the server: ${err.message}`);
  }
  if (!scan.ok) {
    const text =
      scan.reason === 'active'
        ? 'SOS is already on. Run /sos end first.'
        : scan.reason === 'permissions'
          ? 'I need Administrator, or Manage Roles and Manage Channels, to change channel permissions.'
          : 'I could not find my own member on this server.';
    return deny(interaction, text);
  }
  const token = ctx.lockdown.createPending(interaction.user.id, interaction.guildId, scan);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sos:go:${token}`).setLabel('Start SOS').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`sos:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return ephemeral(interaction, {
    embeds: [previewCard(scan)],
    files: [new AttachmentBuilder(Buffer.from(scan.report, 'utf8'), { name: 'sos-scan.txt' })],
    components: [row],
  });
}

async function end(interaction, ctx) {
  const guild = interaction.guild;
  const file = interaction.options.getAttachment('backup');
  let record = null;
  if (file) {
    const read = await readBackup(file, guild.id);
    if (read.error) return deny(interaction, read.error);
    record = read.record;
  }
  if (!record && !ctx.lockdown.isActive(guild.id)) {
    return say(interaction, 'SOS is not on. If I lost my copy, run /sos end and attach the .json file I sent you.', 'warn');
  }

  await ephemeral(interaction, { embeds: [progressCard('Putting everything back', 0, 0)] });
  const release = ctx.logs ? ctx.logs.hold(guild.id) : () => {};
  let res;
  try {
    res = await ctx.lockdown.end(guild, interaction.user.id, { record, onProgress: throttled(interaction, 'Putting everything back') });
  } catch (err) {
    console.error('[35xw] /sos end failed:', err);
    res = { ok: false, reason: 'error', error: err.message };
  } finally {
    release();
  }

  if (res.reason) {
    const text =
      res.reason === 'busy'
        ? 'Another SOS action is still running.'
        : res.reason === 'wrong_server'
          ? 'That backup belongs to another server.'
          : res.reason === 'not_active'
            ? 'SOS is not on.'
            : `Something went wrong: ${res.error || res.reason}. Nothing is forgotten. Run /sos end again.`;
    return deliver(interaction, { embeds: [card({ title: 'Restore not finished', description: text, tone: 'danger', footer: 'sos' })] });
  }
  if (ctx.logs) ctx.logs.post(guild, card({ title: res.ok ? 'SOS ended' : 'SOS end incomplete', description: `${mention.user(interaction.user.id)} ran /sos end.`, tone: res.ok ? 'ok' : 'danger', footer: 'sos', timestamp: true }));
  return deliver(interaction, { embeds: [endedCard(res)] });
}
