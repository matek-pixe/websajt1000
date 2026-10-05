'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { card, field, ephemeral, deny, mention, lines, plural } = require('../ui');

/**
 * /priv: make the priv role and open the private category for it. Whoever holds the role can see the
 * category, write in its text channels and join and speak in its voice channels. Admins only.
 */
module.exports = {
  adminOnly: true,
  audit: true, // leaves a line in the server log
  data: new SlashCommandBuilder()
    .setName('priv')
    .setDescription('Create the priv role and give it access to the private category (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    const me = guild.members.me;
    const refuse = (text) => {
      ctx.refundCooldown();
      return deny(interaction, text);
    };

    const category = ctx.priv.category(guild);
    if (!category) return refuse(`The private category ${ctx.config.priv.categoryId} was not found on this server.`);
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) return refuse('I need the Manage Roles permission.');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = `35xw /priv by ${interaction.user.tag || interaction.user.id}`;

    let made;
    try {
      made = await ctx.priv.ensureRole(guild, reason);
    } catch (err) {
      ctx.refundCooldown();
      return ephemeral(interaction, { embeds: [card({ description: `Could not create the role: ${err.message}`, tone: 'danger', footer: false })] });
    }
    const res = await ctx.priv.grant(guild, category, made.role, reason);

    const problems = res.failed.map((f) => `${f.name}: ${f.error}`);
    return ephemeral(interaction, {
      embeds: [
        card({
          title: made.created ? 'Priv role created' : 'Priv role updated',
          description: `${mention.role(made.role.id)} can see **${category.name}**, write in its text channels and join and speak in its voice channels. Give the role to a member to let them in.`,
          fields: [
            field('Opened', plural(res.done.length, 'channel') + ` (the category and ${res.done.length - (res.done.includes(category.name) ? 1 : 0)} inside)`, true),
            ...(res.skipped.length ? [field('Not granted', `I do not hold ${res.skipped.join(', ')} myself.`)] : []),
            ...(problems.length ? [field('Could not change', lines(problems, { max: 8, limit: 900 }))] : []),
          ],
          tone: problems.length ? 'warn' : 'ok',
          footer: 'priv',
        }),
      ],
    });
  },
};
