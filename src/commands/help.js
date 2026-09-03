'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS } = require('./_shared');

/** /help — list every command and how to use it. */
module.exports = {
  managerOnly: false,
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Prikaži sve komande bota 35xw i kako se koriste.'),

  async execute(interaction, ctx) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📖 35xw — sve komande')
      .setDescription('Upiši `/` u chat pa ti Discord sam ponudi ove komande i njihova polja.')
      .addFields(
        {
          name: '🎮 Za sve',
          value:
            '`/steam` — dobij Steam račun (nitko ga prije nije dobio)\n' +
            '`/5m` — dobij FiveM račun (nitko ga prije nije generirao)\n' +
            '`/stats` — Rastrošan ploča: tko je najviše potrošio\n' +
            '`/help` — ovaj popis',
        },
        {
          name: '⚙️ Vlasnik servera',
          value:
            '`/aa role:@rola` — postavi rolu koju svaki novi član dobije\n' +
            '`/aa` (bez role) — pokaži koja je auto rola trenutno postavljena',
        },
        {
          name: '🔑 Samo menadžer',
          value:
            '`/refills` + priloži `steam.txt` — napuni Steam zalihu\n' +
            '`/refill5` + priloži `fivem.txt` — napuni FiveM zalihu\n' +
            '`/n` — obriši SVE kanale i ostavi samo „zavrseno" (traži potvrdu)',
        },
        {
          name: 'ℹ️ Dobro je znati',
          value:
            `• Svaka komanda ima pauzu od **${Math.round(ctx.config.cooldownMs / 1000)}s**.\n` +
            '• Računi ti stižu privatno (samo ti ih vidiš).\n' +
            '• Ban briše zapamćene role; običan kick ih vrati kad se član vrati.',
        },
      )
      .setFooter({ text: '35xw' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
