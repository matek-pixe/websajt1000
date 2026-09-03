'use strict';

const { Collection } = require('discord.js');

const modules = [
  require('./steam'),
  require('./fivem'),
  require('./refills'),
  require('./refill5'),
  require('./nuke'),
  require('./stats'),
  require('./autorole'),
  require('./help'),
];

/** name -> command module */
const commands = new Collection();
for (const command of modules) {
  commands.set(command.data.name, command);
}

/** JSON payloads for registration with the Discord API. */
function toJSON() {
  return modules.map((c) => c.data.toJSON());
}

/** Find the command that owns a given button customId (by its buttonPrefix). */
function commandForButton(customId) {
  return modules.find((c) => c.buttonPrefix && customId.startsWith(c.buttonPrefix)) || null;
}

module.exports = { commands, modules, toJSON, commandForButton };
