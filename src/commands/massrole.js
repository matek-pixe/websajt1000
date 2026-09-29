'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { card, field, deny, mention, num, lines, COPY } = require('../ui');

/** Admins (Administrator permission), the server owner and the bot manager may use /f. */
function canUse(interaction, ctx) {
  if (ctx.isManager(interaction.user)) return true;
  if (interaction.guild && interaction.guild.ownerId === interaction.user.id) return true;
  const m = interaction.member;
  return !!(m && m.permissions && typeof m.permissions.has === 'function' && m.permissions.has(PermissionFlagsBits.Administrator));
}

/** Members the action applies to: everyone, bots only when asked. */
function pickTargets(members, { bots = false } = {}) {
  return [...members.values()].filter((m) => bots || !(m.user && m.user.bot));
}

/** Does this member need the action at all? (give -> lacks role, remove -> has role) */
function needsChange(member, roleId, action) {
  const has = member.roles.cache.has(roleId);
  return action === 'remove' ? has : !has;
}

/**
 * /f: give (or remove) a role for every member of the server. Admins only.
 */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('f')
    .setDescription('Give or remove a role for every member (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((opt) => opt.setName('role').setDescription('Role to give or remove').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('action')
        .setDescription('Give the role or remove it, default is give')
        .setRequired(false)
        .addChoices({ name: 'Give', value: 'give' }, { name: 'Remove', value: 'remove' }),
    )
    .addBooleanOption((opt) =>
      opt.setName('bots').setDescription('Include bots, default is no').setRequired(false),
    ),

  async execute(interaction, ctx) {
    if (!canUse(interaction, ctx)) {
      ctx.refundCooldown();
      return deny(interaction, COPY.adminOnly('f'));
    }

    const guild = interaction.guild;
    const role = interaction.options.getRole('role', true);
    const action = interaction.options.getString('action') || 'give';
    const bots = interaction.options.getBoolean('bots') || false;

    // Validate that the bot can actually assign this role.
    const me = guild.members.me;
    let problem = null;
    if (role.id === guild.id) problem = '@everyone cannot be given or removed. Pick another role.';
    else if (role.managed) problem = 'That role is managed by an integration or bot and cannot be given by hand. Pick a regular role.';
    else if (me && me.permissions && !me.permissions.has(PermissionFlagsBits.ManageRoles))
      problem = 'The bot is missing the Manage Roles permission. Grant it in Server Settings, Roles, then run /f again.';
    else if (me && me.roles && me.roles.highest && role.position >= me.roles.highest.position)
      problem = `The bot role sits below ${mention.role(role.id)}. Drag the bot role above that role in Server Settings, Roles, then run /f again.`;
    if (problem) {
      ctx.refundCooldown();
      return deny(interaction, problem);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const members = await guild.members.fetch();
    const targets = pickTargets(members, { bots });
    const working = action === 'remove' ? `Removing ${mention.role(role.id)} from members` : `Giving ${mention.role(role.id)} to members`;

    let changed = 0;
    let skipped = 0;
    let failed = 0;
    const failures = [];
    let lastEdit = Date.now();

    for (const member of targets) {
      if (!needsChange(member, role.id, action)) {
        skipped += 1;
        continue;
      }
      try {
        if (action === 'remove') await member.roles.remove(role.id, `/f by ${interaction.user.tag}`);
        else await member.roles.add(role.id, `/f by ${interaction.user.tag}`);
        changed += 1;
      } catch (err) {
        failed += 1;
        if (failures.length < 5) failures.push(`${member.user ? member.user.tag : member.id}: ${err.message}`);
      }
      // Keep the admin posted on big servers (Discord rate-limits role changes).
      if (Date.now() - lastEdit > 3000) {
        lastEdit = Date.now();
        await interaction
          .editReply({
            embeds: [card({ description: `${working}. ${num(changed + skipped + failed)} of ${num(targets.length)} done.`, footer: 'roles' })],
          })
          .catch(() => {});
      }
    }

    const removing = action === 'remove';
    const embed = card({
      title: removing ? 'Role removed from everyone' : 'Role given to everyone',
      description: `Checked ${num(targets.length)} ${targets.length === 1 ? 'member' : 'members'} for ${mention.role(role.id)}. Bots ${bots ? 'included' : 'skipped'}.`,
      fields: [
        field(removing ? 'Removed' : 'Given', num(changed), true),
        field(removing ? 'Did not have it' : 'Already had it', num(skipped), true),
        field('Failed', num(failed), true),
        ...(failures.length ? [field('First errors', lines(failures, { max: 5, limit: 1024 }))] : []),
      ],
      tone: failed > 0 ? 'warn' : 'ok',
      footer: 'roles',
    });

    return interaction.editReply({ embeds: [embed] });
  },

  // exported for tests
  _canUse: canUse,
  _pickTargets: pickTargets,
  _needsChange: needsChange,
};
