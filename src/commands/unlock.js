'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { card, deny, ephemeral } = require('../ui');
const { announce, why, LOCKABLE } = require('./lock');

/** /unlock: put the channel back exactly as it was before /lock. Admins only. */
module.exports = {
  adminOnly: true,
  audit: true, // leaves a line in the server log
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Open a channel that was locked with /lock (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, ctx) {
    const channel = interaction.channel;
    if (!channel || !LOCKABLE.has(channel.type)) {
      ctx.refundCooldown();
      return deny(interaction, 'Run /unlock in the channel that was locked.');
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let res;
    try {
      res = await ctx.lockdown.unlockChannel(interaction.guild, channel.id, interaction.user.id);
    } catch (err) {
      console.error('[35xw] /unlock failed:', err);
      res = { ok: false, reason: 'failed', error: err.message, code: err.code };
    }

    if (!res.ok) {
      ctx.refundCooldown();
      const text =
        res.reason === 'sos'
          ? 'SOS is on. Run /sos end first.'
          : res.reason === 'not_locked'
            ? 'This channel was not locked with /lock, so there is nothing to put back.'
            : res.reason === 'gone'
              ? 'This channel no longer exists.'
              : why(res);
      return ephemeral(interaction, { embeds: [card({ description: text, tone: res.reason === 'failed' ? 'danger' : 'warn', footer: false })] });
    }
    return announce(interaction, card({ title: 'Channel unlocked', description: 'Permissions are back exactly as they were before the lock.', tone: 'ok', footer: 'lock' }));
  },
};
