'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');

const COLORS = {
  ok: 0x2ecc71,
  info: 0x5865f2,
  warn: 0xf1c40f,
  danger: 0xe74c3c,
};

/** Reply (or edit the reply) with an ephemeral message, whichever is valid for the interaction's state. */
async function ephemeral(interaction, payload) {
  const data = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (interaction.deferred || interaction.replied) {
    // Ephemeral state is fixed at defer/reply time; editReply must not carry the flag.
    delete data.flags;
    return interaction.editReply(data);
  }
  data.flags = MessageFlags.Ephemeral;
  return interaction.reply(data);
}

/**
 * Hand out one account from the given pool to the caller.
 * The account is sent in an ephemeral message so only the requester can see it.
 */
async function giveAccount(interaction, ctx, type) {
  const info = ctx.accounts.constructor.type(type);
  const account = ctx.accounts.claim(type, interaction.user);

  if (account === null) {
    ctx.refundCooldown(); // empty pool should not burn the user's cooldown
    const embed = new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`${info.emoji} Nema ${info.label} računa`)
      .setDescription(
        `Trenutno nema slobodnih **${info.label}** računa.\n` +
          `Pričekaj da menadžer napuni zalihu pa pokušaj ponovno.`,
      );
    return ephemeral(interaction, { embeds: [embed] });
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.ok)
    .setTitle(`${info.emoji} Tvoj ${info.label} račun`)
    .setDescription('Ovaj račun je samo tvoj i nikada nije bio dan nikome drugom. Čuvaj ga.')
    .addFields({ name: 'Račun', value: '```\n' + account + '\n```' })
    .setFooter({ text: `35xw • ${info.label}` })
    .setTimestamp();

  return ephemeral(interaction, { embeds: [embed] });
}

/**
 * Manager-only: download an uploaded accounts file and merge it into a pool.
 * Skips accounts that were ever given out or are already waiting, so used accounts never come back.
 */
async function doRefill(interaction, ctx, type) {
  const info = ctx.accounts.constructor.type(type);
  const attachment = interaction.options.getAttachment('file', true);

  if (attachment.size > ctx.config.maxRefillFileBytes) {
    ctx.refundCooldown();
    const mb = (ctx.config.maxRefillFileBytes / (1024 * 1024)).toFixed(0);
    return ephemeral(interaction, `❌ Datoteka je prevelika. Maksimum je ${mb} MB.`);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let text;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    ctx.refundCooldown();
    return ephemeral(interaction, `❌ Nisam mogao preuzeti datoteku: ${err.message}`);
  }

  const result = ctx.accounts.refill(type, text, interaction.user);

  const nameNote =
    attachment.name && attachment.name.toLowerCase() !== info.file
      ? `\n⚠️ Datoteka se zove \`${attachment.name}\`, očekivano \`${info.file}\` (svejedno je učitano).`
      : '';

  const embed = new EmbedBuilder()
    .setColor(result.added > 0 ? COLORS.ok : COLORS.warn)
    .setTitle(`${info.emoji} ${info.label} zaliha napunjena`)
    .setDescription(`Učitao: <@${interaction.user.id}>${nameNote}`)
    .addFields(
      { name: 'Novih računa', value: String(result.added), inline: true },
      { name: 'Slobodno sada', value: String(result.available), inline: true },
      { name: 'Ukupno podijeljeno', value: String(result.givenTotal), inline: true },
      { name: 'Već u zalihi', value: String(result.alreadyAvailable), inline: true },
      { name: 'Već podijeljeni (preskočeno)', value: String(result.alreadyGiven), inline: true },
      { name: 'Duplikati u datoteci', value: String(result.duplicatesInFile), inline: true },
    )
    .setFooter({ text: `35xw • spremljeno u ${info.file}` })
    .setTimestamp();

  return ephemeral(interaction, { embeds: [embed] });
}

module.exports = { COLORS, ephemeral, giveAccount, doRefill };
