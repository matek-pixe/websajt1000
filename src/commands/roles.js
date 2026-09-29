'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, field, deny, ephemeral, mention, time, joinList, COPY } = require('../ui');

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

/** Role mentions for roles that still exist, the raw id for the ones that do not. */
const list = (guild, ids) =>
  joinList(
    ids.map((id) => (guild.roles.cache.has(id) ? mention.role(id) : `\`${id}\``)),
    { max: 35, limit: 900 },
  );

/**
 * /roles: show what the bot remembers for a member, and whether it can restore it.
 * Works for people who already left: paste their Discord ID.
 */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('roles')
    .setDescription('Show the roles the bot remembers for a member (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((opt) => opt.setName('user').setDescription('Member to look up').setRequired(false))
    .addStringOption((opt) =>
      opt.setName('id').setDescription('Discord user ID, for someone who already left').setRequired(false),
    ),

  async execute(interaction, ctx) {
    if (!canUse(interaction, ctx)) {
      ctx.refundCooldown();
      return deny(interaction, COPY.staffOnly('roles'));
    }
    const user = interaction.options.getUser('user');
    const idOpt = (interaction.options.getString('id') || '').trim();
    const userId = user ? user.id : idOpt;
    if (!/^\d{15,22}$/.test(userId || '')) {
      ctx.refundCooldown();
      return deny(interaction, 'No valid member or user ID was given. Pick a member or paste a Discord user ID.');
    }

    const guild = interaction.guild;
    const entry = ctx.roleMemory.getEntry(guild.id, userId);
    const inServer = guild.members.cache.has(userId) || !!(await guild.members.fetch(userId).catch(() => null));

    const fields = [];
    let tone = 'neutral';

    if (!entry) {
      tone = 'warn';
      fields.push(field('Roles', 'Nothing remembered for this member yet.'));
    } else if (entry.roles.length === 0) {
      fields.push(field('Roles', 'No roles saved. The member had none.'));
    } else {
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      const cls = ctx.roleMemory.classifyRemembered(guild, entry.roles, me);
      fields.push(field(`Restored on return (${cls.ok.length})`, list(guild, cls.ok)));
      if (cls.aboveBot.length) {
        tone = 'warn';
        fields.push(
          field(
            `Above the bot role (${cls.aboveBot.length})`,
            `${list(guild, cls.aboveBot)}\nDrag the bot role above these roles in Server Settings, Roles.`,
          ),
        );
      }
      if (cls.managed.length) fields.push(field(`Managed by an integration (${cls.managed.length})`, list(guild, cls.managed)));
      if (cls.missing.length) fields.push(field(`Deleted roles (${cls.missing.length})`, list(guild, cls.missing)));
    }
    if (entry && entry.updatedAt) {
      const ms = new Date(entry.updatedAt).getTime();
      if (Number.isFinite(ms)) fields.push(field('Last saved', time(ms)));
    }

    const who = `${mention.user(userId)}${entry && entry.username ? ` (${entry.username})` : ''}`;
    const embed = card({
      title: 'Remembered roles',
      description: `${who}\n${inServer ? 'In the server.' : 'Not in the server.'}`,
      fields,
      tone,
      footer: 'roles',
    });

    await ephemeral(interaction, { embeds: [embed] });
  },

  _canUse: canUse,
};
