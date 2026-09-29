'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { doRefill } = require('./_shared');

module.exports = {
  managerOnly: true,
  data: new SlashCommandBuilder()
    .setName('refills')
    .setDescription('Refill the Steam pool from a steam.txt file (manager only)')
    .addAttachmentOption((opt) =>
      opt.setName('file').setDescription('A steam.txt file with one account per line').setRequired(true),
    ),
  async execute(interaction, ctx) {
    await doRefill(interaction, ctx, 'steam');
  },
};
