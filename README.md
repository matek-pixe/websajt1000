# 35xw – Discord bot

A Discord bot that hands out **Steam** and **FiveM** accounts (never the same account twice),
gives everyone an **auto role** on join, **remembers each member's roles** by their Discord ID
(even after they leave), shows a **"Rastrošan"** stats board, and has a **delete‑all** safety switch.

---

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/steam` | **verified** | Gives you one Steam account that has **never** been given to anyone on the server. |
| `/5m` | **verified** | Gives you one FiveM account that **no one** has ever generated. |
| `/combo` | **verified** | Gives you one Steam **and** one FiveM account together, one below the other, each split into labelled lines (username / e-mail / password / extra). |
| `/help` | **verified** | Lists every command and how to use it. |
| `/stats` | **verified** | Posts the **Rastrošan** embed: member count + top `/steam` and top `/5m` users (separately). |
| `/setup server` | **server owner** | Rebuilds the whole server layout and roles after a preview and a confirmation. Keeps `osjetljivo`, the tickets category, the `+` role and other protected roles. See *Server setup* below. |
| `/antinuke [mode]` | **server owner** | Shows or switches the anti-nuke protection of this server (on by default). See *Anti-nuke* below. |
| `/aa` | **server owner** | Sets the role every new member gets on **this** server, e.g. `/aa @Member`. Run with no role to see the current setting. |
| `/f role` | **admins** | Gives a role to **every member** of the server (bots skipped unless `bots:true`). `action:Remove` takes it away from everyone. Shows progress and a summary. |
| `/ban user [reason]` | **admins** | Bans a member (or a user id that already left) and writes the reason, with the admin's name, into the audit log. The target must sit below the admin and the bot in the role list. |
| `/ticketalert` | **server owner** | Sends a test ticket alert (nobody is pinged) and shows what arrived and what did not, with the fix. |
| `/roles` | **staff** | Shows the roles the bot remembers for a user (`user:` or paste an `id:` of someone who left) and whether it can restore them, with the reason if not. |
| `/refills` | **manager only** | Attach `steam.txt` to refill the Steam pool. |
| `/refill5` | **manager only** | Attach `fivem.txt` to refill the FiveM pool. |
| `/b [user] [mode]` | **manager only** | Bypass: exempt from every limit (command cooldowns, one-open-ticket rule, ticket cooldown). `/b` toggles your own; `/b user:@someone` gives it to (or takes it from) that person; `mode:on/off` sets it explicitly; `mode:List` shows who has it. Persisted across restarts. |
| `/n` | **server owner** | Deletes **all** channels one by one and leaves a single text channel named `zavrseno`. Asks for confirmation first. |
| `/v [staff]` | **staff** | Posts the **35xw verification** panel with a 🎫 **OPEN TICKET** button. Optionally sets the staff role. |
| `/close` | opener / staff | Closes the current ticket: saves the HTML transcript, then deletes the channel. |
| `/add` | **staff** | Adds a user or role to the current ticket. |
| `/ping` | **verified** | Bot latency. |

- **verified** = members holding the VERIFIED role (the role staff hands out after a ticket; see
  `/setup server`). The manager, people with bypass, the server owner and admins always pass. On a server
  where no VERIFIED role is known yet (no `/setup server`, and the `.env` id does not exist there) those
  commands stay open to everyone.
- **server owner** commands (`/n`, `/setup server`, `/antinuke`) also work for the manager, but for no admin.
- Every command has a **30‑second cooldown per user** (configurable via `COOLDOWN_SECONDS`).
- Account replies are **ephemeral** – only the person who ran the command can see the account.
- The **manager** is the only person allowed to refill accounts or hand out bypass. The manager is
  identified by their Discord **user ID** (`1143659003327553556`, username `35bf`), which cannot
  be spoofed by changing a nickname.

### How accounts never repeat

Every account that is handed out is written into a permanent `given` registry keyed by the account
line itself. `/steam` and `/5m` only ever take from the pool of accounts that are **not** in that
registry, and refills skip any account that was already given out or is already waiting. So an
account can only ever be handed to one person, even if the manager re‑uploads an old file.

### Auto role per server

Each server's **owner** chooses the auto role for their own server with `/aa @Role`. That choice is
stored per server and takes priority over the `AUTO_ROLE_ID` / `AUTO_ROLE_NAME` defaults in `.env`.
Until an owner runs `/aa`, the bot falls back to those defaults (creating a role named by
`AUTO_ROLE_NAME` if needed). The bot's own role must sit **above** the chosen role for it to be able
to assign it; `/aa` warns you if it doesn't.

### Role memory

- On join, a member gets the **auto role** plus any roles they had before (restored from memory).
- Roles are saved keyed by **guild ID + Discord user ID**, so the memory survives a member leaving
  the server entirely. It updates whenever someone's roles change and when they leave.
- The bot only restores roles it is actually allowed to assign (not managed roles, and only roles
  **below its own highest role**). If someone comes back without their roles, run `/roles` on them:
  it lists what is remembered and flags roles that sit above the bot's role, which is the usual cause.
  The join log prints the same breakdown, and the server log channel gets a **Roles not restored**
  line naming the roles it could not give back.
- **Moderation note:** a plain **kick** does not stop role memory — a kicked member who rejoins gets
  their old roles back. To permanently strip someone, **ban** them: a ban clears their remembered
  roles so a later rejoin starts clean.

> **`/n` on Community servers:** Discord does not allow deleting the mandatory rules and
> community-updates channels, so on a Community server those remain alongside `zavrseno`. On a normal
> server `/n` really does leave exactly one channel.

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
other servers running the bot never reach them (`GUILD_ID` counts as the owner server too). After
`/setup server` the `staff-news` channel it builds is used when the configured channel no longer exists.
If an alert cannot be delivered (the bot cannot post in the channel, the owner blocks DMs, a role does not
exist), the server log says exactly why, and so does a check at every start. **`/ticketalert`** sends a
test (nobody is pinged) and shows what worked.

**Numbering survives a restart, and a lost database.** The counter is saved after every ticket. If
`data/db.json` is ever gone, the bot reads the highest number still visible in the tickets category
(open `ticket-NNNN` channels and the `transcript-NNNN.html` files in `#transcripts`) and continues from
there instead of starting again at `0001`.

A ticket keeps **one number for its whole life** (`ticket-0007` → `transcript-0007.html`), so tickets
and transcripts can never get mixed up. All ticket state lives in the database, so numbering and
cooldowns survive restarts.

**Every server is independent.** Ticket numbers, the category, cooldowns and the staff role are all
stored per server, so each server starts at `ticket-0001` and never interferes with another. (Only the Steam/FiveM account pools are shared, on purpose, so the same account can
never be handed out twice anywhere.)

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

### Server setup (`/setup server`)

`/setup server` replaces the server layout with the 35xw template. It is a rebuild, not a repair:
everything that is not protected is deleted and created again. Because that cannot be undone, it
works in two steps.

1. **Preview.** The command lists what stays, what will be deleted, what will be created and who
   gets access. Nothing has changed at this point. Only the server owner (and the bot manager) can
   see it and press the buttons.
2. **Confirm.** *Rebuild server* starts the work, *Cancel* drops it. The confirmation is single use
   and expires after ten minutes.

The order of work keeps a failure harmless: roles first, then **every new channel is built**, and
only after that the old channels and roles from the preview are deleted. If building fails, the new
channels are removed again and nothing old is deleted. Only what the preview listed is ever
deleted, so a channel created after the preview survives.

**What always stays**

- The `osjetljivo` category with everything inside it, exactly as it is (name and permissions are
  never edited). Add more with the `keep` option or `SETUP_KEEP_CATEGORIES`. If no such category
  exists, the command refuses to run.
- The tickets category with open tickets and `#transcripts`, so ticket history is never lost. The
  ticket system needs it, so it is created when it does not exist yet.
- The `+` role (matched by its exact name) and the verified role, the role that gives access to
  `osjetljivo`, the website roles (`WEB_ROLE_ID`), the auto role, every role with Administrator,
  managed roles and roles above the bot. Extra ids go in `SETUP_PROTECTED_ROLE_IDS`.
- Channels Discord refuses to delete on Community servers (rules and updates).

**What the template creates**

| Where | What | Who sees it |
| --- | --- | --- |
| top | `🌐 ıl 35xw.top` (voice) | everyone, nobody can join, a reminder of the website |
| `🔒 ıl PRIVATE` | `🔒・priv-chat`, `🔒 ıl PRIV` (voice) | the server owner, admin roles, every role above the lowest admin role, and the co-owner role |
| `✅ ıl VERIFY` | `🎫・verify` with the **35xw verification** panel | everyone can read it and press the button; **hidden from verified members** |
| `🎫 Tickets` | ticket channels and `#transcripts` | staff and admins; each ticket also shows to its opener |
| `📌 ıl INFO` | `📜・rules`, `📢・announcements`, `🛠️・changelog`, `ℹ️・information`, `🛒・buy-triggers`, `🆗・joins` | verified members only, read only; staff can post |
| `🌍 ıl GENERAL` | `💬・chat`, `🌍・balkan`, `🤖・cmds`, `🎮・gen`, `♾️・triggers`, `📢・server`, `🗑️・dump` | verified members |
| `🔊 ıl VOICE` | `#1`, `#2`, `#3`, `🌍 ıl BALKAN`, `💤 ıl AFK` | verified members |
| `💎 ıl VIP` | `💎・vip-chat`, `💎 ıl VIP VOICE` | the VIP role and staff |
| `🛡️ ıl STAFF` | `📣・staff-news`, `💬・staff-chat`, `🚩・reports`, `📋・logs`, `🛡️ ıl STAFF VOICE` | the support role and the co-owner role |
| last | `osjetljivo` | unchanged |

Text channels use `・` in their names and are lowercase, because Discord lowercases text channel
names and turns spaces into hyphens. Categories and voice channels keep the `icon ıl NAME` style.

**Also protected, found by the review of this command:** roles that appear in the permission
overwrites of a kept channel (deleting a role removes its overwrites, which would edit the kept
category), the current ticket staff role when it has Administrator, and the server log channel,
wherever it sits. The tickets category and `#transcripts` are looked up with one rule for both the
preview and the run, and `#transcripts` is only ever taken from inside the tickets category.

**What else it takes care of.** Invites belong to a channel and die with it, so the preview warns how
many will stop working and the run creates one new permanent invite in the verify channel and prints
it in the summary. If the AFK channel or the system messages channel were among the deleted ones,
they are pointed at the new AFK voice channel and the new chat.

**If something goes wrong.** Roles are set up first. If a role cannot be created, or building fails,
everything the run created is removed again, renamed roles get their name back and nothing old is
deleted, and the card lists anything it could not undo. Once the old layout is being removed, an
error is reported as a partial rebuild. A second preview that is still open after a rebuild is
refused. The result is shown in the reply, else sent as a direct message, else posted in the new
priv chat.

**Roles.** The verified role is, in this order: the one chosen with `verified`, the id in
`SETUP_VERIFIED_ROLE_ID`, the role named `+`, the one from the last run, otherwise a new
`✅ ıl VERIFIED`. It is never renamed. Roles named like the template ones are reused and renamed in
place, so members keep them: `👑 ıl CO-OWNER`, `🎫 ıl SUPPORT` (this becomes the ticket staff role),
`💎 ıl VIP`, `🤝 ıl FRIEND` and an invisible-named separator role that is not shown apart from
members. Anything missing is created. They are stacked directly above the verified role. Priv access
goes to the server owner, every role with Administrator, every role positioned above the lowest
admin role and `👑 ıl CO-OWNER`, plus the `priv_role` you pass. The verified role, the `+` role, the
auto role and the website roles are never given priv access, however high they sit. The preview
lists exactly which roles qualify, and those roles are never deleted.

**Options:** `verified`, `priv_role` (an extra role for the priv channels), `keep` (an extra category to keep) and `delete_roles`
(`false` leaves every role alone).

The bot needs **Administrator** (or Manage Channels and Manage Roles) and its role must sit above
the roles it renames, deletes and reorders. If the channel the command ran in is deleted, the
summary is sent to the owner as a direct message.

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
- **Quiet while it works.** `/setup server`, `/n` and `/f` would create hundreds of lines, so the log
  is muted for the guild while they run and gets one summary line instead.
- **Ticket channels** created and deleted by the bot are left out (the transcript covers them).
- The bot needs to see and write in the channel and have **View Audit Log** (Administrator has it).
  When the bot starts it posts "Logging is on" there, so you know it works.
- `LOGS_ENABLED=false` turns it off, `LOG_VOICE=false` stops the voice lines.

### Anti-nuke

On by default on every server. Whoever **deletes more than 3 channels within 10 minutes** is sent a
private message signed *Anti-nuke system made by 35bf* and is then **banned**. The owner (and the
manager, if they are on the server) gets a DM about it and the server log gets a line. If the ban is not
possible, the same messages say why (usually: my role must be above theirs, and I need Ban Members).

- **Never touched:** the server owner, the bot manager, the bot itself and `ANTINUKE_TRUSTED_IDS`.
  Deletions made by the bot (`/n`, `/setup server`, closing tickets) are not counted.
- `/antinuke` shows the state and whether the bot has **Ban Members** and **View Audit Log**;
  `/antinuke mode:Off` / `mode:On` switches it for the server. The switch is saved.
- Settings: `ANTINUKE_MAX_CHANNELS` (3) and `ANTINUKE_WINDOW_MINUTES` (10).
- A staff member who really needs to delete several channels should be added to
  `ANTINUKE_TRUSTED_IDS`, or the owner switches the protection off for that moment. Other bots count
  too, so a bot that cleans up many channels needs the same.
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

> Make sure the bot's role is **above** the auto role and any roles it should manage, and that it
> has permission to delete channels for `/n`.

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
all-servers mode, leave `AUTO_ROLE_ID` empty and let each server's owner pick their role with `/aa`
(or rely on the `AUTO_ROLE_NAME` default per server).

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

## Refilling accounts

Format of `steam.txt` / `fivem.txt`: **one account per line** (any format, e.g. `login:password`).
Blank lines and lines starting with `#` are ignored; duplicate lines count once.

1. As the manager, run `/refills` and attach `steam.txt` (or `/refill5` with `fivem.txt`).
2. The bot downloads the file, saves a copy under `DATA_DIR`, and merges new accounts into the pool.
3. It replies with how many new accounts were added and how many were skipped (already given / already in pool).

---

## Data & privacy

All state lives in `DATA_DIR` (default `./data`):

- `db.json` – pools, the given‑accounts registry, per‑user usage counts, and role memory.
- `steam.txt` / `fivem.txt` – the most recent uploaded files.

When the bot starts it prints `Data: … (loaded)` or `(new, nothing was saved before)`. If it says
**new** after a restart, the host is not keeping the data folder, and tickets, remembered roles and the
account pools would be lost: use a host with persistent storage.

The `data/` folder and your `.env` are git‑ignored. **Never commit them** – they contain accounts
and your bot token.

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
    accounts.js          # account pools (never-repeat), refills, usage stats
    cooldown.js          # per-user command cooldowns
    roleMemory.js        # auto role + remembered roles
    antinuke.js          # bans anyone who deletes too many channels
    transcriptHtml.js    # the transcript page
    transcriptMedia.js   # downloads the pictures into it
    transcriptHost.js    # puts it online (R2 or the own website)
  commands/
    steam.js  fivem.js   # /steam  /5m
    refills.js refill5.js# /refills  /refill5
    nuke.js              # /n (delete all channels, keep "zavrseno")
    stats.js             # /stats (Rastrošan)
    autorole.js          # /aa (server owner sets the per-server auto role)
    antinuke.js          # /antinuke (status, on, off)
    ban.js               # /ban (admins, with a reason)
    ticketAlert.js       # /ticketalert (test the alerts)
test/                    # unit tests
```
