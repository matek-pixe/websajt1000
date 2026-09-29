'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { POOL_TYPES, formatAccount } = require('../services/accounts');
const { card, field, codeBlock, joinList } = require('../ui');

const ORDER = ['steam', 'fivem'];

/**
 * /combo: one Steam and one FiveM account together, one below the other.
 * Same rules as /steam and /5m: never-given accounts only, cooldown, bypass, rollback on failure.
 */
module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder().setName('combo').setDescription('Get a Steam and a FiveM account at once'),

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const taken = []; // [type, account] for rollback if delivery fails
    const fields = [];
    for (const type of ORDER) {
      const info = POOL_TYPES[type];
      const account = ctx.accounts.claim(type, interaction.user);
      if (account === null) {
        fields.push(field(info.label, 'Out of stock'));
      } else {
        taken.push([type, account]);
        fields.push(field(info.label, codeBlock(formatAccount(account))));
      }
    }

    if (taken.length === 0) {
      ctx.refundCooldown(); // nothing was handed out, do not burn the cooldown
      const embed = card({
        title: 'No accounts left',
        description: 'Both pools are empty, so try again after the manager refills them.',
        tone: 'warn',
        footer: 'combo',
      });
      return interaction.editReply({ embeds: [embed] });
    }

    const description =
      taken.length === ORDER.length
        ? 'Both accounts are yours alone and were never given out before.'
        : `Only the ${joinList(taken.map(([type]) => POOL_TYPES[type].label))} pool had stock. ` +
          'That account is yours alone and was never given out before.';

    const embed = card({ title: 'Your combo', description, fields, tone: 'ok', footer: 'combo' });

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
