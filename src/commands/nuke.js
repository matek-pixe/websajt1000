'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');
const { card, field, ephemeral, deny, warn, mention, num, lines, COPY } = require('../ui');

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
    return await guild.channels.create({ name, type: ChannelType.GuildText, reason: '35xw /n: channel to keep' });
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
    return deny(
      interaction,
      `Could not find or create a channel named ${ctx.config.finalChannelName}. Give the bot the Manage Channels permission and run /n again.`,
    );
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
      failed.push(`${channel.name} (required by Community)`);
      continue;
    }
    try {
      await channel.delete('35xw /n: delete all channels');
      deleted += 1;
    } catch (err) {
      failed.push(`${channel.name} (${err.message})`);
    }
    await sleep(ctx.config.nukeDelayMs);
  }

  const doneCard = card({
    title: 'Server cleared',
    description: 'Every channel was deleted one by one, except this one.',
    fields: [
      field('Deleted', num(deleted), true),
      field('Not deleted', num(failed.length), true),
      field('Run by', mention.user(interaction.user.id), true),
    ],
    tone: 'ok',
    footer: 'channels',
    timestamp: true,
  });

  await keeper.send({ embeds: [doneCard] }).catch(() => {});

  const summary = card({
    title: deleted > 0 ? 'Channels deleted' : 'No channels deleted',
    description: `The channel ${mention.channel(keeper.id)} was kept.`,
    fields: [
      field('Deleted', num(deleted), true),
      field('Not deleted', num(failed.length), true),
      ...(failed.length > 0 ? [field('Details', lines(failed, { max: 10, limit: 1024 }))] : []),
    ],
    tone: deleted > 0 ? 'ok' : 'warn',
    footer: 'channels',
  });

  // The interaction token can expire on very large servers; the public message above
  // is the real confirmation, so a failed ephemeral edit here is not fatal.
  return ephemeral(interaction, { embeds: [summary], components: [] }).catch(() => {});
}

module.exports = {
  managerOnly: false,
  ownerOnly: true, // the server owner (and the manager); no admin may run this
  buttonPrefix: 'n:',
  data: new SlashCommandBuilder()
    .setName('n')
    .setDescription('Delete every channel except zavrseno (owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, ctx) {
    const confirm = new ButtonBuilder()
      .setCustomId('n:confirm')
      .setLabel('Delete everything')
      .setStyle(ButtonStyle.Danger);
    const cancel = new ButtonBuilder()
      .setCustomId('n:cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(confirm, cancel);

    const embed = card({
      title: 'Delete every channel?',
      description:
        `Every channel on the server will be deleted one by one. Only a text channel named **${ctx.config.finalChannelName}** stays. ` +
        'This cannot be undone.\n\n' +
        'On Community servers Discord keeps the rules and updates channels, so those stay too.',
      footer: 'channels',
    });

    await ephemeral(interaction, { embeds: [embed], components: [row] });
    // The cooldown is only spent once the manager actually confirms.
    ctx.refundCooldown();
  },

  /** Handle the confirm / cancel buttons. */
  async handleButton(interaction, ctx) {
    if (!ctx.isOwnerOrManager()) {
      return deny(interaction, COPY.ownerOnly('n'));
    }

    if (interaction.customId === 'n:cancel') {
      return interaction.update({
        embeds: [card({ title: 'Nothing deleted', description: 'Every channel is still in place.', footer: 'channels' })],
        components: [],
      });
    }

    if (interaction.customId === 'n:confirm') {
      // Re-check the per-user cooldown at confirm time so /n cannot be spammed (bypass skips it).
      const key = `n:${interaction.user.id}`;
      const left = ctx.isBypass(interaction.user) ? 0 : ctx.cooldown.remaining(key);
      if (left > 0) {
        return deny(interaction, COPY.cooldown(Math.ceil(left / 1000), 'n'));
      }
      if (nukingGuilds.has(interaction.guildId)) {
        return warn(interaction, 'A deletion is already running on this server. Wait for it to finish.');
      }
      ctx.cooldown.hit(key);
      nukingGuilds.add(interaction.guildId);

      await interaction.update({
        embeds: [
          card({
            title: 'Deleting channels',
            description: 'Working through the server one channel at a time. The result appears here when it is done.',
            footer: 'channels',
          }),
        ],
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
