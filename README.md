**English** · [Česky](README.cs.md)

# FilmVault

A Discord bot that streams films and series from your [Jellyfin](https://jellyfin.org) server, and YouTube or Kick links, into a voice channel as a Go Live stream. You type `/pust Zohan` in a text channel and a few seconds later the film is playing for everyone in the call. Anyone with permission can pause, seek, switch audio or subtitles, and the bot remembers where each film was left off.

The bot speaks English or Czech (`LANGUAGE`). Commands are named in that language too, and a Discord client set to English or Czech shows its own names.

> [!WARNING]
> **Streaming uses a selfbot.** Discord bots cannot start Go Live, so FilmVault drives a normal user account with its token. That **breaks Discord's Terms of Service and can get the account banned.** Use a throwaway account, never your own. You use this at your own risk; there is no support and no warranty (see [LICENSE](LICENSE)). The project is meant for small private servers with friends.

**Legal.** You are responsible for having the rights to everything you stream. FilmVault does not provide, host or find any media; it plays what your own Jellyfin library and the links you paste contain.

## Features

**Browse and play**
- `/pust` with autocomplete, `/filmy` (filter by genre, year, dub in your language; sort), `/serialy` (series, season, episode picker).
- Pause, seek (`1:20:00`, `+5`, `-30s`), buttons under the message, all while the Go Live session stays open.
- Films play at their own frame rate (24 fps is not turned into 30), HDR is tone-mapped to normal colours.

**Resume and history**
- Continues where you left off; the position is saved in Jellyfin (first server) or in the server's own history.
- `/videli` lists what played, who started it and where it stopped; `/zapsat` adds things watched elsewhere.

**Series**
- **Next episode and countdown:** a countdown is drawn in the corner before the end, then the next episode follows in the same Go Live stream with the same audio and subtitle languages.
- **Skip intro:** intros and end credits are detected by comparing the audio of neighbouring episodes (like the Intro Skipper plugin, without the plugin), with a black-frame fallback for credits. The choice is remembered per series.

**Tracks, sound, quality**
- Audio and subtitle choice at start or during playback; defaults prefer a dub in `PREFERRED_LANGUAGE`, else subtitles in it.
- **Night sound:** dialogue louder, explosions quieter.
- **Quality:** high (your `.env` values), medium or low for everyone, for evenings when the line cannot carry it.

**Wishlist room**
- People write film titles in a room; the bot looks them up on TMDB (rating from OMDb/IMDb if configured), keeps one list message, shows what is available in Jellyfin, drops films once watched, rolls a dice for a random available film and announces new Jellyfin films. Needs a TMDB key.

**Statistics**
- `/statistiky`: leaderboards, records, badges, personal stats, and a monthly summary post.

**YouTube and Kick**
- Paste a video, stream or channel link into `/pust` (via yt-dlp). Live streams can pause but not seek.

**Several servers**
- Each server has its own cinema, history, statistics, wishlist and settings, configured with `/setup`. Only one film plays at a time across all of them (see Limitations).

**Crash recovery**
- A failed stream restarts where it fell (up to 3 times in 10 minutes). After a crash or restart the bot removes its dead message and resumes the film if someone is still in the call. `/stav` shows how the cinema is doing.

## How it works

Two Discord accounts in one program: the **control bot** (an official bot that takes slash commands and shows buttons) and the **streaming account** (the selfbot that joins the call and sends the video). ffmpeg converts the Jellyfin stream to H.264 + Opus, ideally on a GPU. See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## Requirements

- **Node.js 22.4 or newer**
- **ffmpeg, full build** (needs `libopus`, `drawtext`, `subtitles`, and for HDR `zscale`; for intro detection the `chromaprint` muxer). On Windows, the "full" build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) works.
- A **Jellyfin server** with an API key
- A **Discord bot** (Developer Portal application) with **Message Content Intent** turned on
- A **second Discord account** for streaming (see the warning above)
- Optional: [TMDB](https://www.themoviedb.org/settings/api) and [OMDb](https://www.omdbapi.com/apikey.aspx) API keys (free) for the wishlist room, [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube and Kick

**Tested on:** Windows with an Intel GPU (`h264_qsv`, `d3d11va`). The Linux support and the Docker files in this repository are written from the code but **have not been tested on real hardware yet**. Treat them as a starting point and please report what you find.

## Install

1. **Jellyfin:** Dashboard, API Keys, create a key. Recommended: create a separate Jellyfin user for the cinema and put its name in `JELLYFIN_USER`, so its resume positions do not mix with yours.
2. **Control bot:** in the [Developer Portal](https://discord.com/developers/applications) create an application, add a bot, copy its token, enable **Message Content Intent** under Privileged Gateway Intents. Invite it with scopes `bot` and `applications.commands` and permissions View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions.
3. **Streaming account:** create a new Discord account, invite it to your server, and get its token (see the [discord.js-selfbot-v13 guide](https://github.com/aiko-chan-ai/discord.js-selfbot-v13#get-token-)). It must be able to see and join the voice channel.
4. **Channels:** a text channel for commands, a voice channel for the film, optionally a text channel for the wishlist.
5. **The bot:**
   ```bash
   git clone https://github.com/kaspyas-blip/filmvault.git
   cd filmvault
   npm install
   cp .env.example .env   # then fill it in
   ```
   On Windows, copy the file with `copy .env.example .env`. Never commit `.env`.

## Configuration

Copy `.env.example` to `.env`. Defaults are those in `src/config.js`. `.env.example` ships a few different starting values (marked below).

| Variable | Meaning | Default |
| --- | --- | --- |
| `BOT_TOKEN` | Control bot token (required) | none |
| `STREAMER_TOKEN` | Streaming account token (required) | none |
| `JELLYFIN_URL` | Jellyfin address, e.g. `http://192.168.1.50:8096` (required) | none (`.env.example`: `http://localhost:8096`) |
| `JELLYFIN_API_KEY` | Jellyfin API key (required) | none |
| `JELLYFIN_USER` | Jellyfin user whose resume and watched marks are used | the administrator |
| `TEXT_CHANNEL`, `VOICE_CHANNEL` | Channel name or ID of the first server. Read only on the very first start, then stored in `data/guilds.json`; use `/setup` afterwards and for other servers | `filmsearch`, `film` |
| `GUILD_ID` | Which server is "the first", only needed if the bot is already on several | unset |
| `FFMPEG_PATH` | Path to ffmpeg | `ffmpeg` |
| `LANGUAGE` | Language of what the bot writes: `en` or `cs` | `cs` when unset; `.env.example` sets `en` |
| `PREFERRED_LANGUAGE` | Audio and subtitles in this language are chosen first (ISO 639 code) | `cs` when unset; `.env.example` sets `en` |
| `TIMEZONE` | IANA name, for dates and for when a month starts in statistics | `Europe/Prague` |
| `YTDLP_PATH` | Path to yt-dlp. It updates itself, so the bot must be able to write there | `tools/yt-dlp.exe` on Windows, `yt-dlp` from PATH elsewhere |
| `VIDEO_ENCODER` | `h264_qsv` (Intel), `h264_nvenc` (NVIDIA), `libx264` (CPU). If a hardware encoder fails early, the bot retries that item with libx264 | `h264_qsv` |
| `HW_DECODE` | ffmpeg `-hwaccel` method: `d3d11va` (Windows), `cuda`, `vaapi` (Linux), `0` or empty = CPU | none (`.env.example`: `d3d11va`) |
| `VIDEO_HEIGHT` | Maximum output height. Without Nitro, 720 | `720` |
| `VIDEO_FPS` | Maximum frame rate; films keep their own rate below it, faster sources are halved | `30` |
| `VIDEO_BITRATE` | Video bitrate in kb/s | `3500` (`.env.example`: `2500`) |
| `AUDIO_BITRATE` | Audio bitrate in kb/s | `128` |
| `IDLE_LEAVE_MINUTES` | Leave the call after this long with nothing playing | `5` |
| `WISHLIST_CHANNEL` | Wishlist room of the first server | `filmy` |
| `TMDB_API_KEY` | TMDB key; without it the wishlist room is off | unset |
| `OMDB_API_KEY` | OMDb key for IMDb ratings (optional) | unset |
| `ANNOUNCE_ROLE` | Role ID or name pinged when new films appear in Jellyfin | unset |
| `ALLOWED_ROLE_ID` | Role ID or name allowed to control the cinema | everyone |

## First run

```bash
npm run doctor
```

`doctor` changes nothing. It checks Node, `.env`, ffmpeg and its encoders and filters (including a real test encode when you use a hardware encoder), yt-dlp, whether `data/` is writable, Jellyfin and the API key, both Discord tokens and the Message Content Intent. It exits with 1 if something required is missing. Fix what it lists, then:

```bash
npm start
```

On the first start the bot sets up one server from `TEXT_CHANNEL` and `VOICE_CHANNEL` if it can find them. Any other server (or a server where that failed) shows only `/setup` (`/nastavit` in Czech), which a member with the Manage Server permission runs once: pick the text and voice channel and optionally the wishlist room and a role allowed to control the cinema. It applies immediately, no restart. Afterwards the bot posts its help message in the text channel. Join the voice channel, run `/pust` with a title, and click the live stream.

Command names: the table below gives both. Commands are named in the `LANGUAGE` of the bot, and a Discord client set to English or Czech shows its own names; they are the same command.

## Commands

All of these work only in the cinema's text channel (and only for the allowed role, if one is set).

| Command | What it does |
| --- | --- |
| `/nastavit` (setup) | Admin only. Set text and voice channel, optional wishlist room and role; `pro_vsechny` removes the role restriction, `bez_seznamu` turns the wishlist off. Waits if the cinema is playing |
| `/pust film [od] [zvuk] [titulky]` | Play a title or a YouTube/Kick link; `od` = start time |
| `/pauza`, `/pokracuj` | Pause and continue |
| `/posun cas` | `1:20:00` absolute, `+5` / `-2` minutes, `+30s` seconds |
| `/zvuk`, `/titulky` | Change audio track or subtitles while playing |
| `/kvalita [uroven]` | High, medium, low for everyone |
| `/hlasitost [rezim]` | Normal or night sound |
| `/statistiky [kdo] [obdobi]` | Cinema or personal statistics |
| `/stav` | Cinema status: stream, Jellyfin, Discord, host load |
| `/filmy`, `/serialy` | Browse the library and play from a menu |
| `/videli` | History; unfinished items can be continued, entries removed |
| `/zapsat film [kdy] [skoncili]` | Add something watched elsewhere to the history |
| `/hraje` | What is playing |
| `/stop`, `/odejdi` | Stop, or stop and leave the call |

Under the now-playing message there are buttons (minus 1 min, pause, plus 1 min, plus 10 min, stop; for series also skip intro and cancel next episode). The cinema stops 2 minutes after everyone leaves the call.

## Tools

| Command | What it does |
| --- | --- |
| `npm run setup` | Asks for tokens and addresses, picks an encoder that really works here, writes `.env`, then runs the doctor. Keeps what `.env` already has |
| `npm run doctor` | Checks settings, ffmpeg, Jellyfin and both Discord accounts, and says what to fix. Changes nothing |
| `npm run diagnostics` | Writes `diagnostics.txt` for a bug report, with secrets and private addresses removed. Read it before sharing |
| `npm run update` | Moves a git checkout to the newest version and goes back if installing or the checks fail. Stop the bot first; it never restarts it. To update automatically, schedule stop, update and start for a quiet hour |

## Limitations

- **One film at a time across all servers.** The streaming account can be in one call at once. Other servers get a "playing elsewhere" message.
- **720p and 30 fps without Nitro** on the streaming account. Set `VIDEO_HEIGHT` and `VIDEO_FPS` higher only if the account has Nitro.
- Only the first server stores its position in Jellyfin; other servers resume from their own history.
- Dolby Vision profile 5 (no HDR10 base layer) cannot be tone-mapped. External image subtitles are not supported.
- Seeking and pausing restart ffmpeg at the new position, so there is a short freeze.
- Web links are limited to YouTube and Kick; live streams cannot be seeked.
- Linux and Docker: see the next section, untested.

## Docker (untested on real hardware)

`Dockerfile` and `docker-compose.yml` build a software-encoding image based on `node:24-bookworm-slim` with ffmpeg and the standalone yt-dlp binary.

```bash
cp .env.example .env     # fill in the tokens and Jellyfin; leave the encoder lines, compose overrides them
docker compose build
docker compose run --rm filmvault npm run doctor
docker compose up -d
```

- `JELLYFIN_URL` must be reachable **from inside the container**. `localhost` is the container itself.
- Data lives in the `filmvault-data` volume (`/app/data`).
- Intel GPU: uncomment the `/dev/dri` lines in `docker-compose.yml` and set `VIDEO_ENCODER=h264_qsv`, `HW_DECODE=vaapi`. The image does not ship the Intel media drivers, so this needs extra work and has not been tried.
- Without Docker on Linux: install Node, ffmpeg and yt-dlp, set `YTDLP_PATH` if yt-dlp is not on PATH, and run it under systemd or pm2.

## Troubleshooting

| Problem | Try |
| --- | --- |
| `Missing BOT_TOKEN in .env` (or another variable) | The variable is missing; run `npm run doctor` |
| Slash commands do not appear | The bot was invited without `applications.commands`; reload Discord (Ctrl+R) |
| ffmpeg error and no picture | `npm run doctor`; without an Intel GPU set `VIDEO_ENCODER=libx264` and `HW_DECODE=0`. The bot also retries once with the software encoder if a hardware encoder fails early |
| Stuttering, lots of *Packets Lost* / *NACK* | Lower `/kvalita`, lower `VIDEO_BITRATE` or `VIDEO_HEIGHT`, try another voice region. The bot logs video pacing once a minute |
| HDR films look washed out | Your ffmpeg has no `zscale`; use a full build |
| The wishlist room ignores messages | Turn on Message Content Intent and set `TMDB_API_KEY` |
| Resume starts at a strange place | Set `JELLYFIN_USER` to a dedicated user |
| "The streaming account is not on this server" | Invite the streaming account; it must see the voice channel |
| YouTube or Kick links fail | yt-dlp missing or outdated; check `YTDLP_PATH` (the bot runs `yt-dlp -U` daily) |

The log goes to the console, or to `runtime.log` when started by `tools/install-task.ps1` (Windows scheduled task that starts at boot and restarts on crash).

## Development

```bash
npm test        # node --test, no Discord or Jellyfin needed
npm run lint    # eslint
```

CI runs both on Linux. Helper scripts in `tools/`: `selftest.mjs` (whole ffmpeg to stream chain without Discord), `stream-bench.mjs`, `jellyfin-check.mjs`, `live-test.mjs`.

- [ARCHITECTURE.md](ARCHITECTURE.md): how it is built and why
- [CONTRIBUTING.md](CONTRIBUTING.md): issues, questions, conventions

## License

[MIT](LICENSE)
