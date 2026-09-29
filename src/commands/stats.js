'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, mention, num } = require('../ui');

/** Render a top list, one member per line. */
function renderLeaderboard(top) {
  if (!top || top.length === 0) return 'Nobody yet.';
  return top
    .map((entry, i) => {
      const rank = `**${i + 1}.**`;
      return `${rank} ${mention.user(entry.userId)} **${num(entry.count)}**`;
    })
    .join('\n');
}

module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show the Rastrošan board and the top members'),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    const steam = ctx.accounts.stats('steam', 5);
    const fivem = ctx.accounts.stats('fivem', 5);

    // memberCount is kept up to date by the gateway; fall back to a fetch if it looks unset.
    let memberCount = guild.memberCount;
    if (!memberCount) {
      const fetched = await guild.members.fetch().catch(() => null);
      memberCount = fetched ? fetched.size : 0;
    }

    const embed = card({
      title: 'Rastrošan',
      description: `**${guild.name}**\nWho took the most accounts from the pool.`,
      fields: [
        field('Members', num(memberCount), true),
        field('Steam given', num(steam.given), true),
        field('FiveM given', num(fivem.given), true),
        field('Top for /steam', renderLeaderboard(steam.top)),
        field('Top for /5m', renderLeaderboard(fivem.top)),
        field('In the pool', `Steam **${num(steam.available)}**\nFiveM **${num(fivem.available)}**`),
      ],
      footer: 'stats',
      timestamp: true,
      thumbnail: guild.iconURL({ size: 256 }),
    });

    // Public on purpose: the Rastrošan board is a server leaderboard everyone should see.
    await interaction.reply({ embeds: [embed] });
  },
};
