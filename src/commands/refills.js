'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { doRefill } = require('./_shared');

module.exports = {
  managerOnly: true,
  data: new SlashCommandBuilder()
    .setName('refills')
    .setDescription('MENADŽER: napuni Steam zalihu (priloži steam.txt).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addAttachmentOption((opt) =>
      opt.setName('file').setDescription('steam.txt – jedan račun po retku').setRequired(true),
    ),
  async execute(interaction, ctx) {
    await doRefill(interaction, ctx, 'steam');
  },
};
