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
            entry('/steam', 'Get a Steam account from the pool'),
            entry('/5m', 'Get a FiveM account from the pool'),
            entry('/combo', 'Get a Steam and a FiveM account at once'),
            entry('/stats', 'Show the Rastrošan board'),
            entry('/ping', 'Show the bot latency'),
            entry('/help', 'Show this list'),
          ]),
        ),
        field(
          'Tickets',
          lines([
            entry('OPEN TICKET', 'Open a ticket from the verification panel, one at a time per member'),
            entry('/close', 'Close the ticket and save its transcript (the opener or staff)'),
            entry('/add', 'Add a member or a role to the ticket (staff)'),
            entry('/v', 'Post the verification panel (staff)'),
          ]),
        ),
        field(
          'Roles',
          lines([
            entry('/aa', 'Set the role every new member gets, or show it (server owner)'),
            entry('/f', 'Give a role to every member, or remove it (admins)'),
            entry('/roles', 'Show the roles saved for a member, even after they left (staff)'),
          ]),
        ),
        field(
          'Server owner',
          lines([
            entry('/setup server', 'Rebuild the whole server layout after a preview and a confirmation'),
            entry('/n', 'Delete every channel except zavrseno after a confirmation'),
          ]),
        ),
        field(
          'Manager',
          lines([
            entry('/refills', 'Refill the Steam pool from steam.txt'),
            entry('/refill5', 'Refill the FiveM pool from fivem.txt'),
            entry('/b', 'Switch off cooldowns and ticket limits for yourself or a member, or list who has it'),
          ]),
        ),
      ],
    });

    await ephemeral(interaction, { embeds: [embed] });
  },
};
