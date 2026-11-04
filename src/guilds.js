import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/**
 * The servers with a cinema (data/guilds.json), by server ID:
 * { textChannelId, voiceChannelId, wishlistChannelId, allowedRole, announceRole, dir }
 * dir: where the server keeps its history, wishlist and settings.
 */
const FILE = 'data/guilds.json';

export async function loadGuilds() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

export async function saveGuilds(guilds) {
  await mkdir('data', { recursive: true });
  await writeFile(`${FILE}.tmp`, JSON.stringify(guilds, null, 1));
  await rename(`${FILE}.tmp`, FILE);
}
