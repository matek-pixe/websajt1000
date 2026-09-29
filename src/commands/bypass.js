'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ephemeral, mention, time, lines } = require('../ui');

const LIMITS_LIFTED = 'No command cooldown, no open ticket limit and no wait after closing a ticket.';

/**
 * /b: bypass ("god mode"). Manager only.
 *   /b                      toggle your own bypass
 *   /b mode:On|Off          set your own bypass
 *   /b user:@someone        give that member bypass (or take it away if they have it)
 *   /b user:@someone mode:On|Off
 *   /b mode:List            who has bypass right now
 */
module.exports = {
  managerOnly: true,
  noCooldown: true, // toggling the switch must never be blocked by a limit
  allowDM: true,
  data: new SlashCommandBuilder()
    .setName('b')
    .setDescription('Lift every limit for yourself or a member (manager only)')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Member to give or remove bypass for (leave empty for yourself)').setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('On or off (leave empty to toggle), or List to show who has bypass')
        .setRequired(false)
        .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }, { name: 'List', value: 'list' }),
    ),

  async execute(interaction, ctx) {
    const mode = interaction.options.getString('mode');
    const target = interaction.options.getUser('user');
    const managerId = ctx.config.manager.id;
    const reply = (embed) => ephemeral(interaction, { embeds: [embed] });

    // ---- who has it ----
    if (mode === 'list') {
      const rows = ctx.bypass.list();
      const members = rows.map((r) => `${mention.user(r.id)}${r.at ? ` since ${time(new Date(r.at).getTime(), 'd')}` : ''}`);
      return reply(
        card({
          title: 'Bypass list',
          fields: [
            field('Your switch', ctx.bypass.isEnabled() ? 'On' : 'Off'),
            field(`Given to (${rows.length})`, lines(members, { max: 15, limit: 1024 })),
          ],
          footer: 'bypass',
        }),
      );
    }

    // ---- someone else ----
    if (target && target.id !== managerId) {
      let on;
      if (mode === 'on') on = ctx.bypass.grant(target.id, interaction.user.id) && true;
      else if (mode === 'off') on = !ctx.bypass.revoke(target.id) && false;
      else on = ctx.bypass.toggleUser(target.id, interaction.user.id);

      return reply(
        on
          ? card({
              title: 'Bypass granted',
              description:
                `${mention.user(target.id)} now skips every limit. ${LIMITS_LIFTED}\n\n` +
                `Remove it with \`/b user:@${target.username} mode:Off\`.`,
              tone: 'ok',
              footer: 'bypass',
            })
          : card({
              title: 'Bypass removed',
              description: `${mention.user(target.id)} is back to the normal limits.`,
              tone: 'ok',
              footer: 'bypass',
            }),
      );
    }

    // ---- yourself ----
    let on;
    if (mode === 'on') on = ctx.bypass.set(true);
    else if (mode === 'off') on = ctx.bypass.set(false);
    else on = ctx.bypass.toggle();

    return reply(
      on
        ? card({
            title: 'Bypass on',
            description:
              `Every limit is lifted for you. ${LIMITS_LIFTED}\n\n` +
              'Run `/b` again to turn it off, or `/b user:@name` to give it to a member.',
            tone: 'ok',
            footer: 'bypass',
          })
        : card({ title: 'Bypass off', description: 'Normal limits apply to you again.', tone: 'ok', footer: 'bypass' }),
    );
  },
};
