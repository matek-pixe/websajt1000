'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { COLORS, ephemeral } = require('./_shared');

/** Split a list of lines into embed fields that respect Discord's 1024-char field limit. */
function fields(name, lines) {
  if (!lines.length) return [];
  const out = [];
  let buf = '';
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > 1000) {
      out.push(buf);
      buf = line;
    } else buf = next;
  }
  if (buf) out.push(buf);
  return out.map((value, i) => ({ name: i === 0 ? name : `${name} (${i + 1})`, value }));
}

/**
 * /setup — build (or repair) the whole server layout in one go:
 * roles, verify panel channel, tickets, general + voice for verified members, private owner
 * channels, the sensitive category, the read-only site channel. Safe to re-run; never deletes.
 */
module.exports = {
  managerOnly: false,
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Složi cijeli server: verify, ticketi, general, voice, priv, osjetljivo, role. Ponovljivo.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((o) => o.setName('verified').setDescription('Rola verificiranih članova (vidi general/voice, ne vidi verify).').setRequired(false))
    .addRoleOption((o) => o.setName('staff').setDescription('Ticket support rola (vidi tickete i transkripte).').setRequired(false))
    .addRoleOption((o) => o.setName('coowner').setDescription('Co-owner rola (vidi PRIV kanale uz vlasnika).').setRequired(false))
    .addRoleOption((o) => o.setName('sensitive').setDescription('Rola koja jedina vidi kategoriju OSJETLJIVO.').setRequired(false))
    .addBooleanOption((o) => o.setName('style_roles').setDescription('Preimenuj role u stil „✅ ıl VERIFIED" (zadano: da).').setRequired(false)),

  async execute(interaction, ctx) {
    const guild = interaction.guild;
    const member = interaction.member;
    const isOwner = guild.ownerId === interaction.user.id;
    const isAdmin = !!(member && member.permissions && member.permissions.has && member.permissions.has(PermissionFlagsBits.Administrator));
    if (!isOwner && !isAdmin && !ctx.isManager(interaction.user)) {
      ctx.refundCooldown();
      return ephemeral(interaction, '⛔ Samo **vlasnik servera** ili **administrator** može pokrenuti `/setup`.');
    }
    if (ctx.setup.isRunning(guild.id)) {
      ctx.refundCooldown();
      return ephemeral(interaction, '⏳ Setup već radi na ovom serveru, pričekaj da završi.');
    }

    // Building a server takes many API calls; defer so the 3-second reply window cannot expire.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const opts = {
      verified: interaction.options.getRole('verified'),
      staff: interaction.options.getRole('staff'),
      coowner: interaction.options.getRole('coowner'),
      sensitive: interaction.options.getRole('sensitive'),
      styleRoles: interaction.options.getBoolean('style_roles') !== false,
    };

    let res;
    try {
      res = await ctx.setup.run(guild, opts);
    } catch (err) {
      console.error('[35xw] /setup failed:', err);
      return ephemeral(interaction, `❌ Setup je pukao: ${err.message}`);
    }

    if (!res.ok) {
      if (res.reason === 'missing_permissions') {
        return ephemeral(
          interaction,
          '❌ Botu fale dozvole. Daj mu **Administrator** (ili barem **Manage Channels** + **Manage Roles**) i povuci njegovu rolu na vrh liste rola.',
        );
      }
      return ephemeral(interaction, '⏳ Setup već radi na ovom serveru.');
    }

    const r = res.report;
    const embed = new EmbedBuilder()
      .setColor(r.errors.length ? COLORS.warn : COLORS.ok)
      .setTitle(r.errors.length ? '🛠️ Server setup — gotovo, uz greške' : '🛠️ Server setup — gotovo')
      .setDescription(
        `✅ napravljeno **${r.created.length}** · 🔧 popravljeno **${r.updated.length}** · ✔️ već u redu **${r.ok.length}**` +
          (r.errors.length ? ` · ❌ greške **${r.errors.length}**` : ''),
      )
      .addFields(
        ...fields('✅ Napravljeno', r.created),
        ...fields('🔧 Popravljeno', r.updated),
        ...fields('❌ Greške', r.errors),
        ...fields('ℹ️ Napomene', r.warnings.map((w) => `• ${w}`)),
      )
      .setFooter({ text: '35xw • /setup možeš ponoviti bilo kad, provjerit će i popraviti što treba' })
      .setTimestamp();

    return ephemeral(interaction, { embeds: [embed] });
  },
};
