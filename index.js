import { startBot } from './src/bot.js';
import { Player } from './src/player.js';

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));

const player = new Player();
const streamerUser = await player.login();
console.log(`Streamer account ready as ${streamerUser.tag}`);
await startBot(player);
