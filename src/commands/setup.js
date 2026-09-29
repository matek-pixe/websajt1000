'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
} = require('discord.js');
const { card, field, ephemeral, deny, say, lines, joinList, plural, mention, truncate, COPY } = require('../ui');

const tick = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const names = (items) => items.map((i) => tick(i.name));

/** The review card shown before anything is touched. */
function previewCard(plan) {
  const channels = plan.remove.filter((c) => !c.category);
  const categories = plan.remove.filter((c) => c.category);
  const r = plan.roles;

  const kept = [
    ...plan.keepCategories.map((c) => `Category ${tick(c.name)}, with everything inside it`),
    plan.ticketCategory ? `Category ${tick(plan.ticketCategory.name)}, with open tickets and transcripts` : null,
    `${plural(plan.keptChannels.length, 'channel')} inside kept categories`,
    r.kept.length ? `Roles: ${joinList(r.kept.map((x) => tick(x.name)), { max: 12, limit: 700 })}` : null,
  ].filter(Boolean);

  const removed = [
    channels.length || categories.length
      ? `${plural(channels.length, 'channel')} and ${plural(categories.length, 'category', 'categories')}: ${joinList(names([...channels, ...categories]), { max: 14, limit: 700 })}`
      : 'No channels',
    plan.opts.deleteRoles
      ? r.remove.length
        ? `${plural(r.remove.length, 'role')}: ${joinList(names(r.remove), { max: 14, limit: 500 })}`
        : 'No roles'
      : 'Roles are left alone',
  ];

  const layout = plan.create;
  const fresh = layout.categories.filter((c) => !c.managed);
  const total = fresh.reduce((n, c) => n + c.channels.length, layout.top.length);
  const built = [
    `${plural(total, 'channel')} in ${plural(fresh.length, 'category', 'categories')}, plus ${names(layout.top).join(', ')} at the top`,
    `Categories ${names(fresh).join(', ')}`,
    r.create.length ? `New roles: ${r.create.map((x) => tick(x.name)).join(', ')}` : null,
    r.adopt.length ? `Renamed roles: ${r.adopt.map((x) => `${tick(x.name)} to ${tick(x.to)}`).join(', ')}` : null,
  ].filter(Boolean);

  const priv = plan.opts.privId ? mention.role(plan.opts.privId) : 'the co-owner role';
  const access = [
    `Verified members: ${plan.verified.id ? mention.role(plan.verified.id) : 'a new verified role'} (${plan.verified.source})`,
    `Priv channels: admins, the server owner and ${priv}`,
  ];

  const fields = [
    field('Stays as it is', truncate(lines(kept, { max: 8, limit: 1000 }), 1024)),
    field('Will be deleted', truncate(lines(removed, { max: 4, limit: 1000 }), 1024)),
    field('Will be created', truncate(lines(built, { max: 6, limit: 1000 }), 1024)),
    field('Access', lines(access)),
  ];
  if (plan.warnings.length) fields.push(field('Heads up', truncate(lines(plan.warnings, { max: 4, limit: 1000 }), 1024)));

  return card({
    title: 'Rebuild the server?',
    description: 'This replaces the current layout with the 35xw template. Only what is listed under Will be deleted is removed, and nothing changes until you press the button.',
    fields,
    tone: 'warn',
    footer: 'setup',
  });
}

const progressCard = (step) =>
  card({ title: 'Rebuilding the server', description: `Now: **${step}**. This takes a minute or two, so leave it running.`, footer: 'setup' });

function summaryCard(report) {
  const bad = report.failed.length > 0;
  return card({
    title: bad ? 'Server rebuilt with problems' : 'Server rebuilt',
    description: `Created ${report.created.length}, updated ${report.updated.length}, deleted ${report.deleted.length}, kept ${report.kept.length}.`,
    fields: [
      report.created.length ? field('Created', lines(report.created, { max: 12 })) : null,
      report.updated.length ? field('Updated', lines(report.updated, { max: 8 })) : null,
      report.failed.length ? field('Problems', lines(report.failed, { max: 8 })) : null,
      report.warnings.length ? field('Heads up', lines(report.warnings, { max: 5 })) : null,
    ].filter(Boolean),
    tone: bad ? 'warn' : 'ok',
    footer: 'setup',
  });
}

function failureCard(res) {
  let text = COPY.failed;
  if (res.reason === 'in_progress') text = 'A rebuild is already running on this server.';
  else if (res.reason === 'keep_missing') text = `The category ${tick(res.name)} is gone. Run /setup server again to see the new state.`;
  else if (res.reason === 'build_failed') {
    text = `Building stopped. The channels created so far were removed again and nothing old was deleted. ${res.message || ''}`.trim();
  }
  return card({ title: 'Nothing was deleted', description: text, tone: 'danger', footer: 'setup' });
}

/** Show the final result; if the channel the command ran in is gone, fall back to a direct message. */
async function deliver(interaction, embed) {
  try {
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  } catch {
    /* the channel may have been deleted by the rebuild itself */
  }
  try {
    await interaction.user.send({ embeds: [embed] });
  } catch (err) {
    console.warn(`[35xw] /setup server: could not deliver the summary: ${err.message}`);
  }
}

/**
 * /setup server: rebuild the server layout. Owner only. It shows a preview first; the button
 * starts the work. New things are built before anything old is deleted.
 */
module.exports = {
  managerOnly: false,
  ownerOnly: true,
  noCooldown: true, // the preview asks for a confirmation and a running rebuild blocks a second one
  buttonPrefix: 'setup:',
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Server setup tools (owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('server')
        .setDescription('Rebuild the server layout and roles (owner only)')
        .addRoleOption((o) => o.setName('verified').setDescription('The role members get after their ticket (default: the + role)').setRequired(false))
        .addRoleOption((o) => o.setName('priv_role').setDescription('Role allowed into the priv channels besides admins').setRequired(false))
        .addChannelOption((o) =>
          o
            .setName('keep')
            .setDescription('An extra category to keep untouched')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        )
        .addBooleanOption((o) => o.setName('delete_roles').setDescription('Delete roles that are not part of the template (default: yes)').setRequired(false)),
    ),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    if (guild.ownerId !== interaction.user.id && !ctx.isManager(interaction.user)) {
      return deny(interaction, COPY.ownerOnly('setup'));
    }
    if (interaction.options.getSubcommand() !== 'server') return undefined;
    if (ctx.setup.isRunning(guild.id)) return deny(interaction, 'A rebuild is already running on this server.');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const res = await ctx.setup.preview(guild, {
      verified: interaction.options.getRole('verified'),
      priv: interaction.options.getRole('priv_role'),
      keep: interaction.options.getChannel('keep'),
      deleteRoles: interaction.options.getBoolean('delete_roles') !== false,
    });
    if (!res.ok) {
      return ephemeral(interaction, {
        embeds: [card({ title: 'Cannot rebuild yet', description: lines(res.problems), tone: 'danger', footer: 'setup' })],
      });
    }

    const token = ctx.setup.createPending(res.plan, interaction.user.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup:go:${token}`).setLabel('Rebuild server').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`setup:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return ephemeral(interaction, { embeds: [previewCard(res.plan)], components: [row] });
  },

  async handleButton(interaction, ctx) {
    if (!ctx.isOwnerOrManager()) return deny(interaction, COPY.ownerOnly('setup'));

    const [, action, token] = interaction.customId.split(':');
    if (action === 'no') {
      ctx.setup.dropPending(token);
      return interaction.update({
        embeds: [card({ title: 'Cancelled', description: 'Nothing was changed.', footer: 'setup' })],
        components: [],
      });
    }
    if (action !== 'go') return undefined;

    const plan = ctx.setup.takePending(token, { guildId: interaction.guildId, userId: interaction.user.id });
    if (!plan) {
      return interaction.update({
        embeds: [card({ title: 'Preview expired', description: 'Run /setup server again to see the current state.', tone: 'warn', footer: 'setup' })],
        components: [],
      });
    }
    if (ctx.setup.isRunning(interaction.guildId)) {
      return interaction.update({ embeds: [failureCard({ reason: 'in_progress' })], components: [] });
    }

    await interaction.update({ embeds: [progressCard('Starting')], components: [] });

    // Progress edits are best effort: the channel this ran in may be deleted along the way.
    let editable = true;
    let last = 0;
    const onProgress = async (step) => {
      if (!editable || Date.now() - last < 1000) return;
      last = Date.now();
      try {
        await interaction.editReply({ embeds: [progressCard(step)] });
      } catch {
        editable = false;
      }
    };

    let res;
    try {
      res = await ctx.setup.execute(interaction.guild, plan, { onProgress });
    } catch (err) {
      console.error('[35xw] /setup server failed:', err);
      res = { ok: false, reason: 'error' };
    }
    return deliver(interaction, res.ok ? summaryCard(res.report) : failureCard(res));
  },

  _previewCard: previewCard,
  _summaryCard: summaryCard,
};
