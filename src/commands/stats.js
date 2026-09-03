'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS } = require('./_shared');

const MEDALS = ['🥇', '🥈', '🥉'];

/** Render a "top users" leaderboard as a nice, mention-based list. */
function renderLeaderboard(top) {
  if (!top || top.length === 0) return '_Nitko još nije koristio ovu komandu._';
  return top
    .map((entry, i) => {
      const rank = MEDALS[i] || `**${i + 1}.**`;
      return `${rank} <@${entry.userId}> — **${entry.count}**`;
    })
    .join('\n');
}

module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Prikaži "Rastrošan" statistiku servera i najveće potrošače.'),

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

    const totalSteam = steam.given;
    const totalFivem = fivem.given;

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('💸 Rastrošan')
      .setDescription(`Statistika servera **${guild.name}** i najveći potrošači računa.`)
      .addFields(
        { name: '👥 Članova na serveru', value: String(memberCount), inline: true },
        { name: '🎮 Podijeljeno Steam', value: String(totalSteam), inline: true },
        { name: '🚗 Podijeljeno FiveM', value: String(totalFivem), inline: true },
        { name: '🎮 Najviše /steam', value: renderLeaderboard(steam.top), inline: false },
        { name: '🚗 Najviše /5m', value: renderLeaderboard(fivem.top), inline: false },
        {
          name: '📦 Zaliha',
          value: `Steam slobodno: **${steam.available}**\nFiveM slobodno: **${fivem.available}**`,
          inline: false,
        },
      )
      .setFooter({ text: '35xw • Rastrošan' })
      .setTimestamp();

    if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
