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
  encoder: process.env.VIDEO_ENCODER?.trim() || 'h264_qsv',
  height: number('VIDEO_HEIGHT', 720),
  fps: number('VIDEO_FPS', 30),
  bitrate: number('VIDEO_BITRATE', 3500),
  audioBitrate: number('AUDIO_BITRATE', 128),
  // ffmpeg -hwaccel method, or empty / 0 for software decoding
  hwDecode: ['', '0'].includes(process.env.HW_DECODE?.trim() ?? '') ? null : process.env.HW_DECODE.trim(),
  idleLeaveMinutes: number('IDLE_LEAVE_MINUTES', 5),
  // Role ID or exact role name (case-insensitive)
  allowedRole: process.env.ALLOWED_ROLE_ID?.trim() || null,
};
