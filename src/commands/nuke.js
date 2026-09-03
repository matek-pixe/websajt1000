'use strict';

const {
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
} = require('discord.js');
const { COLORS, ephemeral } = require('./_shared');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Guilds whose nuke is currently running. A fixed cooldown can be shorter than the delete loop on
// a large server, so this in-progress lock (not the cooldown) is what prevents a second concurrent run.
const nukingGuilds = new Set();

/** True if a channel is one Discord forbids deleting on Community servers. */
function isUndeletable(guild, channel) {
  return channel.id === guild.rulesChannelId || channel.id === guild.publicUpdatesChannelId;
}

/** Find an existing text channel with the final name, or create one. Returns null if it cannot be made. */
async function ensureKeeper(guild, name) {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name,
  );
  if (existing) return existing;
  try {
    return await guild.channels.create({ name, type: ChannelType.GuildText, reason: '35xw /n – kanal koji ostaje' });
  } catch (err) {
    console.warn(`[nuke] Cannot create keeper channel "${name}": ${err.message}`);
    return null;
  }
}

async function performNuke(interaction, ctx) {
  const guild = interaction.guild;
  await guild.channels.fetch().catch(() => {});

  const keeper = await ensureKeeper(guild, ctx.config.finalChannelName);
  if (!keeper) {
    return ephemeral(interaction, {
      content: `❌ Ne mogu napraviti/pronaći kanal \`${ctx.config.finalChannelName}\`. Provjeri da bot ima **Manage Channels**.`,
      components: [],
      embeds: [],
    });
  }

  // Everything except the keeper. Delete categories last so nothing is orphaned mid-run.
  const targets = [...guild.channels.cache.values()]
    .filter((c) => c && c.id !== keeper.id)
    .sort((a, b) => {
      const ac = a.type === ChannelType.GuildCategory ? 1 : 0;
      const bc = b.type === ChannelType.GuildCategory ? 1 : 0;
      return ac - bc;
    });

  let deleted = 0;
  const failed = [];
  for (const channel of targets) {
    if (isUndeletable(guild, channel)) {
      failed.push(`${channel.name} (obavezan Community kanal)`);
      continue;
    }
    try {
      await channel.delete('35xw /n – brisanje svih kanala');
      deleted += 1;
    } catch (err) {
      failed.push(`${channel.name} (${err.message})`);
    }
    await sleep(ctx.config.nukeDelayMs);
  }

  const doneEmbed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('💥 Završeno')
    .setDescription(
      `Svi kanali su obrisani jedan po jedan.\nOstao je samo ovaj kanal: <#${keeper.id}>.`,
    )
    .addFields(
      { name: 'Obrisano', value: String(deleted), inline: true },
      { name: 'Preskočeno', value: String(failed.length), inline: true },
    )
    .setFooter({ text: `35xw • /n • ${interaction.user.username}` })
    .setTimestamp();

  await keeper.send({ embeds: [doneEmbed] }).catch(() => {});

  const summary = new EmbedBuilder()
    .setColor(deleted > 0 ? COLORS.ok : COLORS.warn)
    .setTitle('✅ /n gotovo')
    .setDescription(`Ostao je kanal <#${keeper.id}> ("${ctx.config.finalChannelName}").`)
    .addFields(
      { name: 'Obrisano kanala', value: String(deleted), inline: true },
      { name: 'Nije obrisano', value: String(failed.length), inline: true },
    );
  if (failed.length > 0) {
    summary.addFields({ name: 'Nije obrisano (razlog)', value: failed.slice(0, 10).join('\n').slice(0, 1024) });
  }

  // The interaction token can expire on very large servers; the public "Završeno" message above
  // is the real confirmation, so a failed ephemeral edit here is not fatal.
  return ephemeral(interaction, { embeds: [summary], components: [] }).catch(() => {});
}

module.exports = {
  managerOnly: true,
  buttonPrefix: 'n:',
  data: new SlashCommandBuilder()
    .setName('n')
    .setDescription('MENADŽER: obriši SVE kanale i ostavi samo jedan tekstualni kanal "zavrseno".'),

  async execute(interaction, ctx) {
    const confirm = new ButtonBuilder()
      .setCustomId('n:confirm')
      .setLabel('DA, obriši sve')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('💥');
    const cancel = new ButtonBuilder()
      .setCustomId('n:cancel')
      .setLabel('Odustani')
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(confirm, cancel);

    const embed = new EmbedBuilder()
      .setColor(COLORS.danger)
      .setTitle('⚠️ Jesi li siguran?')
      .setDescription(
        `Ovo će **obrisati SVE kanale** na serveru, jedan po jedan, i ostaviti samo ` +
          `jedan tekstualni kanal **"${ctx.config.finalChannelName}"**.\n\nOvo se ne može poništiti.\n\n` +
          `ℹ️ Na Community serverima Discord ne dopušta brisanje obaveznih kanala (pravila i ` +
          `objave za zajednicu), pa oni ostaju uz "${ctx.config.finalChannelName}".`,
      );

    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    // The cooldown is only spent once the manager actually confirms.
    ctx.refundCooldown();
  },

  /** Handle the confirm / cancel buttons. */
  async handleButton(interaction, ctx) {
    if (!ctx.isManager(interaction.user)) {
      return interaction.reply({ content: '⛔ Samo menadžer smije koristiti ovo.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'n:cancel') {
      return interaction.update({
        content: '✅ Otkazano. Ništa nije obrisano.',
        embeds: [],
        components: [],
      });
    }

    if (interaction.customId === 'n:confirm') {
      // Re-check the per-user cooldown at confirm time so /n cannot be spammed (bypass skips it).
      const key = `n:${interaction.user.id}`;
      const left = ctx.isBypass(interaction.user) ? 0 : ctx.cooldown.remaining(key);
      if (left > 0) {
        return interaction.reply({
          content: `⏳ Pričekaj još ${Math.ceil(left / 1000)}s prije ponovnog /n.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (nukingGuilds.has(interaction.guildId)) {
        return interaction.reply({ content: '⏳ Brisanje je već u tijeku…', flags: MessageFlags.Ephemeral });
      }
      ctx.cooldown.hit(key);
      nukingGuilds.add(interaction.guildId);

      await interaction.update({
        content: '💥 Brišem sve kanale, jedan po jedan…',
        embeds: [],
        components: [],
      });
      try {
        await performNuke(interaction, ctx);
      } finally {
        nukingGuilds.delete(interaction.guildId);
      }
      return undefined;
    }

    return undefined;
  },
};
