'use strict';

const { MessageFlags } = require('discord.js');
const { formatTicketName, formatDuration } = require('../services/tickets');
const { say, deny, warn, mention, COPY } = require('../ui');

/**
 * Shared "open a ticket" flow used by the OPEN TICKET button.
 * Enforces one open ticket per member and the post-close cooldown, then creates the channel.
 */
async function openTicketFlow(interaction, ctx) {
  if (!interaction.inGuild() || !interaction.guild) {
    return deny(interaction, 'Tickets can only be opened inside a server.');
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const member = interaction.member;
  let res;
  try {
    res = await ctx.tickets.createTicket(interaction.guild, member, { bypass: ctx.isBypass(interaction.user) });
  } catch (err) {
    console.error('[35xw] ticket create failed:', err);
    return deny(
      interaction,
      'Could not create your ticket. Check that the bot has the Manage Channels and Manage Roles permissions, then try again.',
    );
  }

  if (res.ok) {
    return say(interaction, `Your ticket is open: ${mention.channel(res.channel.id)}`, 'ok');
  }
  switch (res.reason) {
    case 'already_open':
      return warn(interaction, `You already have an open ticket: ${mention.channel(res.channelId)}`);
    case 'cooldown':
      return warn(interaction, `You can open a new ticket in **${formatDuration(res.retryInMs)}**.`);
    case 'in_progress':
      return warn(interaction, 'Your ticket is already being created. Wait a moment.');
    default:
      return deny(interaction, COPY.failed);
  }
}

/** Returns the ticket record for the current channel, or replies and returns null. */
async function requireTicket(interaction, ctx) {
  if (!interaction.inGuild() || !interaction.channel) {
    await warn(interaction, 'This command only works inside a ticket channel.');
    return null;
  }
  const t = ctx.tickets.get(interaction.guildId, interaction.channelId);
  if (!t) {
    await warn(interaction, 'This is not a ticket channel. Run the command inside a ticket.');
    return null;
  }
  return t;
}

/** True if the member is staff; otherwise replies with a denial and returns false. */
async function requireStaff(interaction, ctx) {
  if (ctx.tickets.isStaff(interaction.member, interaction.guildId)) return true;
  await deny(interaction, COPY.staffOnly(interaction.commandName));
  return false;
}

module.exports = { say, openTicketFlow, requireTicket, requireStaff, formatTicketName };
