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
| `/stats` | everyone | Posts the **Rastrošan** embed: member count + top `/steam` and top `/5m` users (separately). |
| `/refills` | **manager only** | Attach `steam.txt` to refill the Steam pool. |
| `/refill5` | **manager only** | Attach `fivem.txt` to refill the FiveM pool. |
| `/n` | **manager only** | Deletes **all** channels one by one and leaves a single text channel named `zavrseno`. Asks for confirmation first. |

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

### Role memory

- On join, a member gets the **auto role** plus any roles they had before (restored from memory).
- Roles are saved keyed by **guild ID + Discord user ID**, so the memory survives a member leaving
  the server entirely. It updates whenever someone's roles change and when they leave.
- The bot only restores roles it is actually allowed to assign (not managed roles, and only roles
  below its own highest role).

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
**Manage Roles**, **Manage Channels**, **Send Messages**, **View Channels**.

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=268438544
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

If you set `GUILD_ID`, commands appear in that server instantly. Without it, commands register
globally and can take up to an hour to show up.

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
test/                    # unit tests
```
