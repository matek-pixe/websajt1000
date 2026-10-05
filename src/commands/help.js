'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ephemeral, lines, plural } = require('../ui');

// One entry per command: the command in code style, then what it does.
const entry = (command, text) => `\`${command}\`  ${text}`;

/** /help: list every command and what it does. */
module.exports = {
  managerOnly: false,
  requiresVerified: true, // only members holding the VERIFIED role (given after a ticket)
  data: new SlashCommandBuilder().setName('help').setDescription('List every command and what it does'),

  async execute(interaction, ctx) {
    const seconds = Math.round(ctx.config.cooldownMs / 1000);

    const embed = card({
      title: 'Commands',
      description:
        `Each command has a cooldown of ${plural(seconds, 'second')}. ` +
        'Account replies are private, so only you can see them.',
      fields: [
        field(
          'Verified members',
          lines([
            entry('/combo', 'Get a Steam and a FiveM account at once'),
            entry('/stats', 'Show the members, the boost level and more about this server'),
            entry('/help', 'Show this list'),
          ]),
        ),
        field(
          'Tickets',
          lines([
            entry('OPEN TICKET', 'Open a ticket from the verification panel, one at a time per member'),
            entry('/close', 'Close the current ticket and save the transcript (the opener or staff)'),
            entry('/add', 'Add a member or role to the current ticket (staff only)'),
            entry('/ticketalert', 'Send a test ticket alert and show what works (owner only)'),
            entry('/v', 'Post the verification panel with a ticket button (staff only)'),
          ]),
        ),
        field(
          'Admins',
          lines([
            entry('/ban', 'Ban a member and record the reason (admins only)'),
            entry('/lock', 'Lock this channel so only admins and the owner can write (admins only)'),
            entry('/unlock', 'Open a channel that was locked with /lock (admins only)'),
          ]),
        ),
        field(
          'Server owner',
          lines([
            entry('/setup server', 'Rebuild the server layout and roles after a preview and a confirmation'),
            entry('/sos', 'Emergency: save the server, hide every channel from everyone but the owner, restore with /sos end'),
            entry('/antinuke', 'Show or switch the anti-nuke protection that bans mass channel deleters'),
          ]),
        ),
        field('Manager', lines([entry('/b', 'Lift every limit for yourself or a member, or list who has it')])),
      ],
    });

    await ephemeral(interaction, { embeds: [embed] });
  },
};
