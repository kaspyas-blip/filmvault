// Prints what the bot sees in Jellyfin for a search term.
// Usage: node tools/jellyfin-check.mjs "maturita"
const { searchItems, getItem, itemLabel, mediaSource, audioTracks, subtitleTracks, trackLabel, durationSeconds, downloadPoster } =
  await import('../src/jellyfin.js');

const items = await searchItems(process.argv[2] ?? '', 5);
console.log(`${items.length} results`);
for (const hit of items) {
  const item = await getItem(hit.Id);
  const source = mediaSource(item);
  const video = source.MediaStreams.find(s => s.Type === 'Video');
  console.log(`- ${itemLabel(item)} [${Math.round(durationSeconds(item) / 60)} min, ${source.Container}, ${video?.Codec} ${video?.Width}x${video?.Height} ${video?.BitDepth ?? 8}bit]`);
  for (const t of audioTracks(source)) console.log(`    zvuk ${t.Index}: ${trackLabel(t)}`);
  for (const t of subtitleTracks(source)) console.log(`    titulky ${t.Index}: ${trackLabel(t)} text=${t.IsTextSubtitleStream}`);
}
if (items[0]) console.log(`poster bytes: ${(await downloadPoster(items[0]))?.length ?? 0}`);
