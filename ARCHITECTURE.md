# Architecture

FilmVault is one Node.js (ESM) process holding two Discord clients: a **control bot** (`discord.js`, slash commands and buttons) and a **streaming account** (a selfbot via `@lng2004/discord.js-selfbot-v13` plus `@dank074/discord-video-stream`, which speaks the Go Live protocol). Official bots cannot start Go Live, hence the second account. ffmpeg turns a Jellyfin (or yt-dlp) stream into H.264 + Opus in a NUT container, which the library packetizes and sends.

## Modules

| Module | Job |
| --- | --- |
| `index.js` | Creates the one `Player`, logs the streaming account in, starts the bot |
| `src/bot.js` | Control client, one `cinema` per server, `/nastavit`, startup (loads `data/guilds.json`, falls back to `.env` for the first server), daily yt-dlp update, forwards player events to the right cinema |
| `src/cinema.js` | The cinema of one server: command and button handlers, now-playing message, next episode, recovery, restart resume, viewer counting, progress saving |
| `src/player.js` | The streaming side: voice join, ffmpeg sessions, pause/seek/track changes, stall watchdog, library patches |
| `src/ffmpeg.js` | Builds ffmpeg arguments (scaling, HDR tone mapping, subtitles, countdown overlay, night sound, encoder options) |
| `src/jellyfin.js`, `src/web.js` | Jellyfin API; YouTube/Kick through yt-dlp (items shaped like Jellyfin items plus a `web` field) |
| `src/segments.js` | Intro and credits detection (chromaprint audio fingerprints of neighbouring episodes, black frames) |
| `src/browse.js`, `src/wishlist.js`, `src/movieinfo.js`, `src/stats.js`, `src/help.js` | Lists and pickers, wishlist room (TMDB/OMDb), statistics, help message |
| `src/store.js` | Crash-safe JSON file; `history.js`, `settings.js`, `quality.js`, `guilds.js` are built on it |
| `src/config.js`, `src/commands.js`, `src/timer.js` | `.env` parsing, slash command definitions, 1 ms timer resolution on Windows |

## From `/pust` to Go Live

1. `bot.js` receives the interaction and hands it to the cinema of that guild; with no cinema only `/nastavit` is answered.
2. `cinema.handleInteraction` checks the channel (cinema's text channel only) and the allowed role, then `handlePlay`: parse the start time, refuse if another server's cinema holds the player, defer the reply.
3. `resolveItem` turns the text into an item: a 32-hex Jellyfin ID, a YouTube/Kick link (resolved with yt-dlp), or a title search.
4. `beginPlayback` rechecks `busyElsewhere()` and the streaming account's membership, counts the start in `starting`, and calls `startItem`.
5. `startItem` picks tracks (Czech dub, else Czech subtitles, unless chosen), the resume position (Jellyfin for the first server, own history for others), finds the next episode and calls `player.play(...)`.
6. `Player.play` downloads the subtitle file (outside the queue, it can take a minute), then queues: join the voice channel, set state, `startSession`.
7. `startSession` builds the ffmpeg arguments, spawns ffmpeg and gives its stdout to `playStream` with `{ type: 'go-live' }`. Frames pass through a per-session view of the shared Go Live connection.
8. Back in the cinema: poster, now-playing message with buttons, `nowplaying.json` saved, segment detection started in the background.

## The player's queue and stale starts

Everything that changes the stream (`play`, `pause`, `resume`, `seek`, track/quality/sound changes, stop, leave, idle leave) goes through `Player.run(task)`, a promise chain, so two operations never interleave.

`play` is slow before it reaches the queue (subtitle extraction, then joining the call). So `play`, `stop` and `leave` raise a counter, `player.request`. A queued `play` first compares its own number with the current one and returns `false` if a newer request exists, and checks again after the join. The cinema reads that `false` and tells the user the start was cancelled. Result: `/stop` during a slow start really stops, and two quick `/pust` end with only the last one.

The same idea guards sessions: every callback compares `this.session !== session` and does nothing if the session was replaced.

## Why exit code 0 is not trusted

ffmpeg exits with 0 when its input breaks: Jellyfin restarts, a yt-dlp address expires, a live stream is cut. Treating that as "finished" would end films in the middle and start the next episode. So `settle()` calls `reachedEnd()`: the position must be within 60 s of the item's duration (live streams never reach the end). A clean exit short of the end is a failure with the message "source interrupted" and goes to recovery. A failure within 15 s of the start with a hardware encoder retries once with libx264.

Position is not wall-clock time: it is the start offset plus the media time of frames actually sent (`session.mediaMs`), so a hiccup in ffmpeg's output does not move it. A watchdog (`tick`) restarts ffmpeg if no video frame arrives for 15 s, and after 3 such restarts in a row reports a failure.

## Recovery

- **Stream failed:** the player emits `failed`; the cinema's `recoverPlayback` starts the item again 5 s before the failure point, with the same tracks, after 3 / 15 / 45 s, at most 3 times in 10 minutes and only while someone is in the call. The old message is replaced; `/stop` or everyone leaving cancels it.
- **Bot crashed or restarted:** `nowplaying.json` is saved every 15 s (position, tracks, message ID, viewers). On start, dead now-playing messages are deleted and, if the file is fresh and someone is in the voice room, playback resumes (5 s back). Otherwise the interrupted watch is written to the history and its message gets a "go on" button.
- **Streaming account thrown out of the call:** treated as a failure of the current item.

## Several servers, one Player

Each guild gets its own `createCinema(...)` closure (channels, role, data directory, quality, sound, history, wishlist). There is exactly one `Player`, because one account can be in one call. `busyElsewhere()` lets a cinema see whether another one holds the player, and `bot.js` forwards the player's events (`stopped`, `ended`, `failed`, `introSkipped`) to the cinema of `player.guildId`. The first server keeps its data in `data/` and its progress in Jellyfin (one Jellyfin account cannot tell servers apart); others use `data/guilds/<id>/` and their own history.

## Data

Relative to the working directory:

- `data/guilds.json`: servers and their channels, roles, data directory
- `data/segments.json`: detected intros and credits (shared)
- `data/` or `data/guilds/<id>/`: `history.json`, `settings.json`, `quality.json`, `wishlist.json`, `nowplaying.json`
- `tmp/`: extracted subtitle files and `overlay.txt` (the countdown text ffmpeg re-reads every half second). Safe to delete when stopped.

`store.js` (`jsonFile`) makes writes survive a crash or power cut: write to `<file>.tmp`, `fsync`, copy the previous good file to `<file>.bak`, then rename over the original (retrying on Windows file locks). Writes to one file are serialized. If a file cannot be parsed it is kept as `<file>.corrupt-<time>` and the backup is used, never silently overwritten with empty data. A read error that is not bad content (a locked file) is retried and then thrown, not taken for empty.

## Why the library is patched

`player.js` patches `@dank074/discord-video-stream` at runtime rather than forking it (see the comments there for the evidence):

- **NACK:** the library never puts our SSRCs in the session description, so every resend request from Discord was dropped and each lost packet froze the picture until the next keyframe. `handleReady` is wrapped to add them.
- **Seeks and pauses keep the stream open:** `createStream` and `stopStream` are wrapped so the Go Live connection is reused; ffmpeg restarts under it. RTP clocks are moved forward by the real gap on restart, rounding drift of the frame time is carried (otherwise audio slipped against video across episodes), and video is held to the second keyframe so viewers do not see a blocky second.
- **Pacing and playout delay:** a fixed send rate derived from the bitrate instead of 1.25x of the last 250 ms (which burst), and a receiver buffer up to 600 x 10 ms so resent packets arrive in time.
- **Per-session view:** frames of an aborted ffmpeg still flush after an abort and corrupted the next session, so each session writes through a view that drops them once its signal is aborted.
- **Leaving:** the library's leave sends `guild_id: null`, which did not take the account out of a call it was left in after an outage; `leaveVoice` names the server.

These patches rely on library internals (underscore properties), so `@dank074/discord-video-stream` is pinned to an exact version.
