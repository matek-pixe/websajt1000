'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { card, field, ephemeral, deny, mention, num, lines, plural } = require('../ui');

/** What was found and what was done, in plain words. */
function resultCard(res) {
  const m = res.member;
  const v = res.verify;
  const fields = [];
  let problems = 0;

  // ---- member role ----
  if (!m.role) {
    problems += 1;
    fields.push(field('Member role', m.problem));
  } else {
    const what = m.created ? 'was missing, I made it again' : m.renamed ? 'found, the name is now written in small letters' : 'found';
    const given = m.problem ? m.problem : `Given to ${num(m.given)} members, ${num(m.already)} already had it${m.failedCount ? `, ${num(m.failedCount)} failed` : ''}. Bots skipped.`;
    if (m.problem || m.failedCount) problems += 1;
    fields.push(field('Member role', `${mention.role(m.role.id)} ${what}. ${given} New members get exactly this role.`));
    if (m.failed.length) fields.push(field('First errors', lines(m.failed, { max: 5, limit: 900 })));
  }

  // ---- verify ----
  if (!v.found) {
    problems += 1;
    fields.push(field('Verify category', 'I could not find a verify category or channel on this server. If /setup server was never run here, run it first.'));
  } else {
    const bits = [];
    bits.push(`${v.category ? `**${v.category}**` : `**${v.channel}**`} found.`);
    if (v.opened.length) bits.push(`New people could not see ${plural(v.opened.length, 'channel')} there, so I opened ${v.opened.length === 1 ? 'it' : 'them'} for ${v.opened.some((o) => o.how === 'the member role') ? 'everyone and the member role' : 'everyone'}: they can look and read, not write.`);
    else bits.push(`New people can already see it${v.fine > 1 ? ` (${plural(v.fine, 'channel')} checked)` : ''}.`);
    if (v.panel === 'found') bits.push('The ticket button is there.');
    else if (v.panel === 'posted') bits.push('The ticket button was missing, I posted it again.');
    else if (v.panel === 'unknown') bits.push('I could not read the channel to check the ticket button.');
    problems += v.failed.length;
    fields.push(field('Verify category', bits.join(' ')));
    if (v.failed.length) fields.push(field('Could not change', lines(v.failed.map((f) => `${f.name}: ${f.error}`), { max: 6, limit: 900 })));
  }

  return card({
    title: problems ? 'Fix done, with problems' : 'Fix done',
    fields,
    tone: problems ? 'warn' : 'ok',
    footer: 'fix',
  });
}

/**
 * /fix: get people back in. Gives everyone the member role (making it again if it is gone) and makes sure
 * new people can see the verify category and its ticket button. It only ever adds, nothing is deleted.
 */
module.exports = {
  adminOnly: true,
  audit: true, // leaves a line in the server log
  data: new SlashCommandBuilder()
    .setName('fix')
    .setDescription('Give everyone the member role and let new people see the verify category (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;

    let last = 0;
    let editable = true;
    const onProgress = async ({ done, total }) => {
      if (!editable || Date.now() - last < 4000) return;
      last = Date.now();
      try {
        await interaction.editReply({ embeds: [card({ title: 'Giving the member role', description: `${num(done)} of ${num(total)} done.`, tone: 'warn', footer: 'fix' })] });
      } catch {
        editable = false;
      }
    };

    const release = ctx.logs ? ctx.logs.hold(guild.id) : () => {}; // one line instead of a line per member
    let res;
    try {
      res = await ctx.fix.run(guild, interaction.user, { onProgress });
    } catch (err) {
      console.error('[35xw] /fix failed:', err);
      res = { ok: false, reason: 'error', error: err.message };
    } finally {
      release();
    }

    if (!res.ok) {
      ctx.refundCooldown();
      const text =
        res.reason === 'busy' ? 'Another /fix is still running.' : res.reason === 'permissions' ? 'I need the Manage Roles permission.' : `Something went wrong: ${res.error}. Try again in a moment.`;
      return deny(interaction, text);
    }
    const embed = resultCard(res);
    if (ctx.logs) ctx.logs.post(guild, card({ title: 'Members fixed', description: `${mention.user(interaction.user.id)} ran /fix.`, fields: embed.data.fields || [], tone: 'warn', footer: 'logs', timestamp: true }));
    return ephemeral(interaction, { embeds: [embed] });
  },

  _resultCard: resultCard,
};
