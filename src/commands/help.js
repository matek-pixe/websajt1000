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
            '🎫 **OPEN TICKET** gumb — otvori ticket (jedan po osobi, 10 min pauze nakon zatvaranja)\n' +
            '`/close` — zatvori svoj ticket\n' +
            '`/ping` — ping bota\n' +
            '`/help` — ovaj popis',
        },
        {
          name: '🎫 Ticket sustav (staff)',
          value:
            '`/v [staff:@rola]` — objavi panel „35xw verification" s gumbom OPEN TICKET\n' +
            '`/add user:@netko` ili `/add role:@rola` — dodaj nekoga u ticket\n' +
            'Tijek: `ticket-0001` (vidi ga samo tko ga je otvorio + staff) → 🔒 Close → bot odmah spremi **HTML transkript** `transcript-0001.html` u kanal **#transcripts** (tko je otvorio, tko zatvorio, broj poruka, trajanje) i obriše ticket.',
        },
        {
          name: '⚙️ Vlasnik servera / admini',
          value:
            '`/aa role:@rola` — postavi rolu koju svaki novi član dobije\n' +
            '`/aa` (bez role) — pokaži koja je auto rola trenutno postavljena\n' +
            '`/f role:@rola` — daj tu rolu SVIM članovima (samo admini); `action:Remove` je svima makne, `bots:true` uključi i botove',
        },
        {
          name: '🔑 Samo menadžer',
          value:
            '`/refills` + priloži `steam.txt` — napuni Steam zalihu\n' +
            '`/refill5` + priloži `fivem.txt` — napuni FiveM zalihu\n' +
            '`/b` — bypass prekidač: dok je upaljen, za tebe ne vrijedi nijedan limit (cooldown, ticketi)\n' +
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
