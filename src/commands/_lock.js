'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
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
 * /sos lock: only admins and the server owner can write in this channel until /sos unlock. The channel is
 * saved first, so unlock puts back exactly what was there. The reply is already deferred.
 */
async function lockHere(interaction, ctx) {
  const channel = interaction.channel;
  if (!channel || !LOCKABLE.has(channel.type)) return deny(interaction, 'Run /sos lock in a normal channel, not in a thread.');

  const me = interaction.guild.members.me;
  let res;
  try {
    res = await ctx.lockdown.lockChannel(interaction.guild, channel.id, interaction.user.id, { botId: me.id, botIsAdmin: me.permissions.has(PermissionFlagsBits.Administrator) });
  } catch (err) {
    console.error('[35xw] /sos lock failed:', err);
    res = { ok: false, reason: 'failed', error: err.message, code: err.code };
  }

  if (!res.ok) {
    const text =
      res.reason === 'sos' ? 'SOS is on. Run /sos end first.' : res.reason === 'already' ? 'This channel is already locked. Use /sos unlock to open it again.' : why(res);
    return ephemeral(interaction, { embeds: [card({ description: text, tone: res.reason === 'failed' ? 'danger' : 'warn', footer: false })] });
  }
  return announce(interaction, card({ title: 'Channel locked', description: 'Only admins and the server owner can write here.', tone: 'danger', footer: 'sos' }));
}

/** /sos unlock: put the channel back exactly as it was before /sos lock. The reply is already deferred. */
async function unlockHere(interaction, ctx) {
  const channel = interaction.channel;
  if (!channel || !LOCKABLE.has(channel.type)) return deny(interaction, 'Run /sos unlock in the channel that was locked.');

  let res;
  try {
    res = await ctx.lockdown.unlockChannel(interaction.guild, channel.id, interaction.user.id);
  } catch (err) {
    console.error('[35xw] /sos unlock failed:', err);
    res = { ok: false, reason: 'failed', error: err.message, code: err.code };
  }

  if (!res.ok) {
    const text =
      res.reason === 'sos'
        ? 'SOS is on. Run /sos end first.'
        : res.reason === 'not_locked'
          ? 'This channel was not locked with /sos lock, so there is nothing to put back.'
          : res.reason === 'gone'
            ? 'This channel no longer exists.'
            : why(res);
    return ephemeral(interaction, { embeds: [card({ description: text, tone: res.reason === 'failed' ? 'danger' : 'warn', footer: false })] });
  }
  return announce(interaction, card({ title: 'Channel unlocked', description: 'Permissions are back exactly as they were before the lock.', tone: 'ok', footer: 'sos' }));
}

module.exports = { lockHere, unlockHere, announce, why, LOCKABLE };
