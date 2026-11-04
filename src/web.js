import { spawn } from 'node:child_process';
import { config } from './config.js';
import { UserError } from './player.js';

/**
 * Videos and live streams from YouTube and Kick, through yt-dlp. They look like a
 * Jellyfin item to the player (Id is the page address), plus `web` with what ffmpeg
 * needs. The stream addresses expire after hours: a stream that fell gets fresh ones
 * through the recovery, which loads the item again.
 */
// Only these sites: yt-dlp would otherwise fetch whatever address anybody writes.
const HOSTS = /^(?:(?:www|m|music)\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?kick\.com$/i;
// Picture and sound together, H.264 where there is one: the MiniPC decodes it with least effort.
const FORMAT = 'b[height<=1080][vcodec^=avc1]/b[height<=1080]/bv*[height<=1080]+ba/b';
// YouTube answers ffmpeg with 403 for the addresses of its other clients; this one's HLS
// opens and seeks (1080p). The default clients work only for yt-dlp's own downloader.
const YOUTUBE_CLIENT = 'youtube:player_client=web_safari';
const RESOLVE_TIMEOUT_MS = 90_000;
const UPDATE_TIMEOUT_MS = 180_000;
const MAX_NAME = 200;
const CODECS = { avc1: 'h264', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', vp9: 'vp9', av01: 'av1' };
const SENT_HEADERS = ['User-Agent', 'Referer', 'Origin'];

export function isLink(text) {
  return /^https?:\/\//i.test(text?.trim() ?? '');
}

export function isWebUrl(text) {
  if (!isLink(text)) return false;
  try {
    return HOSTS.test(new URL(text.trim()).hostname);
  } catch {
    return false;
  }
}

function runYtDlp(args, timeout) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ytDlpPath, ['--ignore-config', '--no-warnings', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let stderr = '';
    const timer = setTimeout(() => {
      // Its helper processes keep the output open, so the whole tree goes and nothing waits for it.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      else proc.kill();
      reject(new Error('yt-dlp neodpovídá'));
    }, timeout);
    proc.stdout.on('data', chunk => out.push(chunk));
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    proc.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(stderr.trim().split('\n').pop() || `yt-dlp exit ${code}`));
    });
  });
}

function headerLines(format) {
  const headers = format.http_headers ?? {};
  return SENT_HEADERS.filter(name => headers[name]).map(name => `${name}: ${headers[name]}\r\n`).join('');
}

export async function webItem(url) {
  // --flat-playlist: without it a playlist or channel page loads every video it lists.
  const output = await runYtDlp(['--no-playlist', '--flat-playlist', '--js-runtimes', 'node', '--extractor-args', YOUTUBE_CLIENT, '-f', FORMAT, '-J', '--', url.trim()], RESOLVE_TIMEOUT_MS).catch(error => {
    if (error.code === 'ENOENT') throw new UserError('Přehrávání z YouTube a Kicku tu není nainstalované (chybí yt-dlp).');
    console.warn(`yt-dlp failed for ${url}:`, error.message);
    throw new UserError(`Tohle video se nepodařilo načíst: ${error.message.replace(/^ERROR:\s*/, '').slice(0, 300)}`);
  });
  const data = JSON.parse(output);
  if (data._type && data._type !== 'video') throw new UserError('Playlisty neumím, pošli odkaz na jedno video.');
  const formats = data.requested_formats ?? [data];
  const video = formats.find(f => f.vcodec && f.vcodec !== 'none') ?? formats[0];
  const audio = formats.find(f => f !== video && f.acodec && f.acodec !== 'none');
  const live = !!data.is_live;
  const channel = data.uploader ?? data.channel ?? null;
  // yt-dlp adds the date and time to the title of a live stream.
  const title = (data.title ?? url).replace(/\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '');
  const name = live && channel ? `🔴 ${channel}: ${title}` : title;
  return {
    Id: data.webpage_url && isWebUrl(data.webpage_url) ? data.webpage_url : url.trim(),
    Type: 'Web',
    Name: name.slice(0, MAX_NAME),
    Overview: channel ? `📺 ${channel}` : null,
    RunTimeTicks: !live && data.duration ? data.duration * 10_000_000 : null,
    MediaSources: [{
      Id: 'web',
      MediaStreams: [{ Type: 'Video', Codec: CODECS[video.vcodec?.split('.')[0]] ?? null, RealFrameRate: video.fps ?? null }],
    }],
    web: {
      live,
      videoUrl: video.url,
      audioUrl: audio?.url ?? null,
      headers: headerLines(video),
      thumbnail: data.thumbnail ?? null,
    },
  };
}

/** The sites change often and an old yt-dlp stops working; it replaces itself. */
export async function updateYtDlp() {
  const output = await runYtDlp(['-U'], UPDATE_TIMEOUT_MS);
  const line = output.trim().split('\n').pop();
  if (!/up to date/i.test(line)) console.log(`yt-dlp: ${line}`);
}
