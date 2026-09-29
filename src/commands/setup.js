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

/** The review card shown before anything is touched. Every field is capped so the whole card stays under Discord's 6000 characters. */
function previewCard(plan) {
  const channels = plan.remove.filter((c) => !c.category);
  const categories = plan.remove.filter((c) => c.category);
  const r = plan.roles;

  const kept = [
    ...plan.keepCategories.map((c) => `Category ${tick(c.name)}, with everything inside it`),
    plan.ticketCategory ? `Category ${tick(plan.ticketCategory.name)}, with open tickets and transcripts` : null,
    `${plural(plan.keptChannels.length, 'channel')} inside kept categories`,
    r.kept.length ? `Roles: ${joinList(r.kept.map((x) => tick(x.name)), { max: 12, limit: 450 })}` : null,
  ].filter(Boolean);

  const layout = plan.create;
  const fresh = layout.categories.filter((c) => !c.managed);
  const total = fresh.reduce((n, c) => n + c.channels.length, layout.top.length);
  const built = [
    `${plural(total, 'channel')} in ${plural(fresh.length, 'category', 'categories')}, plus ${names(layout.top).join(', ')} at the top`,
    `Categories ${names(fresh).join(', ')}`,
    plan.ticketCategory ? null : 'Category `🎫 Tickets` with `transcripts`, which the ticket system needs',
    r.create.length ? `New roles: ${r.create.map((x) => tick(x.name)).join(', ')}` : null,
    r.adopt.length ? `Renamed roles: ${r.adopt.map((x) => `${tick(x.name)} to ${tick(x.to)}`).join(', ')}` : null,
  ].filter(Boolean);

  const admins = plan.priv.filter((x) => x.why === 'admin role');
  const above = plan.priv.filter((x) => x.why !== 'admin role');
  const access = [
    `Verified members: ${plan.verified.id ? mention.role(plan.verified.id) : 'a new verified role'} (${plan.verified.source})`,
    `Priv channels: the server owner, ${admins.length ? `admin roles ${joinList(admins.map((x) => mention.role(x.id)), { max: 5 })}` : 'no admin roles found'}, ${above.length ? `the roles above them ${joinList(above.map((x) => mention.role(x.id)), { max: 5 })}, ` : ''}and the co-owner role`,
  ];

  // Categories go first and get their own field, so the owner can always check them.
  const fields = [
    field('Stays as it is', truncate(lines(kept, { max: 8, limit: 700 }), 700)),
    field(`Categories deleted (${categories.length})`, categories.length ? joinList(names(categories), { max: 12, limit: 500 }) : 'None'),
    field(`Channels deleted (${channels.length})`, channels.length ? joinList(names(channels), { max: 16, limit: 800 }) : 'None'),
    field(`Roles deleted (${plan.opts.deleteRoles ? r.remove.length : 0})`, plan.opts.deleteRoles ? (r.remove.length ? joinList(names(r.remove), { max: 12, limit: 500 }) : 'None') : 'Roles are left alone'),
    field('Will be created', truncate(lines(built, { max: 6, limit: 800 }), 800)),
    field('Access', truncate(lines(access), 500)),
  ];
  if (plan.warnings.length) fields.push(field('Heads up', truncate(lines(plan.warnings, { max: 4, limit: 500 }), 500)));

  return card({
    title: 'Rebuild the server?',
    description:
      'This replaces the current layout with the 35xw template. Only what is listed under deleted is removed, and nothing changes until you press the button. ' +
      'The result is shown here, or sent to you in a direct message if this channel is deleted.',
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
      report.invite ? field('New invite', report.invite) : null,
      report.warnings.length ? field('Heads up', lines(report.warnings, { max: 5 })) : null,
    ].filter(Boolean),
    tone: bad ? 'warn' : 'ok',
    footer: 'setup',
  });
}

function failureCard(res) {
  const r = res.report || { deleted: [], created: [], failed: [] };
  const tail = (left) => {
    const bits = [];
    if (left && left.channels.length) bits.push(`These new channels could not be removed again: ${joinList(left.channels.map(tick), { max: 8, limit: 400 })}.`);
    if (left && left.roles.length) bits.push(`Roles: ${joinList(left.roles, { max: 5, limit: 300 })}.`);
    return bits.length ? ` ${bits.join(' ')}` : '';
  };
  switch (res.reason) {
    case 'in_progress':
      return card({ title: 'Already running', description: 'A rebuild is already running on this server.', tone: 'warn', footer: 'setup' });
    case 'stale':
      return card({ title: 'Preview expired', description: 'The server was rebuilt since this preview. Run /setup server again to see the current state.', tone: 'warn', footer: 'setup' });
    case 'keep_missing':
      return card({ title: 'Nothing was deleted', description: `The category ${tick(res.name)} is gone. Run /setup server again to see the new state.`, tone: 'danger', footer: 'setup' });
    case 'verified_missing':
      return card({ title: 'Nothing was deleted', description: 'The verified role no longer exists. Run /setup server again and pick it with the verified option.', tone: 'danger', footer: 'setup' });
    case 'roles_failed':
      return card({ title: 'Nothing was deleted', description: `${res.message} Roles created or renamed for this run were reverted.${tail(res.left)}`, tone: 'danger', footer: 'setup' });
    case 'build_failed':
      return card({
        title: 'Nothing was deleted',
        description: `Building the new layout failed, so the old one is still in place. ${res.message || ''}${tail(res.left)} Roles created or renamed for this run were reverted.`.replace(/\s+/g, ' ').trim(),
        tone: 'danger',
        footer: 'setup',
      });
    case 'partial':
      return card({
        title: 'Rebuild stopped part way',
        description: `The new layout is built, but the rebuild stopped before it finished: ${res.message || 'unknown error'}. ${plural(r.deleted.length, 'old item')} were deleted. Check the server before running it again.`,
        fields: r.failed.length ? [field('Problems', lines(r.failed, { max: 8 }))] : [],
        tone: 'danger',
        footer: 'setup',
      });
    default:
      return card({ title: 'Rebuild failed', description: 'Something went wrong. Check the server before running the rebuild again.', tone: 'danger', footer: 'setup' });
  }
}

/**
 * Show the final result. The channel this ran in is usually deleted by the rebuild, so the order is:
 * the original reply, a direct message, then a channel of the new layout that the owner can see.
 */
async function deliver(interaction, embed, fallbackChannelId) {
  try {
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  } catch {
    /* the channel may have been deleted by the rebuild itself */
  }
  try {
    await interaction.user.send({ content: `Result of /setup server on **${interaction.guild.name}**`, embeds: [embed] });
    return;
  } catch {
    /* direct messages may be closed */
  }
  try {
    const channel = fallbackChannelId && interaction.guild.channels.cache.get(fallbackChannelId);
    if (channel) {
      await channel.send({ content: mention.user(interaction.user.id), embeds: [embed], allowedMentions: { users: [interaction.user.id] } });
      return;
    }
  } catch {
    /* nothing else to try */
  }
  console.warn('[35xw] /setup server: could not deliver the result anywhere');
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

    // A second press while the first one is starting or running must not touch the progress card.
    if (ctx.setup.isRunning(interaction.guildId) || ctx.setup.wasStarted(token)) {
      return say(interaction, 'This rebuild has already started.', 'warn');
    }
    const plan = ctx.setup.takePending(token, { guildId: interaction.guildId, userId: interaction.user.id });
    if (!plan) {
      return interaction.update({
        embeds: [card({ title: 'Preview expired', description: 'Run /setup server again to see the current state.', tone: 'warn', footer: 'setup' })],
        components: [],
      });
    }

    await interaction.update({ embeds: [progressCard('Starting')], components: [] });

    // Progress edits are best effort: the channel this ran in may be deleted along the way.
    let editable = true;
    const onProgress = async (step) => {
      if (!editable) return;
      try {
        await interaction.editReply({ embeds: [progressCard(step)] });
      } catch {
        editable = false;
      }
    };

    // One summary in the server log instead of a line for every channel and role the rebuild touches.
    const release = ctx.logs ? ctx.logs.hold(interaction.guildId) : () => {};
    let res;
    try {
      res = await ctx.setup.execute(interaction.guild, plan, { onProgress });
    } catch (err) {
      console.error('[35xw] /setup server failed:', err);
      res = { ok: false, reason: 'error' };
    } finally {
      release();
    }
    if (ctx.logs) {
      const rep = res.report;
      ctx.logs.post(
        interaction.guild,
        card({
          title: res.ok ? 'Server rebuilt' : 'Server rebuild did not finish',
          fields: [
            field('By', `${mention.user(interaction.user.id)} \`${interaction.user.id}\``, true),
            ...(rep ? [field('Created', String(rep.created.length), true), field('Deleted', String(rep.deleted.length), true)] : []),
            ...(res.ok ? [] : [field('Reason', String(res.reason))]),
          ],
          tone: res.ok ? 'warn' : 'danger',
          footer: 'logs',
          timestamp: true,
        }),
      );
    }
    return deliver(interaction, res.ok ? summaryCard(res.report) : failureCard(res), res.fallbackChannelId);
  },

  _previewCard: previewCard,
  _summaryCard: summaryCard,
  _failureCard: failureCard,
};
