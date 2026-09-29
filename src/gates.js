'use strict';

const { COPY } = require('./ui');

/** The server owner, or the bot manager. */
const isOwnerOrManager = (interaction, isManager) =>
  !!isManager(interaction.user) || !!(interaction.guild && interaction.guild.ownerId === interaction.user.id);

/**
 * Who may run a command. Returns the text to refuse with, or null when the command may run.
 *  requiresVerified  members with the verified role (see SetupService#verifiedGate)
 *  ownerOnly         the server owner and the manager
 *  managerOnly       the manager
 */
function refusal(command, interaction, { isManager, verifiedGate }) {
  const name = interaction.commandName;
  // Verified-only commands must run on a server, where roles can be checked.
  if ((!command.allowDM || command.requiresVerified) && !interaction.inGuild()) return COPY.serverOnly;
  if (command.managerOnly && !isManager(interaction.user)) return COPY.managerOnly(name);
  if (command.ownerOnly && !isOwnerOrManager(interaction, isManager)) return COPY.ownerOnly(name);
  if (command.requiresVerified) {
    const gate = verifiedGate(interaction);
    if (!gate.ok) return COPY.notVerified(gate);
  }
  return null;
}

module.exports = { refusal, isOwnerOrManager };
