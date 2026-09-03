'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { giveAccount } = require('./_shared');

module.exports = {
  managerOnly: false,
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('steam')
    .setDescription('Dobij Steam račun koji nikada nije bio dan nikome na serveru.'),
  async execute(interaction, ctx) {
    await giveAccount(interaction, ctx, 'steam');
  },
};
