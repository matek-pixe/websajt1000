'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { BUTTONS, panelEmbed, panelRow } = require('../services/tickets');
const { say, openTicketFlow, requireTicket } = require('./_tickets');

/**
 * /v — post the 35xw verification panel with the OPEN TICKET button.
 * This module also owns every "tk:" button (open / close).
 */
module.exports = {
  managerOnly: false,
  buttonPrefix: 'tk:',
  data: new SlashCommandBuilder()
    .setName('v')
    .setDescription('Post the 35xw verification panel with an OPEN TICKET button.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((opt) =>
      opt
        .setName('staff')
        .setDescription('Staff role that can see and manage every ticket (optional).')
        .setRequired(false),
    ),

  async execute(interaction, ctx) {
    if (!ctx.tickets.isStaff(interaction.member, interaction.guildId)) {
      ctx.refundCooldown();
      return say(interaction, '⛔ Only the bot manager or a server admin can post the verification panel.');
    }

    const staff = interaction.options.getRole('staff');
    if (staff) ctx.tickets.setStaffRole(interaction.guildId, staff.id);

    // Posted as a plain bot message (not as the command reply) so it looks clean.
    await interaction.channel.send({ embeds: [panelEmbed()], components: [panelRow()] });

    const staffNote = staff ? ` Staff role set to <@&${staff.id}>.` : '';
    return interaction.reply({ content: `✅ Verification panel posted.${staffNote}`, flags: MessageFlags.Ephemeral });
  },

  async handleButton(interaction, ctx) {
    const id = interaction.customId;

    if (id === BUTTONS.open) {
      return openTicketFlow(interaction, ctx);
    }

    if (id === BUTTONS.close) {
      const ticket = await requireTicket(interaction, ctx);
      if (!ticket) return undefined;
      const isOpener = interaction.user.id === ticket.userId;
      if (!isOpener && !ctx.tickets.isStaff(interaction.member, interaction.guildId)) {
        return say(interaction, '⛔ Only the ticket opener or staff can close this ticket.');
      }
      if (ticket.status !== 'open') return say(interaction, 'This ticket is already being closed.');
      await interaction.update({ components: [] }); // disable the Close button that was pressed
      const res = await ctx.tickets.closeTicket(interaction.channel, interaction.user);
      if (!res.ok && res.reason === 'in_progress') {
        await interaction.followUp({ content: 'This ticket is already being closed.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return undefined;
    }

    return undefined;
  },
};
