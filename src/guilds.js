import { jsonFile } from './store.js';

/**
 * The servers with a cinema (data/guilds.json), by server ID:
 * { textChannelId, voiceChannelId, wishlistChannelId, allowedRole, announceRole, dir }
 * dir: where the server keeps its history, wishlist and settings.
 */
const store = jsonFile('data/guilds.json');

export async function loadGuilds() {
  return (await store.read()) ?? {};
}

export const saveGuilds = guilds => store.write(guilds);
