'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { giveAccount } = require('./_shared');

module.exports = {
  managerOnly: false,
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('5m')
    .setDescription('Dobij FiveM račun koji nitko još nikada nije generirao.'),
  async execute(interaction, ctx) {
    await giveAccount(interaction, ctx, 'fivem');
  },
};
