'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS } = require('./_shared');

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
 * /f — give (or remove) a role for every member of the server. Admin only.
 */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('f')
    .setDescription('ADMIN: give a role to every member of the server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((opt) => opt.setName('role').setDescription('The role to give everyone.').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('action')
        .setDescription('Give (default) or remove the role from everyone.')
        .setRequired(false)
        .addChoices({ name: 'Give', value: 'give' }, { name: 'Remove', value: 'remove' }),
    )
    .addBooleanOption((opt) =>
      opt.setName('bots').setDescription('Also apply it to bots (default: no).').setRequired(false),
    ),

  async execute(interaction, ctx) {
    if (!canUse(interaction, ctx)) {
      ctx.refundCooldown();
      return interaction.reply({ content: '⛔ Only administrators can use `/f`.', flags: MessageFlags.Ephemeral });
    }

    const guild = interaction.guild;
    const role = interaction.options.getRole('role', true);
    const action = interaction.options.getString('action') || 'give';
    const bots = interaction.options.getBoolean('bots') || false;

    // Validate that the bot can actually assign this role.
    const me = guild.members.me;
    let problem = null;
    if (role.id === guild.id) problem = 'You cannot give `@everyone` as a role.';
    else if (role.managed) problem = 'That role is managed by an integration/bot and cannot be assigned by hand.';
    else if (me && me.permissions && !me.permissions.has(PermissionFlagsBits.ManageRoles))
      problem = 'I need the **Manage Roles** permission to do that.';
    else if (me && me.roles && me.roles.highest && role.position >= me.roles.highest.position)
      problem = `My role must be **above** <@&${role.id}>. Move my role higher in Server Settings → Roles and try again.`;
    if (problem) {
      ctx.refundCooldown();
      return interaction.reply({ content: `❌ ${problem}`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const members = await guild.members.fetch();
    const targets = pickTargets(members, { bots });
    const verb = action === 'remove' ? 'Removing' : 'Giving';

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
          .editReply({ content: `⏳ ${verb} <@&${role.id}>… ${changed + skipped + failed}/${targets.length}` })
          .catch(() => {});
      }
    }

    const embed = new EmbedBuilder()
      .setColor(failed > 0 ? COLORS.warn : COLORS.ok)
      .setTitle(action === 'remove' ? '✅ Role removed from everyone' : '✅ Role given to everyone')
      .setDescription(`<@&${role.id}> • ${targets.length} member${targets.length === 1 ? '' : 's'}${bots ? ' (bots included)' : ' (bots skipped)'}`)
      .addFields(
        { name: action === 'remove' ? 'Removed' : 'Given', value: String(changed), inline: true },
        { name: action === 'remove' ? 'Did not have it' : 'Already had it', value: String(skipped), inline: true },
        { name: 'Failed', value: String(failed), inline: true },
      )
      .setFooter({ text: `35xw • /f by ${interaction.user.username}` })
      .setTimestamp();
    if (failures.length) embed.addFields({ name: 'Errors (first few)', value: failures.join('\n').slice(0, 1024) });

    return interaction.editReply({ content: '', embeds: [embed] });
  },

  // exported for tests
  _canUse: canUse,
  _pickTargets: pickTargets,
  _needsChange: needsChange,
};
