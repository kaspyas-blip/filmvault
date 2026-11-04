import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  botToken: required('BOT_TOKEN'),
  streamerToken: required('STREAMER_TOKEN'),
  // Optional when the control bot is only on one server
  guildId: process.env.GUILD_ID?.trim() || null,
  // Channel name or ID
  textChannel: process.env.TEXT_CHANNEL?.trim() || 'filmsearch',
  voiceChannel: process.env.VOICE_CHANNEL?.trim() || 'film',
  jellyfinUrl: required('JELLYFIN_URL').replace(/\/+$/, ''),
  jellyfinApiKey: required('JELLYFIN_API_KEY'),
  // Jellyfin user whose resume positions and watched marks the cinema uses (default: administrator)
  jellyfinUser: process.env.JELLYFIN_USER?.trim() || null,
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
  // Plays YouTube and Kick links; updates itself, so it must be somewhere the bot can write
  ytDlpPath: process.env.YTDLP_PATH?.trim() || (process.platform === 'win32' ? 'tools/yt-dlp.exe' : 'yt-dlp'),
  encoder: process.env.VIDEO_ENCODER?.trim() || 'h264_qsv',
  height: number('VIDEO_HEIGHT', 720),
  fps: number('VIDEO_FPS', 30),
  bitrate: number('VIDEO_BITRATE', 3500),
  audioBitrate: number('AUDIO_BITRATE', 128),
  // ffmpeg -hwaccel method, or empty / 0 for software decoding
  hwDecode: ['', '0'].includes(process.env.HW_DECODE?.trim() ?? '') ? null : process.env.HW_DECODE.trim(),
  idleLeaveMinutes: number('IDLE_LEAVE_MINUTES', 5),
  // Wishlist room ("what we want to watch"); needs a TMDB key, OMDb adds the IMDb rating
  wishlistChannel: process.env.WISHLIST_CHANNEL?.trim() || 'filmy',
  tmdbApiKey: process.env.TMDB_API_KEY?.trim() || null,
  omdbApiKey: process.env.OMDB_API_KEY?.trim() || null,
  // Role pinged when new films appear in Jellyfin (ID or name; empty = announce without a ping)
  announceRole: process.env.ANNOUNCE_ROLE?.trim() || null,
  // Role ID or exact role name (case-insensitive)
  allowedRole: process.env.ALLOWED_ROLE_ID?.trim() || null,
};
