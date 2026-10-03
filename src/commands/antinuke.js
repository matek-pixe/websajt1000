'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, field, ephemeral, plural } = require('../ui');

const yes = (ok, good, bad) => (ok ? good : bad);

/** /antinuke: show or switch the anti-nuke protection of this server. Owner and manager only. */
module.exports = {
  ownerOnly: true,
  audit: true, // leaves a line in the server log
  data: new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Show or switch the anti-nuke protection (owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('On or off (leave empty to see the status)')
        .setRequired(false)
        .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
    ),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    const mode = interaction.options.getString('mode');
    if (mode) ctx.antiNuke.set(guild.id, mode === 'on');
    else ctx.refundCooldown(); // just looking

    const h = ctx.antiNuke.health(guild);
    const rule = ctx.antiNuke.rule;
    const note = [];
    if (!h.canBan) note.push('I need the Ban Members permission.');
    if (!h.canSeeAudit) note.push('I need the View Audit Log permission.');

    return ephemeral(interaction, {
      embeds: [
        card({
          title: h.on ? 'Anti-nuke is on' : 'Anti-nuke is off',
          description: h.on
            ? `Anyone who deletes more than ${plural(rule.maxChannels, 'channel')} within ${plural(ctx.antiNuke.minutes(), 'minute')} gets a private warning and is banned.`
            : 'Nobody is watched. Turn it back on with `/antinuke mode:On`.',
          fields: [
            field('Never touched', 'The server owner, the bot manager, this bot' + (rule.trustedIds.length ? ` and ${plural(rule.trustedIds.length, 'trusted id')}` : '')),
            field('Ban Members', yes(h.canBan, 'Yes', 'Missing'), true),
            field('View Audit Log', yes(h.canSeeAudit, 'Yes', 'Missing'), true),
            ...(note.length ? [field('Fix this', note.join('\n'))] : []),
          ],
          tone: h.on && !note.length ? 'ok' : 'warn',
          footer: 'anti-nuke',
        }),
      ],
    });
  },
};
