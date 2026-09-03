'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { doRefill } = require('./_shared');

module.exports = {
  managerOnly: true,
  data: new SlashCommandBuilder()
    .setName('refills')
    .setDescription('MENADŽER: napuni Steam zalihu (priloži steam.txt).')
    .addAttachmentOption((opt) =>
      opt.setName('file').setDescription('steam.txt – jedan račun po retku').setRequired(true),
    ),
  async execute(interaction, ctx) {
    await doRefill(interaction, ctx, 'steam');
  },
};
