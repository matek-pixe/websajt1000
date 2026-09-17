'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { POOL_TYPES, formatAccount } = require('../services/accounts');
const { COLORS } = require('./_shared');

const ORDER = ['steam', 'fivem'];

/**
 * /combo — one Steam and one FiveM account together, one below the other.
 * Same rules as /steam and /5m: never-given accounts only, cooldown, bypass, rollback on failure.
 */
module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder().setName('combo').setDescription('Dobij Steam i FiveM račun odjednom.'),

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const taken = []; // [type, account] for rollback if delivery fails
    const fields = [];
    for (const type of ORDER) {
      const info = POOL_TYPES[type];
      const account = ctx.accounts.claim(type, interaction.user);
      if (account === null) {
        fields.push({ name: `${info.emoji} ${info.label}`, value: '_Trenutno nema slobodnih računa u ovoj zalihi._' });
      } else {
        taken.push([type, account]);
        fields.push({ name: `${info.emoji} ${info.label}`, value: '```\n' + formatAccount(account) + '\n```' });
      }
    }

    if (taken.length === 0) {
      ctx.refundCooldown(); // nothing was handed out, do not burn the cooldown
      const embed = new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle('🎁 Nema računa')
        .setDescription('Obje zalihe su trenutno prazne. Pričekaj da menadžer napuni zalihu pa pokušaj ponovno.');
      return interaction.editReply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor(taken.length === ORDER.length ? COLORS.ok : COLORS.warn)
      .setTitle('🎁 Tvoj combo')
      .setDescription('Ovi računi su samo tvoji i nikada nisu bili dani nikome drugom. Čuvaj ih.')
      .addFields(fields)
      .setFooter({ text: '35xw • combo' })
      .setTimestamp();

    try {
      return await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      // Delivery failed: return everything to the pools so nothing is silently burned.
      for (const [type, account] of taken) ctx.accounts.unclaim(type, account);
      ctx.refundCooldown();
      console.error(`[35xw] /combo delivery failed, rolled back ${taken.length} account(s): ${err.message}`);
      throw err;
    }
  },
};
