'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { POOL_TYPES } = require('../services/accounts');
const { COLORS } = require('./_shared');

const MAX_PER_POOL = 10;
const FIELD_LIMIT = 1024;

/** Put account lines in a code block, trimming if Discord's field limit would be exceeded. */
function codeBlock(lines) {
  let body = lines.join('\n');
  const wrap = (s) => '```\n' + s + '\n```';
  if (wrap(body).length <= FIELD_LIMIT) return wrap(body);
  const note = '\n… (trimmed, see your DM history for the rest)';
  body = body.slice(0, FIELD_LIMIT - wrap('').length - note.length) + note;
  return wrap(body);
}

/**
 * /b — bypass for the bot manager. Skips every limit (no cooldown) and hands out accounts from
 * every pool at once. The accounts are marked as given to the manager like any other claim.
 */
module.exports = {
  managerOnly: true,
  noCooldown: true, // the whole point of /b is "no limits"
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('b')
    .setDescription('MANAGER: bypass every limit and get accounts from all pools at once.')
    .addIntegerOption((opt) =>
      opt
        .setName('amount')
        .setDescription(`How many accounts per pool (1-${MAX_PER_POOL}, default 1).`)
        .setMinValue(1)
        .setMaxValue(MAX_PER_POOL)
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('pool')
        .setDescription('Which pool to take from (default: all).')
        .setRequired(false)
        .addChoices(
          { name: 'All pools', value: 'all' },
          { name: 'Steam', value: 'steam' },
          { name: 'FiveM (Rockstar)', value: 'fivem' },
        ),
    ),

  async execute(interaction, ctx) {
    const amount = interaction.options.getInteger('amount') ?? 1;
    const which = interaction.options.getString('pool') ?? 'all';
    const pools = which === 'all' ? Object.keys(POOL_TYPES) : [which];

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const taken = []; // [type, account] for rollback if delivery fails
    const embed = new EmbedBuilder()
      .setColor(COLORS.ok)
      .setTitle('⚡ Bypass')
      .setDescription('All limits skipped. These accounts are now marked as given to you.')
      .setFooter({ text: '35xw • manager bypass' })
      .setTimestamp();

    for (const type of pools) {
      const info = POOL_TYPES[type];
      const got = [];
      for (let i = 0; i < amount; i += 1) {
        const account = ctx.accounts.claim(type, interaction.user);
        if (account === null) break;
        got.push(account);
        taken.push([type, account]);
      }
      const left = ctx.accounts.stats(type).available;
      embed.addFields({
        name: `${info.emoji} ${info.label} — ${got.length}/${amount} (left in pool: ${left})`,
        value: got.length ? codeBlock(got) : '_Pool is empty._',
      });
    }
    if (taken.length === 0) embed.setColor(COLORS.warn).setDescription('Every selected pool is empty.');

    try {
      return await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      // Delivery failed: put everything back so nothing is silently burned.
      for (const [type, account] of taken) ctx.accounts.unclaim(type, account);
      console.error(`[35xw] /b delivery failed, rolled back ${taken.length} account(s): ${err.message}`);
      throw err;
    }
  },
};
