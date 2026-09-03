'use strict';

const { MessageFlags } = require('discord.js');
const { formatTicketName, formatDuration } = require('../services/tickets');

/** Reply ephemerally whether or not the interaction was already deferred/replied. */
async function say(interaction, content) {
  if (interaction.deferred || interaction.replied) return interaction.editReply({ content });
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/**
 * Shared "open a ticket" flow used by the OPEN TICKET button and /new.
 * Enforces one open ticket per user and the post-close cooldown, then creates the channel.
 */
async function openTicketFlow(interaction, ctx) {
  if (!interaction.inGuild() || !interaction.guild) {
    return say(interaction, 'Tickets can only be opened inside a server.');
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const member = interaction.member;
  let res;
  try {
    res = await ctx.tickets.createTicket(interaction.guild, member);
  } catch (err) {
    console.error('[35xw] ticket create failed:', err);
    return say(
      interaction,
      "❌ I couldn't create your ticket. Make sure I have **Manage Channels** and **Manage Roles** permissions.",
    );
  }

  if (res.ok) {
    return say(interaction, `🎫 Your ticket has been created: <#${res.channel.id}>`);
  }
  switch (res.reason) {
    case 'already_open':
      return say(interaction, `You already have an open ticket: <#${res.channelId}>`);
    case 'cooldown':
      return say(interaction, `⏳ You can open a new ticket in **${formatDuration(res.retryInMs)}**.`);
    case 'in_progress':
      return say(interaction, 'Your ticket is already being created, one moment…');
    default:
      return say(interaction, '❌ Could not open a ticket right now.');
  }
}

/** Returns the ticket record for the current channel, or replies and returns null. */
async function requireTicket(interaction, ctx) {
  if (!interaction.inGuild() || !interaction.channel) {
    await say(interaction, 'This command only works inside a ticket channel.');
    return null;
  }
  const t = ctx.tickets.get(interaction.guildId, interaction.channelId);
  if (!t) {
    await say(interaction, 'This is not a ticket channel.');
    return null;
  }
  return t;
}

/** True if the member is staff; otherwise replies with a denial and returns false. */
async function requireStaff(interaction, ctx) {
  if (ctx.tickets.isStaff(interaction.member, interaction.guildId)) return true;
  await say(interaction, '⛔ Only staff can do that.');
  return false;
}

module.exports = { say, openTicketFlow, requireTicket, requireStaff, formatTicketName };
