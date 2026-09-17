'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { giveAccount } = require('./_shared');

module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder()
    .setName('5m')
    .setDescription('Dobij FiveM račun koji nitko još nikada nije generirao.'),
  async execute(interaction, ctx) {
    await giveAccount(interaction, ctx, 'fivem');
  },
};
