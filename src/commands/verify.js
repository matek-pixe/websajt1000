'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { BUTTONS, panelEmbed, panelRow } = require('../services/tickets');
const { card, say, deny, warn, mention, COPY } = require('../ui');
const { openTicketFlow, requireTicket } = require('./_tickets');

const ALREADY_CLOSING = 'This ticket is already being closed.';

/**
 * /v: post the 35xw verification panel with the OPEN TICKET button.
 * This module also owns every "tk:" button (open / close).
 */
module.exports = {
  managerOnly: false,
  buttonPrefix: 'tk:',
  data: new SlashCommandBuilder()
    .setName('v')
    .setDescription('Post the verification panel with a ticket button (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((opt) =>
      opt
        .setName('staff')
        .setDescription('Staff role that can see and manage every ticket (optional)')
        .setRequired(false),
    ),

  async execute(interaction, ctx) {
    if (!ctx.tickets.isStaff(interaction.member, interaction.guildId)) {
      ctx.refundCooldown();
      return deny(interaction, COPY.staffOnly('v'));
    }

    const staff = interaction.options.getRole('staff');
    if (staff) ctx.tickets.setStaffRole(interaction.guildId, staff.id);

    // Posted as a plain bot message (not as the command reply) so it looks clean.
    await interaction.channel.send({ embeds: [panelEmbed()], components: [panelRow()] });

    const staffNote = staff ? ` Staff role set to ${mention.role(staff.id)}.` : '';
    return say(interaction, `Verification panel posted.${staffNote}`, 'ok');
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
        return deny(interaction, 'Only the ticket opener or staff can close this ticket.');
      }
      if (ticket.status !== 'open') return warn(interaction, ALREADY_CLOSING);
      await interaction.update({ components: [] }); // disable the Close button that was pressed
      const res = await ctx.tickets.closeTicket(interaction.channel, interaction.user);
      if (!res.ok && res.reason === 'in_progress') {
        // update() already answered the button, so a plain say() would edit the ticket message instead.
        await interaction
          .followUp({ embeds: [card({ description: ALREADY_CLOSING, tone: 'warn', footer: false })], flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
      return undefined;
    }

    return undefined;
  },
};
