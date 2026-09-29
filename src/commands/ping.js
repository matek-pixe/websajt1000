'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, ephemeral } = require('../ui');

/** /ping: bot latency. */
module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder().setName('ping').setDescription('Show the bot latency'),
  async execute(interaction) {
    const ws = Math.round(interaction.client.ws.ping);
    await ephemeral(interaction, {
      embeds: [card({ title: 'Latency', description: `Gateway ping is **${ws} ms**.` })],
    });
  },
};
