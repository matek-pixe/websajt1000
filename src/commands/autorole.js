'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, field, deny, ephemeral, mention, COPY } = require('../ui');

/**
 * /aa: the server owner picks the role that every new member gets on THIS server.
 * With no role given, it shows the current setting instead.
 */
module.exports = {
  managerOnly: false,
  audit: true, // leaves a line in the server log
  data: new SlashCommandBuilder()
    .setName('aa')
    .setDescription('Set the role every new member gets (owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((opt) =>
      opt
        .setName('role')
        .setDescription('Role for new members, leave empty to see the current one')
        .setRequired(false),
    ),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    const isOwner = guild.ownerId === interaction.user.id;
    const isManager = ctx.isManager(interaction.user);

    if (!isOwner && !isManager) {
      ctx.refundCooldown();
      return deny(interaction, COPY.ownerOnly('aa'));
    }

    const role = interaction.options.getRole('role');

    // No role supplied -> show the current setting.
    if (!role) {
      ctx.refundCooldown();
      const currentId = ctx.roleMemory.getGuildAutoRole(guild.id);
      let description = 'No auto role is set. Run /aa with a role to set one.';
      let tone = 'neutral';
      if (currentId && guild.roles.cache.has(currentId)) {
        description = `New members get ${mention.role(currentId)} when they join. Run /aa with another role to change it.`;
      } else if (currentId) {
        description = 'The saved role no longer exists. Run /aa with a new role to replace it.';
        tone = 'warn';
      }
      return ephemeral(interaction, { embeds: [card({ title: 'Auto role', description, tone, footer: 'roles' })] });
    }

    // Validate the chosen role.
    if (role.id === guild.id) {
      ctx.refundCooldown();
      return deny(interaction, '@everyone cannot be the auto role. Pick another role.');
    }
    if (role.managed) {
      ctx.refundCooldown();
      return deny(interaction, 'That role is managed by an integration or bot and cannot be given by hand. Pick a regular role.');
    }

    ctx.roleMemory.setGuildAutoRole(guild.id, role.id, interaction.user);

    // Warn if the bot cannot actually assign it yet (role sits above the bot's highest role).
    const me = guild.members.me;
    const botHighest = me ? me.roles.highest.position : 0;
    const assignable = role.position < botHighest;

    const fields = assignable
      ? []
      : [
          field(
            'Bot role position',
            `The bot role must sit above ${mention.role(role.id)} to give it. Drag the bot role above that role in Server Settings, Roles.`,
          ),
        ];

    return ephemeral(interaction, {
      embeds: [
        card({
          title: 'Auto role',
          description: `Every new member on this server now gets ${mention.role(role.id)}.`,
          fields,
          tone: assignable ? 'ok' : 'warn',
          footer: 'roles',
        }),
      ],
    });
  },
};
