'use strict';

const { MessageFlags } = require('discord.js');
const { formatAccount } = require('../services/accounts');

const { COLORS, ephemeral, card, field, deny, mention, num, codeBlock } = require('../ui');

/**
 * Hand out one account from the given pool to the caller.
 * The account is sent in an ephemeral message so only the requester can see it.
 */
async function giveAccount(interaction, ctx, type) {
  const info = ctx.accounts.constructor.type(type);

  // Defer first so we have the full 15-minute follow-up window instead of the 3s reply window;
  // this way a slow save or a transient hiccup cannot make the reply fail and burn an account.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const account = ctx.accounts.claim(type, interaction.user);

  if (account === null) {
    ctx.refundCooldown(); // empty pool should not burn the user's cooldown
    return ephemeral(interaction, {
      embeds: [
        card({
          title: `${info.emoji} No ${info.label} accounts left`,
          description: 'The pool is empty, so try again after the manager refills it.',
          tone: 'warn',
          footer: info.label,
        }),
      ],
    });
  }

  const embed = card({
    title: `${info.emoji} ${info.label} account`,
    description: 'This account is yours alone and was never given out before.',
    fields: [field('Details', codeBlock(formatAccount(account)))],
    tone: 'ok',
    footer: info.label,
  });

  try {
    return await ephemeral(interaction, { embeds: [embed] });
  } catch (err) {
    // Delivery failed: return the account to the pool so it is never silently lost.
    ctx.accounts.unclaim(type, account);
    ctx.refundCooldown();
    console.error(`[35xw] failed to deliver ${type} account to ${interaction.user.id}; rolled back to pool: ${err.message}`);
    throw err;
  }
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
    return deny(interaction, `That file is over the ${mb} MB limit. Split it into smaller files and upload them one at a time.`);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let text;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    ctx.refundCooldown();
    return deny(interaction, `Could not download the file (${err.message}). Wait a moment and run the command again.`);
  }

  const result = ctx.accounts.refill(type, text, interaction.user);

  const nameNote =
    attachment.name && attachment.name.toLowerCase() !== info.file
      ? `\nThe file is named \`${attachment.name}\` instead of \`${info.file}\`. It was imported anyway.`
      : '';

  const embed = card({
    title: `${info.emoji} ${info.label} pool refilled`,
    description: `Uploaded by ${mention.user(interaction.user.id)}.${nameNote}`,
    fields: [
      field('Added', num(result.added), true),
      field('In stock', num(result.available), true),
      field('Given out so far', num(result.givenTotal), true),
      field('Already in stock', num(result.alreadyAvailable), true),
      field('Already given', num(result.alreadyGiven), true),
      field('Duplicates in file', num(result.duplicatesInFile), true),
    ],
    tone: result.added > 0 ? 'ok' : 'warn',
    footer: info.file,
  });

  return ephemeral(interaction, { embeds: [embed] });
}

module.exports = { COLORS, ephemeral, giveAccount, doRefill };
