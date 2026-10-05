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
            entry('/steam', 'Get a Steam account that was never given out'),
            entry('/5m', 'Get a FiveM account that was never given out'),
            entry('/combo', 'Get a Steam and a FiveM account at once'),
            entry('/stats', 'Show the Rastrošan board and the top members'),
            entry('/ping', 'Show the bot latency'),
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
          'Roles',
          lines([
            entry('/aa', 'Set the role every new member gets, or show it (owner only)'),
            entry('/f', 'Give or remove a role for every member (admins only)'),
            entry('/roles', 'Show the roles the bot remembers for a member, even after they left (staff only)'),
            entry('/ban', 'Ban a member and record the reason (admins only)'),
            entry('/fix', 'Give everyone the member role and make sure new people can see the verify category (admins only)'),
            entry('/lock', 'Lock this channel so only admins and the owner can write (admins only)'),
            entry('/unlock', 'Open a channel that was locked with /lock (admins only)'),
          ]),
        ),
        field(
          'Server owner',
          lines([
            entry('/setup server', 'Rebuild the server layout and roles after a preview and a confirmation'),
            entry('/n', 'Delete every channel except zavrseno after a confirmation'),
            entry('/sos', 'Emergency: save the server, hide every channel from everyone but the owner, restore with /sos end'),
            entry('/antinuke', 'Show or switch the anti-nuke protection that bans mass channel deleters'),
          ]),
        ),
        field(
          'Manager',
          lines([
            entry('/refills', 'Refill the Steam pool from a steam.txt file'),
            entry('/refill5', 'Refill the FiveM pool from a fivem.txt file'),
            entry('/b', 'Lift every limit for yourself or a member, or list who has it'),
          ]),
        ),
      ],
    });

    await ephemeral(interaction, { embeds: [embed] });
  },
};
