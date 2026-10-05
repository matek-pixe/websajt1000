'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { card, field, ephemeral, deny, mention, truncate } = require('../ui');

/**
 * /sos ban: ban a member (or a user id that already left) and keep the reason in the audit log.
 * The reply is already deferred.
 */
async function banMember(interaction, ctx) {
  const guild = interaction.guild;
  const user = interaction.options.getUser('user', true);
  const reason = (interaction.options.getString('reason') || '').trim();

  if (user.id === interaction.user.id) return deny(interaction, 'You cannot ban yourself.');
  if (user.id === interaction.client.user.id) return deny(interaction, 'I will not ban myself.');
  if (user.id === guild.ownerId || ctx.isManager(user)) return deny(interaction, 'That person cannot be banned.');

  const me = guild.members.me;
  if (!me || !me.permissions.has(PermissionFlagsBits.BanMembers)) return deny(interaction, 'I need the Ban Members permission.');

  // Someone who is still on the server must sit below both the admin and the bot in the role list.
  const member = interaction.options.getMember('user') || (await guild.members.fetch(user.id).catch(() => null));
  if (member) {
    const above = ctx.isOwnerOrManager() || interaction.member.roles.highest.position > member.roles.highest.position;
    if (!above) return deny(interaction, 'Their highest role is not below yours.');
    if (!member.bannable) return deny(interaction, 'I cannot ban them. My role has to be above theirs.');
  }

  // The audit log names the bot as the one who banned, so the admin goes into the reason.
  const note = `${interaction.user.tag || interaction.user.username} (${interaction.user.id}): ${reason || 'No reason given'}`;
  try {
    await guild.members.ban(user.id, { reason: truncate(note, 512) });
  } catch (err) {
    return deny(interaction, `Could not ban them: ${err.message}`);
  }

  return ephemeral(interaction, {
    embeds: [
      card({
        title: 'Member banned',
        description: `${mention.user(user.id)} was banned.`,
        fields: [field('Reason', reason || 'No reason given')],
        tone: 'ok',
        footer: 'sos',
      }),
    ],
  });
}

module.exports = { banMember };
