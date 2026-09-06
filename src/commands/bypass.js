'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS } = require('./_shared');

const LIMITS_OFF = '• no cooldown on any command (`/steam`, `/5m`, `/combo`, …)\n• unlimited open tickets, no 10-minute wait';

/**
 * /b — bypass ("god mode"). Manager only.
 *   /b                      toggle your own bypass
 *   /b mode:On|Off          set your own bypass
 *   /b user:@someone        give that person bypass (or take it away if they have it)
 *   /b user:@someone mode:On|Off
 *   /b mode:List            who has bypass right now
 */
module.exports = {
  managerOnly: true,
  noCooldown: true, // toggling the switch must never be blocked by a limit
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('b')
    .setDescription('MANAGER: bypass mode — no limits for you, or for someone you give it to.')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Give / remove bypass for this person (leave empty for yourself).').setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('On / Off (leave empty to toggle), or List to see who has bypass.')
        .setRequired(false)
        .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }, { name: 'List', value: 'list' }),
    ),

  async execute(interaction, ctx) {
    const mode = interaction.options.getString('mode');
    const target = interaction.options.getUser('user');
    const managerId = ctx.config.manager.id;
    const reply = (embed) => interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    // ---- who has it ----
    if (mode === 'list') {
      const rows = ctx.bypass.list();
      const people = rows.length
        ? rows.map((r) => `• <@${r.id}>${r.at ? ` — since <t:${Math.floor(new Date(r.at).getTime() / 1000)}:d>` : ''}`).join('\n')
        : '_Nobody else has bypass._';
      return reply(
        new EmbedBuilder()
          .setColor(COLORS.info)
          .setTitle('⚡ Bypass list')
          .addFields(
            { name: 'Your switch', value: ctx.bypass.isEnabled() ? '🟢 ON' : '⚪ OFF' },
            { name: `Given to (${rows.length})`, value: people.slice(0, 1024) },
          ),
      );
    }

    // ---- someone else ----
    if (target && target.id !== managerId) {
      let on;
      if (mode === 'on') on = ctx.bypass.grant(target.id, interaction.user.id) && true;
      else if (mode === 'off') on = !ctx.bypass.revoke(target.id) && false;
      else on = ctx.bypass.toggleUser(target.id, interaction.user.id);

      return reply(
        on
          ? new EmbedBuilder()
              .setColor(COLORS.ok)
              .setTitle('⚡ Bypass given')
              .setDescription(`<@${target.id}> now skips every limit:\n${LIMITS_OFF}\n\nRemove it with \`/b user:@${target.username} mode:Off\`.`)
          : new EmbedBuilder()
              .setColor(COLORS.warn)
              .setTitle('Bypass removed')
              .setDescription(`<@${target.id}> is back to the normal limits.`),
      );
    }

    // ---- yourself ----
    let on;
    if (mode === 'on') on = ctx.bypass.set(true);
    else if (mode === 'off') on = ctx.bypass.set(false);
    else on = ctx.bypass.toggle();

    return reply(
      on
        ? new EmbedBuilder()
            .setColor(COLORS.ok)
            .setTitle('⚡ Bypass ON')
            .setDescription(`Every limit is switched off for you:\n${LIMITS_OFF}\n\nUse \`/b\` again to turn it off. Give it to someone with \`/b user:@name\`.`)
        : new EmbedBuilder().setColor(COLORS.warn).setTitle('Bypass OFF').setDescription('Normal limits apply to you again.'),
    );
  },
};
