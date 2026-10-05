'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { card, field, ephemeral, deny, say, mention, num, lines, plural } = require('../ui');
const { isAdminOrAbove } = require('../gates');

const channelsOf = (n) => plural(n, 'channel');

/** The preview: everything /priv would do, in plain words. Nothing has changed yet. */
function previewCard(plan) {
  const fields = [];

  if (plan.priv) {
    const { category, role, channels } = plan.priv;
    fields.push(field('Priv role', `${role ? `${mention.role(role.id)} exists` : 'A role called priv will be created'}, with no permissions of its own. It opens **${category.name}** and ${channelsOf(channels)} inside: see, write, join and speak in voice.`));
  } else {
    fields.push(field('Priv role', `Skipped, the category ${plan.privMissing} is not on this server.`));
  }

  if (plan.staff) {
    const { categories, role, extra, add, channels, read } = plan.staff;
    const base = role
      ? `${mention.role(role.id)} exists.${add.length ? ` It gets ${add.join(' and ')} added, nothing is taken away.` : ' It already has what it needs.'}${extra.length ? ` It also has ${extra.slice(0, 6).join(', ')}${extra.length > 6 ? '…' : ''}, I will not change that.` : ''}`
      : 'A role called staff will be created that can **only kick people and delete messages**.';
    const opens = categories.length ? ` It opens ${categories.map((c) => `**${c.name}**`).join(' and ')} and ${channelsOf(channels)} inside, same access as priv.` : '';
    fields.push(field('Staff role', `${base}${opens}${plan.staffMissing.length ? ` Not on this server: ${plan.staffMissing.join(', ')}.` : ''}`));
    if (read.length) {
      fields.push(field('Staff in the private category', `It can see ${plural(read.length, 'channel')} there, the category and the log channel, and read them. It cannot write, react, join voice or delete messages in them.`));
    }
  } else {
    fields.push(field('Staff role', 'Skipped, none of the staff categories or the private category are on this server.'));
  }

  const m = plan.member;
  if (m.skip) {
    fields.push(field('Member role', m.skip));
  } else {
    const parts = [];
    parts.push(m.create ? `A role called ${m.wanted} will be created.` : `${mention.role(m.keep.id)} is the one that stays, it has ${plural(m.keep.members ? m.keep.members.size : 0, 'member')}.`);
    if (m.rename) parts.push(`It is renamed from ${m.keep.name} to **${m.wanted}**.`);
    parts.push('New members get exactly this role.');
    parts.push(`It is given to ${num(m.giveTo)} of ${num(m.total)} members${m.total - m.giveTo ? ` (${num(m.total - m.giveTo)} already have it)` : ''}, bots skipped.`);
    fields.push(field('Member role', parts.join(' ')));
    const del = m.dups.filter((d) => d.action === 'delete');
    const keep = m.dups.filter((d) => d.action === 'keep');
    if (del.length) fields.push(field(`Deleted (${del.length})`, lines(del.map((d) => `${d.name}, ${plural(d.members, 'member')}`), { max: 10, limit: 900 })));
    if (keep.length) fields.push(field('Other member roles left alone', lines(keep.map((d) => `${d.name}: ${d.reason}`), { max: 8, limit: 900 })));
  }

  const deleting = !plan.member.skip && plan.member.dups.some((d) => d.action === 'delete');
  return card({
    title: 'Priv setup preview',
    description: 'Nothing has changed yet. Run does all of this in one go.' + (deleting ? ' Deleted roles cannot be brought back. Members of a deleted role get the member role first.' : ''),
    fields,
    tone: deleting ? 'warn' : 'neutral',
    footer: 'priv',
  });
}

function access(res) {
  const failed = res.failed.map((f) => `${f.name}: ${f.error}`);
  return { count: res.done.length, failed, skipped: res.skipped };
}

/** The result: what was made, what was opened, what was given and what was deleted. */
function resultCard(res) {
  const fields = [];
  let problems = 0;

  if (res.priv) {
    const a = access(res.priv);
    problems += a.failed.length;
    fields.push(field('Priv role', `${mention.role(res.priv.role.id)} ${res.priv.created ? 'created' : 'reused'}. Opened ${channelsOf(a.count)}.${a.skipped.length ? ` Not granted, I do not hold them: ${a.skipped.join(', ')}.` : ''}`));
    if (a.failed.length) fields.push(field('Priv, could not change', lines(a.failed, { max: 6, limit: 800 })));
  }

  if (res.staff) {
    const a = access(res.staff);
    const r = access(res.staff.read);
    problems += a.failed.length + r.failed.length + res.staff.errors.length;
    const note = res.staff.created
      ? ' It can only kick people and delete messages.'
      : `${res.staff.added.length ? ` Added ${res.staff.added.join(' and ')}.` : ''}${res.staff.extra.length ? ` It also has ${res.staff.extra.slice(0, 6).join(', ')}, left as it is.` : ''}`;
    fields.push(field('Staff role', `${mention.role(res.staff.role.id)} ${res.staff.created ? 'created' : 'reused'}.${note} Opened ${channelsOf(a.count)}, and can read ${channelsOf(r.count)} in the private category and the log.`));
    const bad = [...res.staff.errors, ...a.failed, ...r.failed];
    if (bad.length) fields.push(field('Staff, could not change', lines(bad, { max: 6, limit: 800 })));
  }

  const m = res.member;
  if (m && m.skipped) {
    fields.push(field('Member role', m.skipped));
  } else if (m) {
    problems += m.failedCount + m.errors.length;
    const bits = [`${mention.role(m.role.id)} ${m.created ? 'created' : m.renamed ? 'renamed' : 'kept'}.`, `Given to ${num(m.given)} members, ${num(m.already)} already had it${m.failedCount ? `, ${num(m.failedCount)} failed` : ''}.`];
    fields.push(field('Member role', bits.join(' ')));
    if (m.deleted.length) fields.push(field(`Deleted (${m.deleted.length})`, lines(m.deleted.map((d) => `${d.name}, ${plural(d.members, 'member')}`), { max: 10, limit: 900 })));
    if (m.kept.length) fields.push(field('Left alone', lines(m.kept.map((d) => `${d.name}: ${d.reason}`), { max: 8, limit: 900 })));
    const errors = [...m.errors, ...m.failed];
    if (errors.length) fields.push(field('Problems', lines(errors, { max: 6, limit: 900 })));
  }

  return card({
    title: problems ? 'Priv setup done, with problems' : 'Priv setup done',
    fields,
    tone: problems ? 'warn' : 'ok',
    footer: 'priv',
  });
}

/** Show a result where the admin can still see it: the reply, else a direct message. */
async function deliver(interaction, embed) {
  try {
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  } catch {
    /* the reply may have expired during a long run */
  }
  try {
    await interaction.user.send({ content: `Result of /priv on **${interaction.guild.name}**`, embeds: [embed] });
  } catch {
    console.warn('[35xw] /priv: could not deliver the result anywhere');
  }
}

/**
 * /priv: set up the roles in one go, after a preview and a confirmation. Admins only.
 *   priv    no permissions of its own, opens the private category
 *   staff   can only kick people and delete messages, opens the staff categories, reads the private category and the log
 *   member  the role every member gets: written in small letters, the other roles called member removed,
 *           given to everyone
 */
module.exports = {
  adminOnly: true,
  audit: true, // leaves a line in the server log
  noCooldown: true, // the preview asks for a confirmation and a running setup blocks a second one
  buttonPrefix: 'priv:',
  data: new SlashCommandBuilder()
    .setName('priv')
    .setDescription('Set up the priv, staff and member roles in one go (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let plan;
    try {
      plan = await ctx.priv.plan(interaction.guild);
    } catch (err) {
      console.error('[35xw] /priv plan failed:', err);
      return deny(interaction, `I could not read the server: ${err.message}`);
    }
    if (plan.problems.length) return deny(interaction, plan.problems.join(' '));
    if (!plan.priv && !plan.staff && plan.member.skip) {
      return say(interaction, `Nothing to do here. ${plan.member.skip}`, 'warn');
    }

    const token = ctx.priv.createPending(interaction.user.id, interaction.guildId, plan);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`priv:go:${token}`).setLabel('Run').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`priv:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return ephemeral(interaction, { embeds: [previewCard(plan)], components: [row] });
  },

  async handleButton(interaction, ctx) {
    if (!isAdminOrAbove(interaction, ctx.isManager)) return deny(interaction, 'Only admins can use /priv.');
    const [, action, token] = interaction.customId.split(':');
    if (action === 'no') {
      ctx.priv.dropPending(token);
      return interaction.update({ embeds: [card({ title: 'Cancelled', description: 'Nothing was changed.', footer: 'priv' })], components: [] });
    }
    if (action !== 'go') return undefined;

    const plan = ctx.priv.takePending(token, { guildId: interaction.guildId, userId: interaction.user.id });
    if (!plan) {
      return interaction.update({
        embeds: [card({ title: 'Preview expired', description: 'Run /priv again to see the current state.', tone: 'warn', footer: 'priv' })],
        components: [],
      });
    }
    await interaction.update({ embeds: [card({ title: 'Setting up the roles', description: 'Working. Do not stop the bot.', tone: 'warn', footer: 'priv' })], components: [] });

    let last = 0;
    let editable = true;
    const onProgress = async ({ done, total }) => {
      if (!editable || Date.now() - last < 4000) return;
      last = Date.now();
      try {
        await interaction.editReply({ embeds: [card({ title: 'Giving the member role', description: `${num(done)} of ${num(total)} done. Do not stop the bot.`, tone: 'warn', footer: 'priv' })] });
      } catch {
        editable = false;
      }
    };

    const guild = interaction.guild;
    const release = ctx.logs ? ctx.logs.hold(guild.id) : () => {}; // one line instead of a line per member
    let res;
    try {
      res = await ctx.priv.execute(guild, plan, interaction.user, { onProgress });
    } catch (err) {
      console.error('[35xw] /priv failed:', err);
      res = { ok: false, reason: 'error', error: err.message };
    } finally {
      release();
    }

    if (!res.ok) {
      const text = res.reason === 'busy' ? 'Another /priv is still running.' : res.reason === 'problems' ? res.problems.join(' ') : `Something went wrong: ${res.error}. Check the roles, then run /priv again.`;
      return deliver(interaction, card({ title: 'Priv setup did not finish', description: text, tone: 'danger', footer: 'priv' }));
    }
    const embed = resultCard(res);
    if (ctx.logs) ctx.logs.post(guild, card({ title: 'Roles set up with /priv', description: `${mention.user(interaction.user.id)} ran /priv.`, fields: embed.data.fields || [], tone: embed.data.color === 0x3ba55d ? 'ok' : 'warn', footer: 'logs', timestamp: true }));
    return deliver(interaction, embed);
  },

  _previewCard: previewCard,
  _resultCard: resultCard,
};
