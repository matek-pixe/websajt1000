'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

/** /ping — bot latency. */
module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder().setName('ping').setDescription("Replies with the bot's current ping."),
  async execute(interaction) {
    const ws = Math.round(interaction.client.ws.ping);
    await interaction.reply({ content: `🏓 Pong! Latency: **${ws}ms**`, flags: MessageFlags.Ephemeral });
  },
};
