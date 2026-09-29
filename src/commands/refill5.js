'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { doRefill } = require('./_shared');

module.exports = {
  managerOnly: true,
  data: new SlashCommandBuilder()
    .setName('refill5')
    .setDescription('Refill the FiveM pool from a fivem.txt file (manager only)')
    .addAttachmentOption((opt) =>
      opt.setName('file').setDescription('A fivem.txt file with one account per line').setRequired(true),
    ),
  async execute(interaction, ctx) {
    await doRefill(interaction, ctx, 'fivem');
  },
};
