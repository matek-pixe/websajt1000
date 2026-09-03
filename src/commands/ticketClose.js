'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { say, requireTicket } = require('./_tickets');

/** /close — close the current ticket (opener or staff). */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder().setName('close').setDescription('Close the current ticket.'),
  async execute(interaction, ctx) {
    const ticket = await requireTicket(interaction, ctx);
    if (!ticket) return ctx.refundCooldown();

    const isOpener = interaction.user.id === ticket.userId;
    if (!isOpener && !ctx.tickets.isStaff(interaction.member, interaction.guildId)) {
      ctx.refundCooldown();
      return say(interaction, '⛔ Only the ticket opener or staff can close this ticket.');
    }
    if (ticket.status === 'closed') {
      ctx.refundCooldown();
      return say(interaction, 'This ticket is already closed.');
    }

    await say(interaction, '🔒 Closing the ticket…');
    await ctx.tickets.closeTicket(interaction.channel, interaction.user);
    return undefined;
  },
};
