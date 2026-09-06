'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS } = require('./_shared');

/** Manager, admins, or anyone with Manage Server / Manage Roles. */
function canUse(interaction, ctx) {
  if (ctx.isManager(interaction.user)) return true;
  const m = interaction.member;
  if (!m || !m.permissions || typeof m.permissions.has !== 'function') return false;
  return (
    m.permissions.has(PermissionFlagsBits.Administrator) ||
    m.permissions.has(PermissionFlagsBits.ManageGuild) ||
    m.permissions.has(PermissionFlagsBits.ManageRoles)
  );
}

const list = (guild, ids) =>
  (ids.map((id) => (guild.roles.cache.has(id) ? `<@&${id}>` : `\`${id}\``)).join(', ') || '—').slice(0, 1024);

/**
 * /roles — show what the bot remembers for a user, and whether it can restore it.
 * Works for people who already left: paste their Discord ID.
 */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('roles')
    .setDescription('STAFF: show the roles the bot remembers for a user (works even after they left).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((opt) => opt.setName('user').setDescription('Pick a member.').setRequired(false))
    .addStringOption((opt) =>
      opt.setName('id').setDescription('Or paste a Discord user ID (for someone who already left).').setRequired(false),
    ),

  async execute(interaction, ctx) {
    if (!canUse(interaction, ctx)) {
      ctx.refundCooldown();
      return interaction.reply({ content: '⛔ Only staff can use `/roles`.', flags: MessageFlags.Ephemeral });
    }
    const user = interaction.options.getUser('user');
    const idOpt = (interaction.options.getString('id') || '').trim();
    const userId = user ? user.id : idOpt;
    if (!/^\d{15,22}$/.test(userId || '')) {
      ctx.refundCooldown();
      return interaction.reply({ content: 'Pick a **user** or paste a valid Discord **user ID**.', flags: MessageFlags.Ephemeral });
    }

    const guild = interaction.guild;
    const entry = ctx.roleMemory.getEntry(guild.id, userId);
    const inServer = guild.members.cache.has(userId) || !!(await guild.members.fetch(userId).catch(() => null));

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('🧠 Remembered roles')
      .setDescription(
        `<@${userId}>${entry && entry.username ? ` (${entry.username})` : ''} • ${inServer ? '🟢 in the server' : '⚪ not in the server'}`,
      );

    if (!entry) {
      embed.setColor(COLORS.warn).addFields({ name: 'Roles', value: '_Nothing remembered for this user yet._' });
    } else if (entry.roles.length === 0) {
      embed.addFields({ name: 'Roles', value: '_No roles remembered (they had none)._' });
    } else {
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      const cls = ctx.roleMemory.classifyRemembered(guild, entry.roles, me);
      embed.addFields({ name: `✅ Will be restored on return (${cls.ok.length})`, value: list(guild, cls.ok) });
      if (cls.aboveBot.length) {
        embed.setColor(COLORS.warn).addFields({
          name: `⚠️ Above my role, cannot restore (${cls.aboveBot.length})`,
          value: `${list(guild, cls.aboveBot)}\nMove my role higher in **Server Settings → Roles**.`,
        });
      }
      if (cls.managed.length) embed.addFields({ name: `🤖 Managed by an integration (${cls.managed.length})`, value: list(guild, cls.managed) });
      if (cls.missing.length) embed.addFields({ name: `🗑️ Deleted roles (${cls.missing.length})`, value: list(guild, cls.missing) });
    }
    if (entry && entry.updatedAt) {
      const ts = Math.floor(new Date(entry.updatedAt).getTime() / 1000);
      if (Number.isFinite(ts)) embed.addFields({ name: '🕒 Last saved', value: `<t:${ts}:R>` });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },

  _canUse: canUse,
};
