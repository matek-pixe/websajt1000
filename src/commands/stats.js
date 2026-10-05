'use strict';

const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { card, field, mention, num, plural, time } = require('../ui');

/** Boosts needed for level 1, 2 and 3. */
const BOOST_STEPS = [2, 7, 14];

/** The boost level in words, with how far the next one is. */
function boostText(tier, boosts, boosters) {
  const level = tier ? `Level ${tier}` : 'No level yet';
  const who = boosters ? ` from ${plural(boosters, 'member')}` : '';
  const next = tier >= BOOST_STEPS.length ? 'Highest level reached' : `${plural(Math.max(0, BOOST_STEPS[tier] - boosts), 'more boost')} for Level ${tier + 1}`;
  return `**${level}**\n${plural(boosts, 'boost')}${who}\n${next}`;
}

const TEXT = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);
const VOICE = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** /stats: how big the server is and how boosted. Shown to everyone in the channel. */
module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder().setName('stats').setDescription('Show the members, the boost level and more about this server'),

  async execute(interaction, ctx) {
    const guild = interaction.guild;

    // memberCount is kept up to date by the gateway; fall back to a fetch if it looks unset.
    let total = guild.memberCount;
    if (!total) {
      const fetched = await guild.members.fetch().catch(() => null);
      total = fetched ? fetched.size : 0;
    }
    const cached = [...guild.members.cache.values()];
    const bots = cached.filter((m) => m.user && m.user.bot).length;
    const boosters = cached.filter((m) => m.premiumSince).length;

    const verifiedId = ctx.setup ? ctx.setup.getVerifiedRoleId(guild) : null;
    const verifiedRole = verifiedId ? guild.roles.cache.get(verifiedId) : null;
    const members = [`**${num(total)}**`, `${num(Math.max(0, total - bots))} people, ${num(bots)} bots`];
    if (verifiedRole) members.push(`${num(verifiedRole.members.size)} verified`);

    const channels = [...guild.channels.cache.values()];
    const count = (set) => channels.filter((c) => set.has(c.type)).length;
    const categories = channels.filter((c) => c.type === ChannelType.GuildCategory).length;

    const embed = card({
      title: guild.name,
      description: guild.description || undefined,
      fields: [
        field('Members', members.join('\n'), true),
        field('Boost', boostText(guild.premiumTier || 0, guild.premiumSubscriptionCount || 0, boosters), true),
        field('Open tickets', num(ctx.tickets.openCount(guild.id)), true),
        field('Channels', `${num(count(TEXT))} text, ${num(count(VOICE))} voice, ${num(categories)} categories`, true),
        field('Roles', num(Math.max(0, guild.roles.cache.size - 1)), true),
        field('Emoji and stickers', `${plural(guild.emojis.cache.size, 'emoji', 'emoji')}, ${plural(guild.stickers ? guild.stickers.cache.size : 0, 'sticker')}`, true),
        field('Created', `${time(guild.createdTimestamp, 'D')} (${time(guild.createdTimestamp, 'R')})`, true),
        field('Owner', mention.user(guild.ownerId), true),
      ],
      footer: 'stats',
      timestamp: true,
      thumbnail: guild.iconURL({ size: 256 }),
    });

    // Public on purpose: everyone in the channel can see how the server is doing.
    await interaction.reply({ embeds: [embed] });
  },

  _boostText: boostText,
};
