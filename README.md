# 35xw – Discord bot

A Discord bot that hands out **Steam** and **FiveM** accounts (never the same account twice),
gives everyone an **auto role** on join, **remembers each member's roles** by their Discord ID
(even after they leave), shows a **"Rastrošan"** stats board, and has a **delete‑all** safety switch.

---

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/steam` | everyone | Gives you one Steam account that has **never** been given to anyone on the server. |
| `/5m` | everyone | Gives you one FiveM account that **no one** has ever generated. |
| `/help` | everyone | Lists every command and how to use it. |
| `/stats` | everyone | Posts the **Rastrošan** embed: member count + top `/steam` and top `/5m` users (separately). |
| `/aa` | **server owner** | Sets the role every new member gets on **this** server, e.g. `/aa @Member`. Run with no role to see the current setting. |
| `/refills` | **manager only** | Attach `steam.txt` to refill the Steam pool. |
| `/refill5` | **manager only** | Attach `fivem.txt` to refill the FiveM pool. |
| `/b [mode]` | **manager only** | Bypass switch: while on, the manager is exempt from every limit (command cooldowns, one-open-ticket rule, ticket cooldown). `/b` toggles; `mode:on/off` sets it. Persisted across restarts. |
| `/n` | **manager only** | Deletes **all** channels one by one and leaves a single text channel named `zavrseno`. Asks for confirmation first. |
| `/v [staff]` | **staff** | Posts the **35xw verification** panel with a 🎫 **OPEN TICKET** button. Optionally sets the staff role. |
| `/close` | opener / staff | Closes the current ticket (renames it to `close-NNNN`). |
| `/open` | **staff** | Reopens a closed ticket. |
| `/add` | **staff** | Adds a user or role to the current ticket. |
| `/ping` | everyone | Bot latency. |

- Every command has a **30‑second cooldown per user** (configurable via `COOLDOWN_SECONDS`).
- Account replies are **ephemeral** – only the person who ran the command can see the account.
- The **manager** is the only person allowed to refill accounts or run `/n`. The manager is
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
  below its own highest role).
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
- The ticket greets the opener with *"Please wait for your role, our moderators will be here
  shortly."* and a 🔒 **Close** button.
- **Close** (opener or staff) renames the channel to **`close-NNNN`**, posts *Ticket closed by
  @user*, **removes the opener's access**, and shows the staff controls: 📄 **Transcript**,
  🔓 **Open**, ⛔ **Delete**.
- **Transcript** saves the whole conversation as a real transcript file, **`transcript-NNNN.txt`**
  (same number as the ticket), into its own private channel **`transcript-NNNN`** inside the
  **Transcript-01** category. Discord allows 50 channels per category, so when Transcript-01 is full
  (or creating a channel fails) the bot creates **Transcript-02** and remembers it, never re-checking
  a full category (`TRANSCRIPTS_PER_CATEGORY`, max 50). The ticket channel itself stays put as
  `close-NNNN` so staff can Transcript and then Delete; saving twice reuses the same transcript channel.
- **Open** brings a closed ticket back as `ticket-NNNN` and restores the opener's access;
  **Delete** removes the channel after a short countdown.
- `/add` gives someone access to a ticket; `/close` and `/open` mirror the buttons.

A ticket keeps **one number for its whole life** (`ticket-0007` → `close-0007` →
`transcript-0007` / `transcript-0007.txt`), so tickets and transcripts can never get mixed up. All
ticket state lives in the database, so numbering, cooldowns and the current Transcript-XX slot
survive restarts.

**Every server is independent.** Ticket numbers, categories, the Transcript-XX slot, cooldowns and the
staff role are all stored per server, so each server starts at `ticket-0001` and never interferes
with another. (Only the Steam/FiveM account pools are shared, on purpose, so the same account can
never be handed out twice anywhere.)

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
  commands/
    steam.js  fivem.js   # /steam  /5m
    refills.js refill5.js# /refills  /refill5
    nuke.js              # /n (delete all channels, keep "zavrseno")
    stats.js             # /stats (Rastrošan)
    autorole.js          # /aa (server owner sets the per-server auto role)
test/                    # unit tests
```
