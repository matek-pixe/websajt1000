'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { doRefill } = require('./_shared');

module.exports = {
  managerOnly: true,
  data: new SlashCommandBuilder()
    .setName('refill5')
    .setDescription('MENADŽER: napuni FiveM zalihu (priloži fivem.txt).')
    .addAttachmentOption((opt) =>
      opt.setName('file').setDescription('fivem.txt – jedan račun po retku').setRequired(true),
    ),
  async execute(interaction, ctx) {
    await doRefill(interaction, ctx, 'fivem');
  },
};
