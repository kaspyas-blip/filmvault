import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 200;

async function parseFile(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * One JSON file that survives a crash or a power cut. A write goes to a temporary file
 * forced to disk and then replaces the old one in one step; the previous version stays
 * as <file>.bak. A file that cannot be read is never overwritten: it is kept as
 * <file>.corrupt-<time> and the backup takes its place.
 *
 * read(): the content, or undefined when there is none.
 * write(value): resolves once on disk. A failure is logged, the next write tries again.
 */
export function jsonFile(file) {
  let writing = Promise.resolve();

  async function read(attempt = 1) {
    try {
      return await parseFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Only the backup is left: a crash at the worst moment, or a hand-deleted file.
        return parseFile(`${file}.bak`).catch(() => undefined);
      }
      // Not the content's fault (a file locked for a moment): nobody may take it for empty.
      if (!(error instanceof SyntaxError)) {
        if (attempt >= RENAME_RETRIES) throw error;
        await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS));
        return read(attempt + 1);
      }
      const kept = `${file}.corrupt-${Date.now()}`;
      console.error(`${file} cannot be read (${error.message}), keeping it as ${kept}`);
      await copyFile(file, kept).catch(copyError => console.error(`Could not keep ${file}:`, copyError.message));
      const backup = await parseFile(`${file}.bak`).catch(() => undefined);
      console.error(backup === undefined ? `${file} has no usable backup, starting empty` : `${file} restored from its backup`);
      return backup;
    }
  }

  async function replace(data) {
    await mkdir(dirname(file), { recursive: true });
    const handle = await open(`${file}.tmp`, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Only a file that reads well becomes the backup.
    const current = await parseFile(file).then(() => true, () => false);
    if (current) await copyFile(file, `${file}.bak`);
    for (let attempt = 1; ; attempt++) {
      try {
        return await rename(`${file}.tmp`, file);
      } catch (error) {
        // Windows: an antivirus or an indexer may hold the file for a moment.
        if (attempt >= RENAME_RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS));
      }
    }
  }

  function write(value) {
    const data = JSON.stringify(value, null, 1);
    writing = writing.then(() => replace(data)).catch(error => console.error(`Could not save ${file}:`, error.message));
    return writing;
  }

  return { read, write };
}
