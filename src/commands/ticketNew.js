'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { openTicketFlow } = require('./_tickets');

/** /new — open a ticket (same rules as the OPEN TICKET button). */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder().setName('new').setDescription('Create a ticket.'),
  async execute(interaction, ctx) {
    await openTicketFlow(interaction, ctx);
  },
};
