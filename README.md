# CS2 Account Manager

*[Français](README.fr.md)*

A desktop manager for **your own** Steam/CS2 accounts: Prime status, competitive
cooldown, VAC ban, Premier rank, and launching an account straight into the
Steam client.

Electron throughout: the UI is plain HTML/CSS/JS, the engine uses `steam-user` +
`globaloffensive` in the main process. One stack, one command.

## Install

**[⬇ Download the latest release](https://github.com/HazarDos1/CSAM-/releases/latest)**
— a self-contained Windows installer.

Nothing else to install: Node.js, Electron and the Steam libraries are already
inside the executable. It installs per-user, so no administrator rights are
needed.

> The executable is not code-signed (a certificate costs a few hundred euros a
> year). Windows SmartScreen will therefore warn you on first run:
> *More info* → *Run anyway*.

### Or from source

```
npm install
npm start
```

On first launch the app asks for a **master password**. It encrypts the vault
(`%APPDATA%\cs2-account-manager\vault.json`) holding Steam passwords,
`shared_secret` values and refresh tokens. The password is stored nowhere: lose
it and the vault is unrecoverable.

## Language

The interface is in **English by default**. The globe button at the bottom of
the left rail switches to French, and the choice is remembered between runs.

The two dictionaries live in `src/renderer/i18n.js`. English is the reference:
a key missing from French falls back to the English string rather than showing
a blank, and an unknown key renders as its own name so the gap is visible
instead of silent.

The whole interface goes through it — including every modal: adding an
account, editing, SDA import/export, vault backup, mobile confirmations and
the full authenticator flow.

Messages written by the engine (the main process) are still French only. The
renderer never branches on their wording: when it needs to recognise a specific
failure it reads a `kind` carried alongside the message, so a future translation
of the engine cannot silently break the UI.

## Adding your accounts

1. **Import SDA** → pick your `maFiles` folder and enter the SDA password. This
   recovers `account_name`, `shared_secret` and `identity_secret`.
2. `.maFile` files do **not** contain Steam passwords. Enter them per account
   afterwards (*Edit* button), or import an existing `accounts.json` through
   *Import SDA → Import an accounts.json*.

The accepted JSON shape:

```json
[{ "username": "...", "password": "...", "shared_secret": "...", "steamid": "..." }]
```

Delete the plaintext JSON after importing — the encrypted vault replaces it.

### Add an account and create its authenticator in one go

**Add** button → tick **"Create the Steam authenticator right away"**. The account
is saved to the vault first, then the flow continues without going back to the
detail panel: login → `AddAuthenticator` → revocation code (ticking "I wrote it
down" is mandatory) → SMS code → `FinalizeAddAuthenticator`. At the end, the
account generates its Steam Guard codes inside the app.

The `shared_secret` field disappears when the box is ticked: the two paths are
mutually exclusive — either you paste an existing secret, or Steam generates one.

If the account **already** has an authenticator, the app stops and warns before
doing anything — removing the old one costs 15 days of trade lockdown.

The account is saved **before** the creation attempt: if that fails, nothing is
lost and the *Create an authenticator* button in the detail panel picks up where
it left off.

### Creating an authenticator without SDA

For an account that has none yet, the app can create one: detail panel →
**Create an authenticator**. It calls `ITwoFactorService`
(`AddAuthenticator` → SMS → `FinalizeAddAuthenticator`) and stores
`shared_secret`, `identity_secret` and `revocation_code` encrypted in the vault.

**The writes go through the web API, not the Game Coordinator.** This is not a
stylistic choice: the CM happily serves `ITwoFactorService` *reads*
(`QueryStatus` answers `eresult 1 OK`) but refuses the *writes* — `AddAuthenticator`
and `FinalizeAddAuthenticator` both come back `eresult 2 Fail` even when every
precondition Steam exposes is satisfied. The exact same requests over HTTPS
succeed. The engine therefore sends writes to
`https://api.steampowered.com/ITwoFactorService/...` with the access token taken
from the `steamLoginSecure` cookie, and keeps the CM only as a fallback.

The account needs a **phone number attached and verified**. When Steam refuses,
the app does not guess at the reason: it queries `TwoFactor.QueryStatus` and
`IPhoneService/AccountPhoneStatus` and reports what they actually say —
`authenticator_allowed`, `email_validated`, `verified_phone`, and above all
`can_add_two_factor_phone`, which is what blocks a verified number from carrying
a second authenticator.

The **revocation code** is shown large before finalisation, and you must tick "I
wrote it down" to continue. That is not politeness: it is the account's only
fallback, Steam never shows it again, and if you lose both the master password
and that code the account cannot be recovered without support. It is saved to
the vault **as soon as Steam answers**, before the SMS code is even typed — so
that a failure at finalisation does not take it down too. An authenticator
obtained but not finalised is flagged as such in the detail panel, and the
button becomes *Finish activation*, which resumes straight at the SMS step
rather than restarting a creation Steam would reject as a duplicate.

Removing an authenticator (`RemoveAuthenticator`, revocation code required)
switches the account back to e-mail Steam Guard and triggers **15 days of trade
and market lockdown**. If you still have access to the current codes, importing
the existing `.maFile` is far cheaper.

## Scanning

*Scan all* or *Scan stale* refreshes the accounts. For each one the engine logs
into Steam, launches CS2 headless, waits for the Game Coordinator, collects the
data, then disconnects.

What it reports: Prime status, competitive cooldown (`penalty_seconds` /
`penalty_reason`), VAC ban, Premier rank (CS Rating), level and XP, persona
name, avatar, SteamID, last CS2 match.

Accounts **on cooldown are excluded from bulk scans**: the end of the penalty is
an absolute date counted down locally, so a rescan would reveal nothing new and
would spend both a login and part of the anti-rate-limit budget. The *Scan*
button in the detail panel is still there to force one case by case.

### What globaloffensive does not do on its own under CS2

Three things the engine adds on top of the library, because the CS2 GC no longer
behaves like the CS:GO one:

- **It goes through the player profile, not the matchmaking hello.** This is the
  decisive point. globaloffensive exposes `accountData`, fed by
  `MatchmakingGC2ClientHello` (9110) — the CS:GO path. **The CS2 GC no longer
  sends it**, even when asked: the engine requests `MatchmakingClient2GCHello`
  (9109) every 5 s, the GC never answers, and the wait ends in a timeout.
  The path that does answer is `ClientRequestPlayersProfile` (9127) on your own
  account → `PlayersProfile` (9128), whose `account_profiles[0]` has the *type*
  `MatchmakingGC2ClientHello`. The engine sends both in parallel and keeps the
  first reply; in practice that is 9128, in ~500 ms. The `gcSource` field of the
  raw data says which one was used.

  **9128 does not carry penalties.** It is a *public* view, requestable for any
  player, so the GC strips the private fields `penalty_seconds`, `penalty_reason`
  and `vac_banned` — the reply is 37 to 53 bytes and contains only `account_id`,
  `player_level`, `player_cur_xp` and `rankings`. Verified across `request_level`
  0 to 255: byte-for-byte identical replies, on a clean account as on a
  penalised one.

- **It reads penalties from `ClientWelcome.game_data2`.** That is where they
  live, and nowhere else. The CS2 GC no longer sends
  `MatchmakingGC2ClientHello` (9110) as a standalone message — it **serialises it
  into the `game_data2` field of `ClientWelcome` (4004)**, which nobody decodes:
  globaloffensive treats it as an opaque blob. ~282 bytes holding
  `penalty_seconds`, `penalty_reason`, `vac_banned`, `global_stats`. The engine
  decodes it, checks the `account_id` is really ours, and uses it as the
  reference source.

  Unlike 9128, this message is **authoritative**: protobuf does not encode zeros,
  so on *this* message a missing `penalty_seconds` genuinely means "no penalty".
  On 9128 it means nothing at all, and the app then shows "not reported by the
  GC" rather than concluding (the original false negative came from exactly
  there: `Number(null || 0)` is `0`).

  As a safety net the engine also decodes `ServerNotificationForUserPenalty`
  (9118) and `MatchmakingGC2ClientAbandon` (9112), which globaloffensive drops
  silently.

  `npm run probe:gc -- <account>` replays this whole diagnosis on a given account
  and lists every message received from the GC.

- **It announces the real client version.** The library hard-codes
  `version: 2000244` (a late-2023 CS2 build). The engine reads `ClientVersion`
  from the `steam.inf` of your CS2 installation (every Steam library is scanned)
  and sends that instead. Worth noting: the GC's `ClientWelcome` carries no
  `version` field, so automatic realignment on the GC-announced version never
  actually fires — `steam.inf` is the authority (or `gcClientVersion` in the
  settings, `null` meaning automatic).

These additions are independent: the GC accepts the session (`ClientWelcome`
4004) whatever version is announced, and ignores 9109 in every case.

Every scan keeps a timestamped **Game Coordinator log** (messages sent, received,
handled or not). It is visible in the detail panel — under "Last scan failed" or
in "Raw data" — and printed by `scan:cli`.

### One sentinel value worth knowing about

`penalty_seconds` is declared `optional uint32`. When the GC sets it to −1 it
comes back as 4 294 967 295, which is 49 710 days. That is not a duration, it is
a sentinel — taking it literally put the cooldown's end in the year 2162 and
filed a healthy account under "Cooldown". Anything beyond 30 days (CS2 caps
competitive cooldowns at 7) is therefore rejected as a countdown, the raw value
stays visible in the detail panel, and a permanent sanction is still decided by
`penalty_reason`, never by the duration.

## Rate limiting

This is the main constraint, and the app is built around it.

- An account's **first** login uses the password plus a Steam Guard code
  generated from the `shared_secret`. That endpoint
  (`BeginAuthSessionViaCredentials`) is aggressively limited by Valve: past a
  certain pace, EResult 84.
- Steam then returns a **JWT refresh token**, which the app keeps in the vault.
  Later scans use it and never touch that endpoint again.
- Scans are serialised, with a minimum delay between logins — 25 s by default for
  a password login, 6 s for a token login (configurable).
- If Steam throttles anyway, the app pauses for ~31 min, says so in the UI, and
  resumes the queue on its own.

Practical consequence: **the first full scan is slow**, the next ones are fast.
The "Cached tokens" counter in the sidebar shows how many accounts have already
switched to token mode.

The local clock is aligned with Steam's before every code generation, and a code
already consumed is never replayed — those are the two usual causes of
`TwoFactorCodeMismatch`.

The third cause is sneakier: **Steam also returns EResult 88 when several
password logins follow each other on one account** (a 2FA throttle, distinct from
rate limit 84). A "code rejected" right after a successful login with the same
`shared_secret` is almost always that. The app therefore does not flip the
account to "Expired" on that signal alone: it marks it as an error, keeps its
refresh token, and waits 3 min before the next account. The real cure is
unchanged — scan by token, not by password.

## Launching an account

One click should end with Steam signed in, nothing typed. Two modes get there:

- **Remembered session** — writes `AutoLoginUser` to the registry, sets
  `AutoLogin=1` on the account in `loginusers.vdf`, restarts Steam. Steam then
  signs in on its own, **with no password and no Steam Guard code**: the session
  token it kept acts as the second factor. No secret travels.
- **Password** — `steam.exe -login <user> <pass>`. Always works, but the password
  is visible in the process list for the duration of the launch. Keep it for an
  account's first login.

Two fields govern the first mode, and confusing them is what used to send you
back to the sign-in screen: `MostRecent` only *preselects* the account in the
list, while `AutoLogin` is the one that decides whether Steam signs in by
itself. Writing the first without the second leaves Steam waiting, and
`AutoLoginUser` in the registry does not override it — the vdf wins.

And one Steam setting overrides the vdf in turn. While
`AlwaysShowUserChooser` is `1` in `config/config.vdf` (the *Choose the account
to use each time Steam launches* toggle on the "Who's playing?" screen), Steam
forces the account picker **and rewrites `loginusers.vdf` behind you**, putting
`AutoLogin` back to `0` on the account you just selected. Setting `AutoLogin`
without clearing that toggle therefore achieves nothing: Steam undoes the work
on the next launch. The app clears it while Steam is shut down.

`config.vdf` also holds Steam's session tokens, so it is never re-serialised:
only that single value is replaced, and the remaining bytes are written back
untouched.

*Auto* mode (the default) tries the remembered session, then **checks that Steam
actually signed in** by reading `ActiveUser` under
`HKCU\Software\Valve\Steam\ActiveProcess`, which is `0` while the sign-in
screen is up. If Steam stayed there, it retries with the password on its own.

That check is not fussiness: `RememberPassword=1` in `loginusers.vdf` records
only the *intent* to keep the session, never that a usable token still exists.
The two diverge as soon as the token expires, and without the check you were
left staring at the sign-in screen with a code in the clipboard and no
explanation. A second, independent signal backs it up — Steam bumps the
account's `timestamp` in `loginusers.vdf` on every successful sign-in — so one
signal failing cannot wrongly force the password path.

### The Steam Guard code

Steam accepts no 2FA code on the command line; there is no official option. So
the code is always copied to the clipboard, and, if *Type the Steam Guard code
into the Steam window* is on, typed into the window for you.

That only matters the **first** time an account signs in on the machine. After
that Steam keeps the session and asks for nothing.

It types only when the foreground window belongs to `steamwebhelper`, verified
immediately before the keystrokes. Without that guard, a badly timed window
switch would type the code into a chat or an address bar. If the check fails
nothing is typed, the reason is reported, and the clipboard still has the code.

## Backing up the vault

*Backup* button in the Options frame. The file it writes is a copy of the
**already-encrypted** vault: nothing is decrypted on the way out, the master
password is never asked for, and the result is no more readable than the
original. The SHA-256 of the copy is verified against the source after writing.

Restoring asks for the backup's master password and **verifies it decrypts before
replacing anything** — restoring a backup whose password you lost would otherwise
overwrite a working vault with an unusable file. The replaced vault is kept
alongside as a timestamped `.bak`.

## Command-line tools

```
npm run check:mafile -- "C:\path\to\maFiles"
```
Decrypts the `.maFile` files and prints each account's Steam Guard code. If it
matches your phone, the `shared_secret` is good.

```
npm run scan:cli -- <account_name>
npm run probe:gc -- <account_name>
```
`scan:cli` runs a real scan from the terminal and prints the **raw** Game
Coordinator data — the tool for diagnosing a failing login and for reading the
actual `penalty_reason` codes. `probe:gc` lists every GC message received.

Both accept whatever you have in front of you: login name, Steam persona name,
label or SteamID, partial and case-insensitive. The UI only shows the persona
name, so `npm run scan:cli -- ernesto` finds `internalbee9048` and says so.

```
npm run ranks     extracts the rank badges from your CS2 installation
npm run icon      regenerates build/icon.ico
npm run dist      builds the Windows installer
```

## What is exact, and what is not

The GC protobuf guarantees: `penalty_seconds`, `penalty_reason`, `vac_banned`,
`player_level`, `player_cur_xp`, `rankings[].{rank_id, wins, rank_type_id}`.
The cooldown countdown is therefore exact — it is converted to an absolute end
date at scan time, then counted down live.

Valve does not publish the **enumerations** behind `penalty_reason` and
`rank_type_id`, though. The labels in `src/main/cs2data.js` are community
decoding, given as best effort. The raw code is always shown next to the label,
and an unknown code is displayed as-is rather than guessed at. One exception is
first-hand: code 22 was observed on an account where CS2 displayed "Global
penalty — VAC detected suspicious activity in your playstyle", with
`penalty_seconds=544203`. If you observe a code that does not match, fix the
`PENALTY_REASONS` table — it is meant for that.

Match history ("last CS2 match") goes through `requestRecentGames`, which Valve
changed with CS2: it may legitimately return nothing. That is not treated as an
error. "Last seen" comes from the Steam profile and is reliable.

## Security

- Vault encrypted with AES-256-GCM, key derived from the master password by
  scrypt (N=2¹⁷, 128 MiB per attempt). GCM authenticates: a wrong password fails
  cleanly rather than yielding garbage. The 16-byte tag length is enforced —
  Node otherwise accepts truncated GCM tags down to 4 bytes.
- The master key is never written to disk. Only the scrypt parameters and the
  salt are stored in cleartext, alongside the ciphertext.
- The renderer has neither filesystem nor secret access. `contextIsolation` on,
  `nodeIntegration` off, narrow IPC bridge in `preload.js`. Passwords and
  `shared_secret` values leave the main process only on an explicit action
  (*Show password* button).
- Every log line goes through `redact.js`, which masks JWTs and about twenty
  secret field names. This exists for a concrete reason: steam-user relays
  steam-session's debug output, which contains full `refreshToken` and
  `accessToken` values — a refresh token is a bearer credential that opens the
  account with no password and no 2FA.
- During a scan the client connects **invisible** by default, so your contacts
  are not told you are playing CS2.

## Layout

```
src/main/
  main.js            Electron main process, IPC channels
  preload.js         contextBridge bridge
  vault.js           encrypted vault (accounts, secrets, tokens, scan cache)
  crypto.js          scrypt + AES-256-GCM
  sda.js             reads SDA .maFile (PBKDF2-SHA1 50k + AES-256-CBC)
  scanner.js         engine: queue, anti-rate-limit, Steam session + GC
  cs2data.js         GC data normalisation, categories, labels
  authenticator.js   creating and removing a Steam authenticator
  confirmations.js   mobile trade/market confirmations
  launcher.js        launching an account in the Steam client
  redact.js          masks secrets at the single logging exit point
src/renderer/
  index.html         markup, annotated with data-i18n attributes
  renderer.js        the whole UI (no framework)
  i18n.js            English and French dictionaries, language switch
  styles.css         theme
tools/
  scan-cli.js        a scan from the terminal, raw GC data
  probe-gc.js        lists every message received from the GC
  check-mafile.js    decrypts .maFile and prints the codes
  extract-ranks.js   extracts the rank badges from the local CS2 install
  vpk.js             reads Source 2 VPK archives (no dependency)
  make-icon.js       draws build/icon.ico (PNG + ICO encoded by hand)
  prompt.js          terminal prompt helper
```

## A note on SteamIDs

SDA writes SteamIDs as bare numbers (`"steamid":76561198123456789`).
`JSON.parse` silently rounds them above 2^53 — `…789` becomes `…780`.
`sda.parseJson()` turns them into strings before parsing. Any new read of JSON
coming from SDA or Steam must go through that function.

## Rank badges

If you took the installer, they are already in it: nothing to do.

They are **not shipped in this repository**, however: they are game assets owned
by Valve, and redistributing them is not the same thing as reading them from
your own copy. From source, extract them from your CS2 installation:

```
npm run ranks
```

The tool reads `pak01_dir.vpk` and writes 62 files into `src/renderer/ranks/`:
the 19 skill-group badges (vector SVG) and the 40 level medals (128×128 PNG).
Without them the app draws its own badges — nothing breaks, it is just less
pretty.

## Building the executable yourself

```
npm run dist
```

Produces `dist/CS2-Account-Manager-Setup-<version>.exe` — exactly what is
published in the [releases](https://github.com/HazarDos1/CSAM-/releases).

The vault lives in `%APPDATA%\cs2-account-manager\`, **outside** the install
directory: uninstalling or updating does not erase it.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with Valve in any way. This is for someone managing **their own**
accounts: it reads states Steam already exposes to their owner, and circumvents
no protection.
