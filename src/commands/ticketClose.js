'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { say, requireTicket } = require('./_tickets');

/** /close — close the current ticket: HTML transcript is saved, then the channel is deleted. */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder().setName('close').setDescription('Close the current ticket (saves the transcript).'),
  async execute(interaction, ctx) {
    const ticket = await requireTicket(interaction, ctx);
    if (!ticket) return ctx.refundCooldown();

    const isOpener = interaction.user.id === ticket.userId;
    if (!isOpener && !ctx.tickets.isStaff(interaction.member, interaction.guildId)) {
      ctx.refundCooldown();
      return say(interaction, '⛔ Only the ticket opener or staff can close this ticket.');
    }
    if (ticket.status !== 'open') {
      ctx.refundCooldown();
      return say(interaction, 'This ticket is already being closed.');
    }

    await say(interaction, '🔒 Closing the ticket and saving the transcript…');
    await ctx.tickets.closeTicket(interaction.channel, interaction.user);
    return undefined;
  },
};
