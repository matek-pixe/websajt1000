'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { say, requireTicket, requireStaff } = require('./_tickets');

/** /open — reopen a closed ticket (staff only). */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder().setName('open').setDescription('Reopen the current ticket if it was closed.'),
  async execute(interaction, ctx) {
    const ticket = await requireTicket(interaction, ctx);
    if (!ticket) return ctx.refundCooldown();
    if (!(await requireStaff(interaction, ctx))) return ctx.refundCooldown();
    if (ticket.status === 'open') {
      ctx.refundCooldown();
      return say(interaction, 'This ticket is already open.');
    }

    await say(interaction, '🔓 Reopening the ticket…');
    await ctx.tickets.reopenTicket(interaction.channel, interaction.user);
    return undefined;
  },
};
