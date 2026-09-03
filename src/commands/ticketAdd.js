'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { say, requireTicket, requireStaff } = require('./_tickets');

/** /add — give a user or a role access to the current ticket (staff only). */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a user or role to the current ticket.')
    .addUserOption((opt) => opt.setName('user').setDescription('User to add').setRequired(false))
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
      return say(interaction, 'Pick a **user** or a **role** to add.');
    }

    try {
      await ctx.tickets.addToTicket(interaction.channel, target);
    } catch (err) {
      ctx.refundCooldown();
      return say(interaction, `❌ Could not add them: ${err.message}`);
    }

    const mention = user ? `<@${user.id}>` : `<@&${role.id}>`;
    await interaction.reply({ content: `✅ Added ${mention} to this ticket.` });
    return undefined;
  },
};
