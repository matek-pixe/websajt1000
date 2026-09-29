'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, deny, warn, mention } = require('../ui');
const { requireTicket, requireStaff } = require('./_tickets');

/** /add: give a member or a role access to the current ticket (staff only). */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a member or role to the current ticket (staff only)')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to add').setRequired(false))
    .addRoleOption((opt) => opt.setName('role').setDescription('Role to add').setRequired(false)),
  async execute(interaction, ctx) {
    const ticket = await requireTicket(interaction, ctx);
    if (!ticket) return ctx.refundCooldown();
    if (!(await requireStaff(interaction, ctx))) return ctx.refundCooldown();

    const user = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');
    const target = user || role;
    if (!target) {
      ctx.refundCooldown();
      return warn(interaction, 'Pick a member or a role to add.');
    }

    try {
      await ctx.tickets.addToTicket(interaction.channel, target);
    } catch (err) {
      ctx.refundCooldown();
      return deny(interaction, `Could not add them to this ticket (${err.message}). Check that the bot can manage this channel, then try again.`);
    }

    // Public reply. The mention sits in the content so the added member is notified.
    const who = user ? mention.user(user.id) : mention.role(role.id);
    await interaction.reply({ content: who, embeds: [card({ description: 'Added to this ticket.', tone: 'ok', footer: false })] });
    return undefined;
  },
};
