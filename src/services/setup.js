'use strict';

const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { panelEmbed, panelRow, BUTTONS } = require('./tickets');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

const P = PermissionFlagsBits;
const TEXT_KINDS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const VOICE_KINDS = [ChannelType.GuildVoice];

/** Naming style used for everything /setup creates: "<emoji> ıl NAME". */
const STYLE = (emoji, label) => `${emoji} ıl ${label}`;
/** Braille blank: Discord trims real spaces, this survives and renders as an empty name. */
const BLANK_ROLE_NAME = '\u2800';

// ---------- pure helpers (unit-tested) ----------

/**
 * Reduce a channel/role name to its bare word so decorations never matter when matching what is
 * already on the server: "🎫 ıl VERIFY", "🎫ticket", "VERIFY" and "verify" all compare by word.
 */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ıl/g, '')
    .replace(/[^a-z0-9#.]+/g, '');
}

/** True for a role whose name is only whitespace / invisible characters. */
function isBlankName(s) {
  return /^[\s\u2800\u200b\u200c\u200d\u2060\ufeff]*$/.test(String(s || ''));
}

const ROLE_SPECS = Object.freeze({
  verified: { name: STYLE('✅', 'VERIFIED'), color: 0x57f287, match: ['verified', 'verify', 'verificiran', 'verificirani'] },
  staff: { name: STYLE('🎫', 'TICKET SUPPORT'), color: 0x5865f2, match: ['ticketsupport', 'support', 'staff', 'ticketstaff'] },
  coowner: { name: STYLE('👑', 'CO-OWNER'), color: 0xf1c40f, match: ['coowner', 'suvlasnik'] },
  // Plain member tiers: they just have to exist (no channel permissions attached).
  friend: { name: STYLE('🤝', 'FRIEND'), color: 0x3498db, match: ['friend', 'friends', 'prijatelj', 'prijatelji'] },
  vip: { name: STYLE('💎', 'VIP'), color: 0xe91e63, match: ['vip', 'vips'] },
  // The sensitive role is whatever the owner already uses for admin-only things: never renamed.
  sensitive: { name: STYLE('🔐', 'OSJETLJIVO'), color: 0xe74c3c, match: ['osjetljivo', 'sensitive'], noRename: true },
  blank: { name: BLANK_ROLE_NAME, color: null, match: [], blank: true },
});

/**
 * The server layout, top to bottom. `match` lists the bare words an existing channel may have so
 * it is adopted (renamed / moved / re-permissioned) instead of duplicated. `perms` names the
 * permission set from permsFor(). The tickets category is owned by the ticket service.
 */
function buildPlan(siteName) {
  const T = ChannelType;
  const voice = (n) => ({
    key: `voice${n}`,
    name: STYLE('🔊', `VOICE #${n}`),
    type: T.GuildVoice,
    match: [`voice#${n}`, `voice${n}`, `call#${n}`, `call${n}`, 'voice', 'call'],
    perms: 'verified',
  });
  return {
    top: [
      {
        key: 'site',
        name: STYLE('🌐', siteName),
        type: T.GuildText,
        kinds: TEXT_KINDS,
        match: [siteName, siteName.replace(/\./g, ''), '35xw', 'site', 'stranica', 'website'],
        perms: 'readonly',
        anywhere: true,
      },
    ],
    categories: [
      {
        key: 'verify',
        name: STYLE('✅', 'VERIFY'),
        match: ['verify', 'verification', 'verifikacija'],
        perms: 'verify',
        channels: [
          {
            key: 'verify_ch',
            name: STYLE('🎫', 'VERIFY'),
            type: T.GuildText,
            match: ['verify', 'ticket', 'verification', 'verifikacija'],
            perms: 'verify',
            panel: true,
          },
        ],
      },
      { key: 'tickets', managed: true },
      {
        key: 'general',
        name: STYLE('🌍', 'GENERAL'),
        match: ['general', 'main', 'glavno'],
        perms: 'verified',
        channels: [
          { key: 'chat', name: STYLE('💬', 'CHAT'), type: T.GuildText, match: ['chat', 'general'], perms: 'verified' },
          { key: 'cmds', name: STYLE('🤖', 'CMDS'), type: T.GuildText, match: ['cmds', 'commands', 'cmd', 'botcmds', 'bot'], perms: 'verified' },
          { key: 'server', name: STYLE('📢', 'SERVER'), type: T.GuildText, match: ['server', 'info'], perms: 'verified' },
          { key: 'dump', name: STYLE('🗑️', 'DUMP'), type: T.GuildText, match: ['dump', 'spam'], perms: 'verified' },
        ],
      },
      {
        key: 'voice',
        name: STYLE('🔊', 'VOICE'),
        match: ['voice', 'call', 'calls', 'voicechannels'],
        perms: 'verified',
        channels: [voice(1), voice(2), voice(3)],
      },
      {
        key: 'private',
        name: STYLE('🔒', 'PRIVATE'),
        match: ['private', 'priv', 'owner', 'owners'],
        perms: 'private',
        channels: [
          { key: 'priv_voice', name: STYLE('🔒', 'PRIV'), type: T.GuildVoice, match: ['priv', 'private', 'owner'], perms: 'private' },
          { key: 'priv_text', name: STYLE('🔒', 'PRIV-CHAT'), type: T.GuildText, match: ['privchat', 'priv', 'private', 'owner'], perms: 'private' },
        ],
      },
      {
        key: 'sensitive',
        name: STYLE('🔐', 'OSJETLJIVO'),
        match: ['osjetljivo', 'sensitive', 'osjetljivi'],
        perms: 'sensitive',
        sync: true, // every channel already inside it is synced to the category
        channels: [],
      },
    ],
  };
}

const FULL = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.Connect, P.Speak];
const READ = [P.ViewChannel, P.ReadMessageHistory];
const NO_POST = [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads];

/**
 * Permission overwrites for one permission set. Discord only lets a bot set overwrites for
 * permissions it holds itself, so `held` filters every list (Administrator holds everything).
 *
 *  verify    everyone can see the panel but not type; VERIFIED members no longer see it;
 *            staff still can (a role allow beats a role deny in Discord's precedence).
 *  verified  hidden from everyone except VERIFIED (+ staff, manager, bot).
 *  private   owner + CO-OWNER only.
 *  sensitive the sensitive role only.
 *  readonly  everyone sees it, nobody but the bot can post.
 */
function permsFor(kind, ids, held) {
  const H = (flags) => held(flags);
  const bot = { id: ids.bot, allow: H(FULL) };
  const rows = [];
  switch (kind) {
    case 'verify':
      rows.push({ id: ids.everyone, allow: H(READ), deny: H(NO_POST) });
      if (ids.verified) rows.push({ id: ids.verified, deny: H([P.ViewChannel]) });
      if (ids.staff) rows.push({ id: ids.staff, allow: H([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]) });
      if (ids.manager) rows.push({ id: ids.manager, allow: H([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]) });
      break;
    case 'verified':
      rows.push({ id: ids.everyone, deny: H([P.ViewChannel]) });
      if (ids.verified) rows.push({ id: ids.verified, allow: H(FULL) });
      if (ids.staff) rows.push({ id: ids.staff, allow: H(FULL) });
      if (ids.manager) rows.push({ id: ids.manager, allow: H(FULL) });
      break;
    case 'private':
      rows.push({ id: ids.everyone, deny: H([P.ViewChannel]) });
      if (ids.owner) rows.push({ id: ids.owner, allow: H(FULL) });
      if (ids.coowner) rows.push({ id: ids.coowner, allow: H(FULL) });
      break;
    case 'sensitive':
      rows.push({ id: ids.everyone, deny: H([P.ViewChannel]) });
      if (ids.sensitive) rows.push({ id: ids.sensitive, allow: H(FULL) });
      break;
    case 'readonly':
      rows.push({ id: ids.everyone, allow: H(READ), deny: H(NO_POST) });
      break;
    default:
      throw new Error(`unknown permission set: ${kind}`);
  }
  rows.push(bot);
  // never emit an overwrite that changes nothing (Discord rejects empty ones on some routes)
  return rows.filter((r) => (r.allow && r.allow.length) || (r.deny && r.deny.length));
}

const bits = (list) => PermissionsBitField.resolve(list || []);
const bitfieldOf = (v) => (v && typeof v === 'object' && v.bitfield !== undefined ? BigInt(v.bitfield) : bits(v));

/** True when the channel's current overwrites are not exactly the wanted list. */
function overwritesDiffer(channel, wanted) {
  const cache = channel && channel.permissionOverwrites && channel.permissionOverwrites.cache;
  if (!cache || typeof cache.get !== 'function' || typeof cache.size !== 'number') return true;
  if (cache.size !== wanted.length) return true;
  for (const w of wanted) {
    const cur = cache.get(w.id);
    if (!cur) return true;
    if (bitfieldOf(cur.allow) !== bits(w.allow) || bitfieldOf(cur.deny) !== bits(w.deny)) return true;
  }
  return false;
}

/** Does this message carry the OPEN TICKET button? */
function hasOpenButton(message) {
  const rows = (message && message.components) || [];
  const idOf = (c) => (c && (c.customId !== undefined ? c.customId : c.custom_id)) || null;
  return rows.some((row) => ((row && row.components) || []).some((c) => idOf(c) === BUTTONS.open));
}

/**
 * Find an existing channel for a spec. Order: the id remembered from a previous run, then a name
 * match inside the wanted parent, then among uncategorised channels, then (only if the spec says
 * `anywhere`) anywhere on the server. Never returns a channel already claimed by another spec.
 */
function findChannel(channels, spec, { kinds, parentId, claimed, storedId }) {
  const okType = (c) => c && kinds.includes(c.type) && !claimed.has(c.id);
  if (storedId) {
    const c = channels.find((x) => x.id === storedId);
    if (okType(c)) return c;
  }
  const tokens = [normalizeName(spec.name), ...(spec.match || [])].map(normalizeName).filter(Boolean);
  const pools = [];
  if (parentId === undefined) pools.push(channels.filter(okType));
  else {
    if (parentId) pools.push(channels.filter((c) => okType(c) && c.parentId === parentId));
    pools.push(channels.filter((c) => okType(c) && !c.parentId));
    if (spec.anywhere) pools.push(channels.filter(okType));
  }
  for (const pool of pools) {
    for (const tok of tokens) {
      const hit = pool.find((c) => normalizeName(c.name) === tok);
      if (hit) return hit;
    }
  }
  return null;
}

function defaultBucket() {
  return { roles: {}, channels: {}, updatedAt: null };
}

// ---------- service ----------

class SetupService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {object} config app config (uses config.setup, config.manager)
   * @param {import('./tickets').TicketService} tickets
   * @param {import('./roleMemory').RoleMemoryService} roleMemory
   */
  constructor(storage, config, tickets, roleMemory) {
    this.storage = storage;
    this.config = config;
    this.tickets = tickets;
    this.roleMemory = roleMemory;
    this.running = new Set();
  }

  _bucket(guildId) {
    const all = this.storage.data.setup;
    if (!hasOwn(all, guildId)) setOwn(all, guildId, defaultBucket());
    const b = all[guildId];
    if (!b.roles || typeof b.roles !== 'object') b.roles = {};
    if (!b.channels || typeof b.channels !== 'object') b.channels = {};
    return b;
  }

  isRunning(guildId) {
    return this.running.has(guildId);
  }

  _held(guild) {
    const me = guild.members.me;
    const perms = me && me.permissions && typeof me.permissions.has === 'function' ? me.permissions : null;
    return (flags) => (perms ? flags.filter((f) => perms.has(f)) : flags);
  }

  _channels(guild) {
    return [...guild.channels.cache.values()];
  }

  /**
   * Build (or repair) the whole server. Never deletes a channel or a role.
   * opts: { verified, staff, coowner, sensitive } role objects chosen by the admin, styleRoles.
   * Returns { ok, reason?, report } where report = { created, updated, ok, warnings, errors }.
   */
  async run(guild, opts = {}) {
    const report = { created: [], updated: [], ok: [], warnings: [], errors: [] };
    const me = guild.members.me;
    const perms = me && me.permissions && typeof me.permissions.has === 'function' ? me.permissions : null;
    const isAdmin = !!(perms && perms.has(P.Administrator));
    if (!perms || (!isAdmin && (!perms.has(P.ManageChannels) || !perms.has(P.ManageRoles)))) {
      return { ok: false, reason: 'missing_permissions', report };
    }
    if (this.running.has(guild.id)) return { ok: false, reason: 'in_progress', report };

    this.running.add(guild.id);
    try {
      const b = this._bucket(guild.id);
      const roles = await this._ensureRoles(guild, b, opts, report);
      if (roles.staff) this.tickets.setStaffRole(guild.id, roles.staff.id);

      const managerId = this.config.manager.id;
      const ids = {
        everyone: guild.id,
        bot: me.id,
        owner: guild.ownerId,
        manager: managerId && guild.members.cache.has(managerId) && managerId !== guild.ownerId ? managerId : null,
        verified: roles.verified ? roles.verified.id : null,
        staff: roles.staff ? roles.staff.id : null,
        coowner: roles.coowner ? roles.coowner.id : null,
        sensitive: roles.sensitive ? roles.sensitive.id : null,
      };

      const plan = buildPlan(this.config.setup.siteName);
      const claimed = new Set();
      const order = { top: [], categories: [], children: [] };

      for (const spec of plan.top) {
        const ch = await this._ensureChannel(guild, b, spec, { parent: null, ids, claimed, report });
        if (ch) order.top.push(ch);
      }

      for (const cspec of plan.categories) {
        let cat = null;
        if (cspec.managed) {
          cat = await this._ensureTickets(guild, report);
        } else {
          cat = await this._ensureChannel(guild, b, { ...cspec, type: ChannelType.GuildCategory }, { parent: undefined, ids, claimed, report });
          if (cat) {
            const kids = [];
            for (const chspec of cspec.channels) {
              const ch = await this._ensureChannel(guild, b, chspec, { parent: cat.id, ids, claimed, report });
              if (ch) kids.push(ch);
            }
            order.children.push(kids);
            if (cspec.sync) await this._syncChildren(guild, cat, report);
          }
        }
        if (cat) order.categories.push(cat);
      }

      await this._applyPositions(guild, order, report);
      await this._ensurePanel(guild, b, report);
      this._notes(guild, roles, report);

      b.updatedAt = Date.now();
      this.storage.save();
      return { ok: true, report };
    } finally {
      this.running.delete(guild.id);
    }
  }

  // ---- roles ----

  async _ensureRoles(guild, b, opts, report) {
    const cfg = this.config.setup;
    const styleRoles = opts.styleRoles !== false;
    const out = {};
    const jobs = [
      ['verified', { optionRole: opts.verified, configId: cfg.verifiedRoleId }],
      ['staff', { optionRole: opts.staff, fallbackId: this.tickets.getStaffRole(guild.id) }],
      ['coowner', { optionRole: opts.coowner }],
      ['friend', {}],
      ['vip', {}],
      ['sensitive', { optionRole: opts.sensitive, configId: cfg.sensitiveRoleId }],
      ['blank', {}],
    ];
    for (const [key, how] of jobs) {
      try {
        out[key] = await this._ensureRole(guild, b, key, ROLE_SPECS[key], { ...how, styleRoles, report });
      } catch (err) {
        out[key] = null;
        report.errors.push(`rola ${ROLE_SPECS[key].blank ? '(prazna)' : `\`${ROLE_SPECS[key].name}\``}: ${err.message}`);
      }
    }
    return out;
  }

  async _ensureRole(guild, b, key, spec, { optionRole, configId, fallbackId, styleRoles, report }) {
    const cache = guild.roles.cache;
    const all = [...cache.values()];
    const usable = (r) => r && r.id !== guild.id && !r.managed;
    let role = usable(optionRole) ? optionRole : null;
    for (const id of [configId, fallbackId, b.roles[key]]) {
      if (role) break;
      if (id && cache.has(id) && usable(cache.get(id))) role = cache.get(id);
    }
    if (!role) {
      if (spec.blank) role = all.find((r) => usable(r) && isBlankName(r.name)) || null;
      else {
        for (const tok of [normalizeName(spec.name), ...spec.match]) {
          role = all.find((r) => usable(r) && normalizeName(r.name) === tok) || null;
          if (role) break;
        }
      }
    }

    const label = spec.blank ? 'prazna rola' : `\`${spec.name}\``;
    if (!role) {
      role = await guild.roles.create({
        name: spec.name,
        color: spec.color || undefined,
        hoist: false,
        mentionable: false,
        permissions: [],
        reason: '35xw /setup',
      });
      report.created.push(`🎭 ${label}`);
    } else {
      const patch = {};
      if (styleRoles && !spec.noRename && !spec.blank && role.name !== spec.name) patch.name = spec.name;
      if (spec.blank && role.hoist) patch.hoist = false; // must not be displayed separately from members
      if (Object.keys(patch).length) {
        const old = role.name;
        await role.edit({ ...patch, reason: '35xw /setup' });
        report.updated.push(patch.name ? `🎭 \`${old}\` → \`${spec.name}\`` : `🎭 ${label} više nije odvojena`);
      } else {
        report.ok.push(`🎭 ${spec.blank ? 'prazna rola' : `\`${role.name}\``}`);
      }
    }
    setOwn(b.roles, key, role.id);
    return role;
  }

  // ---- channels ----

  async _ensureChannel(guild, b, spec, { parent, ids, claimed, report }) {
    const isCategory = spec.type === ChannelType.GuildCategory;
    const kinds = isCategory ? [ChannelType.GuildCategory] : spec.kinds || (VOICE_KINDS.includes(spec.type) ? VOICE_KINDS : TEXT_KINDS);
    const icon = isCategory ? '📁' : VOICE_KINDS.includes(spec.type) ? '🔊' : '#';
    const wanted = permsFor(spec.perms, ids, this._held(guild));
    try {
      let ch = findChannel(this._channels(guild), spec, {
        kinds,
        parentId: isCategory ? undefined : parent,
        claimed,
        storedId: b.channels[spec.key],
      });
      if (!ch) {
        ch = await guild.channels.create({
          name: spec.name,
          type: spec.type,
          parent: parent || undefined,
          permissionOverwrites: wanted,
          reason: '35xw /setup',
        });
        report.created.push(`${icon} \`${spec.name}\``);
      } else {
        const patch = {};
        const old = ch.name;
        if (ch.name !== spec.name) patch.name = spec.name;
        if (!isCategory && (ch.parentId || null) !== (parent || null)) {
          patch.parent = parent || null;
          patch.lockPermissions = false;
        }
        if (overwritesDiffer(ch, wanted)) patch.permissionOverwrites = wanted;
        if (Object.keys(patch).length) {
          await ch.edit({ ...patch, reason: '35xw /setup' });
          const what = [];
          if (patch.name) what.push(`preimenovano iz \`${old}\``);
          if (patch.parent !== undefined) what.push('premješteno');
          if (patch.permissionOverwrites) what.push('dozvole');
          report.updated.push(`${icon} \`${spec.name}\` (${what.join(', ')})`);
        } else {
          report.ok.push(`${icon} \`${spec.name}\``);
        }
      }
      claimed.add(ch.id);
      setOwn(b.channels, spec.key, ch.id);
      return ch;
    } catch (err) {
      report.errors.push(`${icon} \`${spec.name}\`: ${err.message}`);
      return null;
    }
  }

  /** The tickets category + transcripts channel are kept private exactly as the ticket service wants them. */
  async _ensureTickets(guild, report) {
    try {
      const cat = await this.tickets.ensureCategory(guild);
      const base = this.tickets._baseOverwrites(guild);
      if (overwritesDiffer(cat, base)) {
        await cat.edit({ permissionOverwrites: base, reason: '35xw /setup' });
        report.updated.push(`📁 \`${cat.name}\` (dozvole)`);
      } else {
        report.ok.push(`📁 \`${cat.name}\``);
      }
      const tr = await this.tickets.ensureTranscriptChannel(guild);
      const patch = {};
      if ((tr.parentId || null) !== cat.id) {
        patch.parent = cat.id;
        patch.lockPermissions = false;
      }
      if (overwritesDiffer(tr, base)) patch.permissionOverwrites = base;
      if (Object.keys(patch).length) {
        await tr.edit({ ...patch, reason: '35xw /setup' });
        report.updated.push(`# \`${tr.name}\` (samo staff + admini)`);
      } else {
        report.ok.push(`# \`${tr.name}\``);
      }
      return cat;
    } catch (err) {
      report.errors.push(`📁 tickets: ${err.message}`);
      return null;
    }
  }

  /** Sync every channel inside a category to the category's permissions. */
  async _syncChildren(guild, cat, report) {
    let synced = 0;
    let failed = 0;
    for (const ch of this._channels(guild)) {
      if (ch.parentId !== cat.id || typeof ch.lockPermissions !== 'function') continue;
      if (ch.permissionsLocked === true) continue;
      try {
        await ch.lockPermissions();
        synced += 1;
      } catch {
        failed += 1;
      }
    }
    if (synced) report.updated.push(`🔐 ${synced} kanal(a) u \`${cat.name}\` usklađeno s kategorijom`);
    if (failed) report.errors.push(`🔐 ${failed} kanal(a) u \`${cat.name}\` nije se dalo uskladiti`);
  }

  async _applyPositions(guild, order, report) {
    if (!guild.channels || typeof guild.channels.setPositions !== 'function') return;
    const list = [];
    order.top.forEach((c, i) => list.push({ channel: c.id, position: i }));
    order.categories.forEach((c, i) => list.push({ channel: c.id, position: i }));
    for (const kids of order.children) kids.forEach((c, i) => list.push({ channel: c.id, position: i }));
    if (!list.length) return;
    try {
      await guild.channels.setPositions(list);
    } catch (err) {
      report.warnings.push(`redoslijed kanala nije spremljen: ${err.message}`);
    }
  }

  /** Post the verification panel into the verify channel unless it is already there. */
  async _ensurePanel(guild, b, report) {
    const ch = b.channels.verify_ch ? guild.channels.cache.get(b.channels.verify_ch) : null;
    if (!ch || typeof ch.send !== 'function') return;
    const me = guild.members.me;
    try {
      let present = false;
      if (ch.messages && typeof ch.messages.fetch === 'function') {
        const fetched = await ch.messages.fetch({ limit: 50 });
        for (const m of fetched.values()) {
          if (m && m.author && me && m.author.id === me.id && hasOpenButton(m)) {
            present = true;
            break;
          }
        }
      }
      if (present) {
        report.ok.push('🎫 verification panel');
      } else {
        await ch.send({ embeds: [panelEmbed()], components: [panelRow()] });
        report.created.push(`🎫 verification panel u <#${ch.id}>`);
      }
    } catch (err) {
      report.errors.push(`🎫 panel: ${err.message}`);
    }
  }

  _notes(guild, roles, report) {
    const me = guild.members.me;
    const botTop = me && me.roles && me.roles.highest ? me.roles.highest.position : null;
    const above = Object.values(roles).filter((r) => r && botTop !== null && typeof r.position === 'number' && r.position >= botTop);
    if (above.length) {
      report.warnings.push(
        `rola bota mora biti **iznad** ${above.map((r) => `<@&${r.id}>`).join(', ')} da bi ih mogao dodjeljivati (Server Settings → Roles).`,
      );
    }
    const auto = this.roleMemory && typeof this.roleMemory.getGuildAutoRole === 'function' ? this.roleMemory.getGuildAutoRole(guild.id) : null;
    if (auto && roles.verified && auto === roles.verified.id) {
      report.warnings.push('auto rola (`/aa`) je ista kao VERIFIED, pa bi novi članovi preskočili verifikaciju. Postavi drugu auto rolu.');
    }
    report.warnings.push('ništa nije obrisano: role i kanale koje ne želiš obriši ručno.');
  }
}

module.exports = {
  SetupService,
  STYLE,
  BLANK_ROLE_NAME,
  ROLE_SPECS,
  buildPlan,
  normalizeName,
  isBlankName,
  permsFor,
  overwritesDiffer,
  findChannel,
  hasOpenButton,
};
