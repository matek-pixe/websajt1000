'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS } = require('./_shared');

/**
 * /b — the manager's bypass switch ("god mode").
 * While it is ON, the manager skips every limit the bot has: command cooldowns, the one-open-ticket
 * rule and the ticket cooldown. Everything else (commands, buttons) is used exactly as normal.
 */
module.exports = {
  managerOnly: true,
  noCooldown: true, // toggling the switch must never be blocked by a limit
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('b')
    .setDescription('MANAGER: toggle bypass mode — no limits apply to you while it is on.')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Turn it on or off (leave empty to toggle).')
        .setRequired(false)
        .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
    ),

  async execute(interaction, ctx) {
    const mode = interaction.options.getString('mode');
    let on;
    if (mode === 'on') on = ctx.bypass.set(true);
    else if (mode === 'off') on = ctx.bypass.set(false);
    else on = ctx.bypass.toggle();

    const embed = on
      ? new EmbedBuilder()
          .setColor(COLORS.ok)
          .setTitle('⚡ Bypass ON')
          .setDescription(
            'Every limit is switched off for you:\n' +
              '• no cooldown on any command (`/steam`, `/5m`, `/stats`, …)\n' +
              '• open as many tickets as you want, no 10-minute wait\n\n' +
              'Use `/b` again to turn it off.',
          )
      : new EmbedBuilder()
          .setColor(COLORS.warn)
          .setTitle('Bypass OFF')
          .setDescription('Normal limits apply to you again.');

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
