'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, field, ephemeral, mention, lines } = require('../ui');

const state = (r, good) => (r ? (r.ok ? good : `Failed. ${r.error}`) : 'Not attempted');

/** /ticketalert: send a test "new ticket" alert and show exactly what arrived and what did not. */
module.exports = {
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName('ticketalert')
    .setDescription('Send a test ticket alert and show what works (owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: 64 });
    const guild = interaction.guild;
    const report = await ctx.tickets.notifyOpened(guild, interaction.member, interaction.channel, 0, { test: true });
    const problems = ctx.tickets.alertProblems(guild);

    if (report.skipped) {
      return ephemeral(interaction, {
        embeds: [
          card({
            title: 'No alert sent',
            description: 'This server is not set up for ticket alerts. They go to the owner server, the one that has the staff channel or is owned by the alert user.',
            tone: 'warn',
            footer: 'tickets',
          }),
        ],
      });
    }

    const n = ctx.config.tickets.notify;
    const ok = report.staff && report.staff.ok && report.dm && report.dm.ok && !problems.length;
    return ephemeral(interaction, {
      embeds: [
        card({
          title: ok ? 'Ticket alerts work' : 'Ticket alerts need attention',
          fields: [
            field('Staff channel', state(report.staff, `Posted in ${mention.channel(n.channelId)} (or the staff-news channel of this server)`)),
            field('DM to the owner', state(report.dm, `Sent to ${mention.user(n.userId)}`)),
            field('Roles that get pinged', report.roles.length ? report.roles.map(mention.role).join(' ') : 'None found on this server'),
            ...(problems.length ? [field('Fix this', lines(problems, { max: 8 }))] : []),
          ],
          tone: ok ? 'ok' : 'warn',
          footer: 'tickets',
        }),
      ],
    });
  },
};
