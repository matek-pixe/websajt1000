'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { giveAccount } = require('./_shared');

module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder()
    .setName('steam')
    .setDescription('Dobij Steam račun koji nikada nije bio dan nikome na serveru.'),
  async execute(interaction, ctx) {
    await giveAccount(interaction, ctx, 'steam');
  },
};
