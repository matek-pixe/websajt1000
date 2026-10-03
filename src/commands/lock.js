'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { card, deny, ephemeral } = require('../ui');

/** Channel types that have their own permissions and a text chat. Threads inherit from their channel. */
const LOCKABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** What a failed write means in plain words. */
function why(res) {
  if (res.code === 50013 || res.code === 50001) return 'I cannot change permissions here. Give me Manage Roles (Manage Permissions) for this channel.';
  return `Discord refused the change: ${res.error}`;
}

/** Post the public card, or fall back to the private reply if the bot cannot post in the channel. */
async function announce(interaction, embed) {
  try {
    await interaction.channel.send({ embeds: [embed] });
    await interaction.deleteReply().catch(() => {});
  } catch {
    await ephemeral(interaction, { embeds: [embed] });
  }
}

/**
 * /lock: only admins and the server owner can write in this channel until /unlock. The channel is saved
 * first, so /unlock puts back exactly what was there. Admins only.
 */
module.exports = {
  adminOnly: true,
  audit: true, // leaves a line in the server log
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Lock this channel so only admins and the owner can write (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, ctx) {
    const channel = interaction.channel;
    if (!channel || !LOCKABLE.has(channel.type)) {
      ctx.refundCooldown();
      return deny(interaction, 'Run /lock in a normal channel, not in a thread.');
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const me = interaction.guild.members.me;
    let res;
    try {
      res = await ctx.lockdown.lockChannel(interaction.guild, channel.id, interaction.user.id, { botId: me.id, botIsAdmin: me.permissions.has(PermissionFlagsBits.Administrator) });
    } catch (err) {
      console.error('[35xw] /lock failed:', err);
      res = { ok: false, reason: 'failed', error: err.message, code: err.code };
    }

    if (!res.ok) {
      ctx.refundCooldown();
      const text =
        res.reason === 'sos' ? 'SOS is on. Run /sos end first.' : res.reason === 'already' ? 'This channel is already locked. Use /unlock to open it again.' : why(res);
      return ephemeral(interaction, { embeds: [card({ description: text, tone: res.reason === 'failed' ? 'danger' : 'warn', footer: false })] });
    }
    return announce(
      interaction,
      card({ title: 'Channel locked', description: 'Only admins and the server owner can write here.', tone: 'danger', footer: 'lock' }),
    );
  },

  announce,
  why,
  LOCKABLE,
};
