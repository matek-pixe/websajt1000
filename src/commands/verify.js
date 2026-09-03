'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { BUTTONS, panelEmbed, panelRow, controlsRow } = require('../services/tickets');
const { say, openTicketFlow, requireTicket, requireStaff } = require('./_tickets');

/**
 * /v — post the 35xw verification panel with the OPEN TICKET button.
 * This module also owns every "tk:" button (open / close / transcript / reopen / delete).
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

    // Everything below happens inside a ticket channel.
    const ticket = await requireTicket(interaction, ctx);
    if (!ticket) return undefined;

    if (id === BUTTONS.close) {
      const isOpener = interaction.user.id === ticket.userId;
      if (!isOpener && !ctx.tickets.isStaff(interaction.member, interaction.guildId)) {
        return say(interaction, '⛔ Only the ticket opener or staff can close this ticket.');
      }
      if (ticket.status !== 'open') return say(interaction, 'This ticket is already closed.');
      await interaction.update({ components: [] }); // disable the Close button that was pressed
      await ctx.tickets.closeTicket(interaction.channel, interaction.user);
      return undefined;
    }

    // Transcript / Open / Delete are staff-only.
    if (!(await requireStaff(interaction, ctx))) return undefined;

    if (id === BUTTONS.transcript) {
      if (ticket.status === 'open') return say(interaction, 'Close the ticket first.');
      if (ticket.status === 'archived') return say(interaction, 'This ticket is already in the transcript archive.');
      await interaction.update({ components: [] }); // disable the controls that were pressed
      try {
        await ctx.tickets.archiveTicket(interaction.channel, interaction.user);
      } catch (err) {
        console.error('[35xw] archive failed:', err);
        // Give the controls back so staff can retry, and explain what went wrong.
        await interaction.message.edit({ components: [controlsRow()] }).catch(() => {});
        await interaction.followUp({
          content: `❌ Could not move this ticket to the transcript archive: ${err.message}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return undefined;
    }

    if (id === BUTTONS.reopen) {
      if (ticket.status === 'open') return say(interaction, 'This ticket is already open.');
      await interaction.update({ components: [] });
      await ctx.tickets.reopenTicket(interaction.channel, interaction.user);
      return undefined;
    }

    if (id === BUTTONS.delete) {
      await interaction.update({ components: [] });
      await ctx.tickets.deleteTicket(interaction.channel, interaction.user);
      return undefined;
    }

    return undefined;
  },
};
