# 35xw – Discord bot

A Discord bot for a verified community server: a **ticket system** with HTML transcripts, a one-command
an **anti-nuke** guard, **/lock** and the **/sos** emergency button, a **server log**, an **auto
role** on join with **role memory** (members keep their roles after they leave), a **/stats** card, and an optional
Discord-gated **website**.

---

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/stats` | **verified** | Shows the server: **members** (people, bots, verified), the **boost level** with the boosts and how many more the next level needs, open tickets, channels, roles, emoji and stickers, when the server was made and who owns it. |
| `/lock` | **admins** | Locks the channel it is written in: only admins and the server owner can write there, everyone else cannot. Posts a **Channel locked** card. |
| `/unlock` | **admins** | Opens a channel locked with `/lock` and puts its permissions back exactly as they were. |
| `/sos start` · `/sos end` · `/sos status` | **server owner** | Emergency button. `start` saves the whole server, then hides every channel from everyone except the owner. `end` puts every channel and role back exactly as it was and proves it. See *Lock and SOS* below. |
| `/ban user [reason]` | **admins** | Bans a member (or a user id that already left) and writes the reason, with the admin's name, into the audit log. The target must sit below the admin and the bot in the role list. |
| `/b [user] [mode]` | **manager only** | Bypass: exempt from every limit (command cooldowns, one-open-ticket rule, ticket cooldown). `/b` toggles your own; `/b user:@someone` gives it to (or takes it from) that person; `mode:on/off` sets it explicitly; `mode:List` shows who has it. Persisted across restarts. |
| `/v [staff]` | **staff** | Posts the **35xw verification** panel with a 🎫 **OPEN TICKET** button. Optionally sets the staff role. |
| `/close` | opener / staff | Closes the current ticket: saves the HTML transcript, then deletes the channel. |
| `/add` | **staff** | Adds a user or role to the current ticket. |

- **verified** = members holding the VERIFIED role (`VERIFIED_ROLE_ID`, the role staff hands out after a ticket).
  The manager, people with bypass, the server owner and admins always pass. On a server where no VERIFIED role
  is known (the id does not exist there) those commands stay open to everyone.
- **server owner** commands (`/sos`) also work for the manager, but for no admin.
- Every command has a **30‑second cooldown per user** (configurable via `COOLDOWN_SECONDS`).
- The **manager** is the only person allowed to hand out bypass. The manager is
  identified by their Discord **user ID** (`1143659003327553556`, username `35bf`), which cannot
  be spoofed by changing a nickname.

### Auto role

Everyone who joins gets the **auto role**: the role saved for the server, else `AUTO_ROLE_ID` from `.env`, else a
role called `AUTO_ROLE_NAME` (default `member`, found whatever the capitals), which is created if it is missing.
The bot's own role must sit **above** it, and the bot needs Manage Roles, or it cannot give it.

### Role memory

- On join, a member gets the **auto role** plus any roles they had before (restored from memory).
- Roles are saved keyed by **guild ID + Discord user ID**, so the memory survives a member leaving
  the server entirely. It updates whenever someone's roles change and when they leave.
- The bot only restores roles it is actually allowed to assign (not managed roles, and only roles
  **below its own highest role**). If someone comes back without their roles, the usual cause is a role that sits above the bot's
  role. The console prints the breakdown when they join, and the server log channel gets a **Roles not restored**
  line naming the roles it could not give back.
- **Moderation note:** a plain **kick** does not stop role memory — a kicked member who rejoins gets
  their old roles back. To permanently strip someone, **ban** them: a ban clears their remembered
  roles so a later rejoin starts clean.

### Ticket system

Run `/v` in a channel to post the verification panel: a clean embed titled **35xw verification**
("To get access to the server open a ticket") with a 🎫 **OPEN TICKET** button. Pass
`/v staff:@Role` to choose the staff role that can see and manage every ticket (admins and the bot
manager always can).

- Pressing the button creates `ticket-0001`, `ticket-0002`, … inside a **🎫 Tickets** category that
  the bot creates on first use (an older `TICKET` category is renamed, not duplicated). Numbers are
  stored and **never reused**.
- A user can have **one open ticket at a time**, and must wait **10 minutes** after their ticket is
  closed before opening another (`TICKET_REOPEN_COOLDOWN_MINUTES`).
- The ticket channel is **private**: only the opener, the staff role, admins and the bot manager can
  see it and write in it. It greets the opener with *"Please wait for your role, our moderators will
  be here shortly."* and a 🔒 **Close** button.
- **Close** (opener or staff, button or `/close`) does everything in one go: it renders the whole
  conversation as a Discord-styled **HTML transcript** (same number as the ticket,
  `transcript-NNNN.html`), posts it into the single private **`#transcripts`** channel with an embed
  (ticket, opened by, closed by, messages, duration, opened at) and a **View transcript** button, and
  then **deletes the ticket channel** after a short countdown. If the transcript cannot be saved the
  channel is kept so nothing is lost.
- The person who **opened the ticket gets the same message by DM** (card, file and **View transcript**
  button, literally what goes into `#transcripts`), whoever closed it. It is sent only after the channel copy is
  saved. If their DMs are closed the ticket still closes and the server log says who did not get it.
- The transcript is **one self-contained page**: avatars, pictures people sent, custom emoji, embeds,
  buttons, replies, forwards and reactions are inside it, so it still looks right after Discord's own
  picture links expire and the ticket channel is gone. Times are shown in the viewer's own time zone.
- **Pictures** are shown at a small size and **enlarge when clicked**. A picture over 1.5 MB is shown as a
  reduced preview (Discord's media proxy makes it, longest side 1600 px) and says so under the picture.
- **Every picture and file has a Download.** It comes from the best place there is: from the page itself
  (pictures taken over as they are, files up to 1 MB), from the **online copy** of the ticket (big pictures
  and files up to 25 MB, 100 MB per ticket, kept next to the page and downloaded as is), and only as a
  last resort from Discord's own link, which says **Open original** because it can stop working. Without an
  online place (below) the big ones fall back to that last resort.
- A page holds about 7 MB of pictures and small files so it can still be attached as a file (Discord's
  limit); with an online link, the same page is attached whenever it fits into 8 MB.
- With an **online link** configured (below), every ticket also gets its **own address**,
  `https://…/t/<32 random characters>/index.html`, opened with the **View transcript** button.
- `/add` gives someone access to a ticket.

**Alerts.** Every new ticket is announced in the staff channel (`TICKET_NOTIFY_CHANNEL_ID`, pinging
`TICKET_NOTIFY_ROLE_IDS`) and sent as a DM to the owner (`TICKET_NOTIFY_USER_ID`, default the manager).
This only happens on the owner's own server (the one that has the channel, or that the owner owns), so
other servers running the bot never reach them (`GUILD_ID` counts as the owner server too). If an alert cannot
be delivered (the bot cannot post in the channel, the owner blocks DMs, a role does not exist), the server
log says exactly why, and so does a check at every start.

**Numbering survives a restart, and a lost database.** The counter is saved after every ticket. If
`data/db.json` is ever gone, the bot reads the highest number still visible in the tickets category
(open `ticket-NNNN` channels and the `transcript-NNNN.html` files in `#transcripts`) and continues from
there instead of starting again at `0001`.

A ticket keeps **one number for its whole life** (`ticket-0007` → `transcript-0007.html`), so tickets
and transcripts can never get mixed up. All ticket state lives in the database, so numbering and
cooldowns survive restarts.

**Every server is independent.** Ticket numbers, the category, cooldowns and the staff role are all
stored per server, so each server starts at `ticket-0001` and never interferes with another. 

### Lock and SOS

Both change permissions straight through Discord's API, on the raw numbers, and both save the original first,
so putting it back is exact to the bit.

**`/lock`** denies writing (messages, messages in threads, new threads) for everyone in the channel it is run in.
Admins and the server owner write regardless (Administrator ignores overwrites). Roles that had an explicit
"may write" lose it too. The bot keeps its own access so it can answer. The channel's old overwrites are saved;
`/unlock` writes exactly those back. A second `/lock` never replaces the saved copy, and a failed lock is
rolled back.

**`/sos start`** (owner only) does this, in this order:
1. **Scan.** It reads every channel's overwrites and every role, and shows a preview: how many channels are public
   or restricted, what would change, which Administrator roles would be lowered, which cannot be touched. A
   `sos-scan.txt` file lists, per channel, who can see it today, and what each role is for. Nothing is changed.
2. **Confirm.** Only the owner's *Start SOS* button goes on. The scan is read again at that moment, so what is saved
   is the server as it is right then.
3. **Save.** The whole state is written to `data/sos/sos-<server>-<time>.json` **and** to `db.json` before the first
   change, and the same file is sent to the owner by DM. A second `/sos start` is refused, it can never replace the
   first copy.
4. **Hide.** In every channel and category, every overwrite that lets someone see it is switched to a deny,
   `@everyone` is denied, and nobody else is added. Only the **owner**, the **manager** and the **bot** keep seeing
   everything. Roles with **Administrator** are lowered to the same permissions without it until `/sos end`
   (`keep_admins:true` leaves them alone). Roles above the bot's role and other bots' roles cannot be edited by
   me: the preview names them, and members with them still see everything.

**`/sos end`** puts roles back first, then every channel, writing back exactly the saved numbers and deleting only
what SOS itself added (something somebody else added meanwhile is left). Then it **reads every channel and the
changed roles from Discord again and compares them with the saved copy**; only when they are identical does SOS
switch itself off. If anything could not be put back, SOS stays on, says what, and `/sos end` can simply be run
again. A deleted channel or role cannot come back and is listed. If the database is ever lost, attach the `.json`
file from the DM: `/sos end backup:<file>`. `/sos status` shows whether it is on.

Good to know: channels created while SOS is on are not covered; people sitting in voice channels are
disconnected; Community servers may refuse to hide their rules and updates channels; permission edits made by
others while SOS is on are reverted by `/sos end`. The server log is muted for the run and gets one line at the
start and one at the end. The bot needs **Administrator**, or **Manage Roles** and **Manage Channels**.

### Online transcripts

Pick **one** of these. With neither, transcripts stay attached files and there is no button.

**A. Cloudflare R2 (recommended).** In the Cloudflare dashboard:
1. **R2** → *Create bucket* (for example `transcripts`). Cloudflare may ask for a payment method to
   switch R2 on; the free allowance (10 GB) is far more than transcripts need.
2. Open the bucket → *Settings* → **Public Development URL** → *Enable*. Copy the `https://pub-….r2.dev` address
   (a custom domain on the bucket works too and is better for heavy use).
3. R2 overview → **Manage API tokens** → *Create API token* → permission **Object Read & Write**, limited to
   that bucket. Copy the Access Key ID and the Secret Access Key (shown once). The **Account ID** is on the R2 overview page.
4. Put them into `.env` and restart the bot:

```
R2_ACCOUNT_ID=…
R2_BUCKET=transcripts
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_PUBLIC_URL=https://pub-….r2.dev
```

On start the bot prints `Transcript links: bucket transcripts (…)`. Any other S3 compatible storage works
too (set `R2_ENDPOINT` instead of `R2_ACCOUNT_ID`).

**B. The bot's own website.** With the role-gated website running (`WEB_ENABLED=true`, a reachable
`WEB_PUBLIC_URL`) the bot stores the pages in `data/transcripts/` and serves them at
`<WEB_PUBLIC_URL>/t/<token>/index.html`, no login needed. If the website does not start, links through it are switched off.

Originals sit under `…/t/<token>/files/` and are served as plain downloads, so an uploaded `.html` or `.svg`
can never run on that address. Good to know: the 32 random characters are the only protection, so **anyone
with a link can read that transcript and download its files** (the page tells search engines not to index it). Nothing is deleted automatically. If putting
a page online fails, the ticket still closes, the file is attached and the server log says why.

### Server log

Everything that happens on the server is written to one private channel (`LOG_CHANNEL_ID`, default
`1554450772605935626`): deleted messages, deleted or changed channels and roles, permission changes,
bans, kicks, unbans, timeouts, nickname and role changes, joins, leaves, voice activity, created
invites and webhooks, server changes and the bot's own admin commands.

- **Who deleted a message and whose it was.** The message events give the author, the channel and
  the time. The audit log gives who deleted it. Deleting your own message leaves no audit entry, so
  that case reads "The author, no audit log entry". Messages the bot never saw in its cache still
  show who deleted them when Discord recorded it.
- **Message text** is only logged with `LOG_MESSAGE_CONTENT=true`, and that needs the **Message
  Content Intent** switched on in the Developer Portal (Bot page). Without it the bot logs everything
  else and says "Not logged" for the text. Turning the flag on before the intent makes Discord refuse
  the login, so switch the intent on first.
- **Quiet while it works.** `/sos` would create hundreds of lines, so the log
  is muted for the guild while it runs and gets one summary line instead.
- **Ticket channels** created and deleted by the bot are left out (the transcript covers them).
- The bot needs to see and write in the channel and have **View Audit Log** (Administrator has it).
  When the bot starts it posts "Logging is on" there, so you know it works.
- `LOGS_ENABLED=false` turns it off, `LOG_VOICE=false` stops the voice lines.

### Anti-nuke

Always on, on every server. Whoever **deletes 2 channels within 10 minutes** is dealt with in this order:
1. a **private message** to them, signed *Anti-nuke system made by 35bf*,
2. an **alert in the staff channel** (`TICKET_NOTIFY_CHANNEL_ID`, pinging `TICKET_NOTIFY_ROLE_IDS`; the server
   log channel if the server has no staff channel),
3. the **ban**.

Afterwards the owner (and the manager, if they are on the server) gets a DM and the server log gets a report.
If the ban is not possible, the same messages say why (usually: my role must be above theirs, and I need
Ban Members). The private message and the alert never hold the ban back for more than 3 seconds.

- **Never touched:** the server owner, the bot manager, the bot itself and `ANTINUKE_TRUSTED_IDS`.
  Deletions made by the bot (closing tickets) are not counted.
- There is no command and no switch. At every start the bot checks that it has **Ban Members** and
  **View Audit Log**, and says so in the log channel if not.
- Settings: `ANTINUKE_BAN_AT` (2) and `ANTINUKE_WINDOW_MINUTES` (10).
- A staff member who really needs to delete channels should be added to `ANTINUKE_TRUSTED_IDS`. Other bots
  count too, so a bot that cleans up many channels needs the same.
- A banned member's remembered roles are cleared, so rejoining after an unban starts clean.

### Website gated by a Discord role

The bot can also serve a website that only members with a certain role can open. Visitors click
**Sign in with Discord**; the bot checks their roles on your server; if they hold one of the required
roles they get in, otherwise they see a "no access" page naming the role they need. No extra packages.

1. In the Developer Portal open your app → **OAuth2**:
   - copy the **Client Secret** into `.env` as `DISCORD_CLIENT_SECRET`;
   - under **Redirects** add exactly `https://YOUR-DOMAIN/callback` (your `WEB_PUBLIC_URL` + `/callback`).
2. In `.env` set `WEB_ENABLED=true`, `WEB_PUBLIC_URL=https://YOUR-DOMAIN`, `WEB_ROLE_ID=<role id>`
   (several ids separated by commas = any of them), and `WEB_GUILD_ID` if it differs from `GUILD_ID`.
   The port comes from `WEB_PORT`, or from the host's `SERVER_PORT` automatically.
3. Put your website files in `web/protected/` (start with the sample `index.html`). Everything in that
   folder is protected; `web/public/` holds the login and denied pages, which you can restyle freely.
4. Restart the bot. The console prints the address and the exact redirect URL it expects.

Sessions are signed cookies (secret auto-generated into `DATA_DIR/web-secret.txt`), last
`WEB_SESSION_HOURS` (24) and the role is re-checked every `WEB_RECHECK_MINUTES` (10), so someone who
loses the role also loses access. `/logout` signs out, `/health` answers `ok` for uptime checks.

---

## Setup

### 1. Create the bot application

1. Go to <https://discord.com/developers/applications> and create an application.
2. Open **Bot** → **Reset Token** and copy the token.
3. On the **Bot** page, enable **Privileged Gateway Intents → Server Members Intent**
   (required for auto roles and role memory).
4. Copy the **Application ID** from **General Information**.

### 2. Invite the bot

Use an invite URL with the `bot` and `applications.commands` scopes and these permissions:
**Manage Roles**, **Manage Channels**, **Manage Messages**, **View Channels**, **Send Messages**,
**Embed Links**, **Attach Files**, **Read Message History** (the last four are needed for embeds and
ticket transcripts).

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=268561424
```

> Make sure the bot's role is **above** the auto role and any roles it should manage.

### 3. Configure

```bash
cp .env.example .env
# then edit .env
```

Fill in `DISCORD_TOKEN`, `CLIENT_ID`, and (recommended) `GUILD_ID`. Set `AUTO_ROLE_ID` to an existing
role, or leave it empty and set `AUTO_ROLE_NAME` (the bot will create that role if it does not exist).

### 4. Install, register commands, run

```bash
npm install
npm run deploy   # registers the slash commands
npm start        # starts the bot
```

If you set `GUILD_ID`, commands appear in that server instantly. **Leave `GUILD_ID` empty to run on
all servers** (global commands) — they can take up to an hour to show up the first time. In
all-servers mode, leave `AUTO_ROLE_ID` empty and rely on the `AUTO_ROLE_NAME` default per server.

The bot also **registers its commands automatically on startup**, so `npm run deploy` is optional.
In all-servers mode it registers them **per guild**, so commands appear instantly on every server the
bot is in (and on any new server it joins) instead of waiting for global propagation.

### Hosting (e.g. bot-hosting.net)

Hosts that run `node index.js` from the project root work out of the box — the root `index.js` just
loads `src/index.js`. If your panel lets you set the startup file, either `index.js` or
`src/index.js` is fine. Put your token and settings in a `.env` file (via the panel's file manager)
or in the panel's environment variables. Because commands auto-register on startup, you usually only
need to set the start command and hit start.

---

## Data & privacy

All state lives in `DATA_DIR` (default `./data`):

- `db.json` – tickets, role memory, settings and the saved copies of `/lock` and `/sos`.
- `sos/` – the backup file of every `/sos start`, and `transcripts/` when the own website hosts them.

When the bot starts it prints `Data: … (loaded)` or `(new, nothing was saved before)`. If it says
**new** after a restart, the host is not keeping the data folder, and tickets and remembered roles
would be lost: use a host with persistent storage.

The `data/` folder and your `.env` are git‑ignored. **Never commit them** – they contain
your bot token and your server's data.

---

## Development

```bash
npm run check    # syntax-check the entry points
npm test         # run the unit tests (node:test)
```

## Project layout

```
src/
  config.js              # env-driven configuration
  index.js               # client, interaction + member event wiring
  deploy-commands.js     # registers slash commands with Discord
  storage.js             # atomic JSON database
  services/
    verified.js          # who counts as verified
    cooldown.js          # per-user command cooldowns
    roleMemory.js        # auto role + remembered roles
    antinuke.js          # bans anyone who deletes too many channels
    overwrites.js        # exact permission maths for /lock and /sos
    lockdown.js          # /lock and /sos: save, apply, restore, verify
    transcriptHtml.js    # the transcript page
    transcriptMedia.js   # downloads the pictures into it
    transcriptHost.js    # puts it online (R2 or the own website)
  commands/
    stats.js             # /stats (members, boost level, more)
    ban.js               # /ban (admins, with a reason)
    lock.js unlock.js    # /lock  /unlock
    sos.js               # /sos start | end | status
test/                    # unit tests
```
