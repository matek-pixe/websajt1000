'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS } = require('./_shared');

/**
 * /aa — the server owner picks the role that every new member gets on THIS server.
 * With no role given, it shows the current setting instead.
 */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('aa')
    .setDescription('Postavi rolu koju svaki novi član automatski dobije na ovom serveru.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((opt) =>
      opt
        .setName('role')
        .setDescription('Rola koju novi članovi dobiju. Ostavi prazno da vidiš trenutnu.')
        .setRequired(false),
    ),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    const isOwner = guild.ownerId === interaction.user.id;
    const isManager = ctx.isManager(interaction.user);

    if (!isOwner && !isManager) {
      ctx.refundCooldown();
      return interaction.reply({
        content: '⛔ Samo **vlasnik servera** može postaviti auto rolu.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const role = interaction.options.getRole('role');

    // No role supplied -> show the current setting.
    if (!role) {
      ctx.refundCooldown();
      const currentId = ctx.roleMemory.getGuildAutoRole(guild.id);
      const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('⚙️ Auto rola');
      if (currentId && guild.roles.cache.has(currentId)) {
        embed.setDescription(`Trenutna auto rola je <@&${currentId}>.\nNovi članovi je automatski dobiju.`);
      } else if (currentId) {
        embed.setColor(COLORS.warn).setDescription('Postavljena auto rola više ne postoji. Postavi novu s `/aa @rola`.');
      } else {
        embed.setDescription('Auto rola nije postavljena za ovaj server.\nPostavi je s `/aa @rola`.');
      }
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // Validate the chosen role.
    if (role.id === guild.id) {
      ctx.refundCooldown();
      return interaction.reply({ content: '❌ Ne možeš koristiti `@everyone` kao auto rolu.', flags: MessageFlags.Ephemeral });
    }
    if (role.managed) {
      ctx.refundCooldown();
      return interaction.reply({
        content: '❌ Ta rola je kojom upravlja integracija/bot i ne može se ručno dodijeliti. Odaberi običnu rolu.',
        flags: MessageFlags.Ephemeral,
      });
    }

    ctx.roleMemory.setGuildAutoRole(guild.id, role.id, interaction.user);

    // Warn if the bot cannot actually assign it yet (role sits above the bot's highest role).
    const me = guild.members.me;
    const botHighest = me ? me.roles.highest.position : 0;
    const assignable = role.position < botHighest;

    const embed = new EmbedBuilder()
      .setColor(assignable ? COLORS.ok : COLORS.warn)
      .setTitle('✅ Auto rola postavljena')
      .setDescription(`Od sada svaki novi član na ovom serveru dobije <@&${role.id}>.`)
      .setFooter({ text: `35xw • postavio ${interaction.user.username}` })
      .setTimestamp();

    if (!assignable) {
      embed.addFields({
        name: '⚠️ Pažnja',
        value:
          `Rola bota mora biti **iznad** role <@&${role.id}> da bi je bot mogao dodijeliti.\n` +
          'Idi u Server Settings → Roles i povuci rolu bota iznad te role.',
      });
    }

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
