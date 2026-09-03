'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { requireTicket, requireStaff } = require('./_tickets');

/** /claim — claim (or unclaim) the current ticket so others know who is handling it (staff only). */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder().setName('claim').setDescription('Claim or unclaim the current ticket.'),
  async execute(interaction, ctx) {
    const ticket = await requireTicket(interaction, ctx);
    if (!ticket) return ctx.refundCooldown();
    if (!(await requireStaff(interaction, ctx))) return ctx.refundCooldown();

    const res = ctx.tickets.claim(interaction.channel, interaction.member);
    const text = res.claimed
      ? `🙋 Ticket claimed by <@${interaction.user.id}>`
      : `🙋 Ticket unclaimed by <@${interaction.user.id}>`;
    await interaction.reply({ content: text });
    return undefined;
  },
};
