'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, field, ephemeral, deny, mention, truncate } = require('../ui');

/** /ban: ban a member (or a user id that already left) and keep the reason in the audit log. Admins only. */
module.exports = {
  adminOnly: true,
  audit: true, // leaves a line in the server log
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member and record the reason (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) => opt.setName('user').setDescription('Who to ban').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Why they are banned, shown in the audit log').setRequired(false).setMaxLength(400),
    ),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    const user = interaction.options.getUser('user', true);
    const reason = (interaction.options.getString('reason') || '').trim();
    const refuse = (text) => {
      ctx.refundCooldown();
      return deny(interaction, text);
    };

    if (user.id === interaction.user.id) return refuse('You cannot ban yourself.');
    if (user.id === interaction.client.user.id) return refuse('I will not ban myself.');
    if (user.id === guild.ownerId || ctx.isManager(user)) return refuse('That person cannot be banned.');

    const me = guild.members.me;
    if (!me || !me.permissions.has(PermissionFlagsBits.BanMembers)) return refuse('I need the Ban Members permission.');

    // Someone who is still on the server must sit below both the admin and the bot in the role list.
    const member = interaction.options.getMember('user') || (await guild.members.fetch(user.id).catch(() => null));
    if (member) {
      const above = ctx.isOwnerOrManager() || interaction.member.roles.highest.position > member.roles.highest.position;
      if (!above) return refuse('Their highest role is not below yours.');
      if (!member.bannable) return refuse('I cannot ban them. My role has to be above theirs.');
    }

    // The audit log names the bot as the one who banned, so the admin goes into the reason.
    const note = `${interaction.user.tag || interaction.user.username} (${interaction.user.id}): ${reason || 'No reason given'}`;
    try {
      await guild.members.ban(user.id, { reason: truncate(note, 512) });
    } catch (err) {
      ctx.refundCooldown();
      return deny(interaction, `Could not ban them: ${err.message}`);
    }

    return ephemeral(interaction, {
      embeds: [
        card({
          title: 'Member banned',
          description: `${mention.user(user.id)} was banned.`,
          fields: [field('Reason', reason || 'No reason given')],
          tone: 'ok',
          footer: 'ban',
        }),
      ],
    });
  },
};
