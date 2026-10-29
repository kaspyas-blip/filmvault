import { config } from './config.js';

// Movie facts for the wishlist: TMDB for Czech titles, overviews, posters and the
// IMDb ID; OMDb for the IMDb rating (IMDb itself has no free API).

const TMDB = 'https://api.themoviedb.org/3';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
const CHOICES = 5;
// A film counts as the obvious one when it has this many times the votes of the next.
const DOMINANT = 4;
// Results must contain most of the written words, so chat ("taky ne") adds nothing.
const MIN_SIMILARITY = 0.6;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url.hostname} ${res.status} ${res.statusText}`);
  return res.json();
}

function tmdb(path, params = {}) {
  const url = new URL(TMDB + path);
  url.searchParams.set('api_key', config.tmdbApiKey);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  return getJson(url);
}

export function movieInfoEnabled() {
  return !!config.tmdbApiKey;
}

// Sequel numbers are written every way: "Mizerové 2" is "Mizerové II" on TMDB,
// "Shrek 3" is "Shrek Třetí". ("v" is left alone, it is a Czech word.)
const SEQUEL_WORDS = {
  ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9',
  druhy: '2', druha: '2', druhe: '2', second: '2',
  treti: '3', third: '3',
  ctvrty: '4', ctvrta: '4', ctvrte: '4', fourth: '4',
  paty: '5', pata: '5', pate: '5', fifth: '5',
};

/** Lowercase without diacritics and punctuation, sequel words as digits, for comparing titles. */
export function normalizeTitle(text) {
  return (text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').map(word => SEQUEL_WORDS[word] ?? word).join(' ');
}

/** "Duna 2021", "Duna (2021)" -> { title: 'Duna', year: 2021 }; "Mizerové 1,2,3" -> { title: 'Mizerové' } */
export function parseQuery(text) {
  const trimmed = text.trim().replace(/\s+\d(?:\s*[,&+a]\s*\d)+\s*$/, '');
  const match = /^(.*?)[\s,(\[]*((?:19|20)\d{2})[)\]]?\s*$/.exec(trimmed);
  if (match && match[1].trim()) return { title: match[1].trim(), year: Number(match[2]) };
  return { title: trimmed, year: null };
}

/**
 * Share of the written words found in the title. Czech endings vary ("shreka",
 * "parťáci"), so longer words match on their first four letters.
 */
export function titleSimilarity(query, title) {
  const words = normalizeTitle(query).split(' ').filter(Boolean);
  const titleWords = normalizeTitle(title).split(' ').filter(Boolean);
  if (!words.length || !titleWords.length) return 0;
  const found = words.filter(w => titleWords.some(t => t === w || (w.length >= 4 && t.length >= 4 && t.slice(0, 4) === w.slice(0, 4))));
  // Matching only "a" and "dc" says nothing.
  if (found.join('').length < 4) return 0;
  return found.length / words.length;
}

function brief(result) {
  return {
    tmdbId: result.id,
    title: result.title,
    originalTitle: result.original_title,
    year: result.release_date ? Number(result.release_date.slice(0, 4)) : null,
    votes: result.vote_count ?? 0,
  };
}

const byVotes = (a, b) => b.votes - a.votes;

/**
 * Finds a movie by a loosely written title. Returns { match } when the answer is
 * clear, { choices } (up to 5) when several films fit, or {} when nothing does.
 */
export async function findMovie(text) {
  const { title, year } = parseQuery(text);
  // Only the results closest to what was written: "kryci jmeni zohan" keeps Zohan, not Krycí jméno U.N.C.L.E.
  const search = async (query, language, wanted = title) => {
    const data = await tmdb('/search/movie', { query, language, include_adult: false, primary_release_year: year ?? undefined });
    const scored = (data.results ?? []).map(r => ({
      ...brief(r), score: Math.max(titleSimilarity(wanted, r.title), titleSimilarity(wanted, r.original_title)),
    }));
    const top = Math.max(0, ...scored.map(r => r.score));
    return top < MIN_SIMILARITY ? [] : scored.filter(r => r.score === top);
  };
  // TMDB wants the words in title order and with diacritics; the longest word alone
  // catches "kryci jmeni zohan" (Zohan: Krycí jméno Kadeřník).
  const longest = normalizeTitle(title).split(' ').sort((a, b) => b.length - a.length)[0];
  let results = await search(title, 'cs-CZ');
  if (!results.length) results = await search(title, 'en-US');
  if (!results.length && longest?.length >= 4 && longest !== normalizeTitle(title)) results = await search(longest, 'cs-CZ');
  // A sequel without its number in the title ("Mizerové 3" is Mizerové navždy): offer the series.
  const series = /^(.+?)\s+\d{1,2}$/.exec(title)?.[1];
  if (!results.length && series) {
    const parts = await search(series, 'cs-CZ', series);
    if (parts.length) return { choices: parts.sort((a, b) => (a.year ?? 0) - (b.year ?? 0)).slice(0, CHOICES) };
  }
  if (!results.length) return {};
  if (results.length === 1) return { match: results[0] };
  // Vote counts say which film people mean: "Oppenheimer" is the 2023 film, not a
  // 2024 documentary, but "Pán prstenů" alone (a 1978 cartoon) is worth asking about.
  const wanted = normalizeTitle(title);
  const exact = results.filter(r => normalizeTitle(r.title) === wanted || normalizeTitle(r.originalTitle) === wanted).sort(byVotes);
  const known = [...results].sort(byVotes);
  const [best, runnerUp] = exact.length ? exact : known;
  const clearlyBest = !runnerUp || best.votes >= DOMINANT * runnerUp.votes;
  if (clearlyBest && best.votes >= known[0].votes / DOMINANT) return { match: best };
  const choices = [...exact, ...known.filter(r => !exact.includes(r))];
  return { choices: choices.slice(0, CHOICES) };
}

function trailerUrl(videos) {
  const list = (videos?.results ?? []).filter(v => v.site === 'YouTube' && v.type === 'Trailer');
  const pick = list.find(v => v.iso_639_1 === 'cs') ?? list.find(v => v.official) ?? list[0];
  return pick ? `https://www.youtube.com/watch?v=${pick.key}` : null;
}

async function omdb(imdbId) {
  if (!config.omdbApiKey || !imdbId) return null;
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('i', imdbId);
  url.searchParams.set('apikey', config.omdbApiKey);
  const data = await getJson(url).catch(error => {
    console.warn('OMDb lookup failed:', error.message);
    return null;
  });
  return data?.Response === 'True' ? data : null;
}

/** Everything the card shows. Czech text where TMDB has it, English otherwise. */
export async function movieDetails(tmdbId) {
  const cs = await tmdb(`/movie/${tmdbId}`, { language: 'cs-CZ', append_to_response: 'external_ids,videos', include_video_language: 'cs,en' });
  const imdbId = cs.imdb_id || cs.external_ids?.imdb_id || null;
  const [en, imdb] = await Promise.all([
    cs.overview ? null : tmdb(`/movie/${tmdbId}`, { language: 'en-US' }).catch(() => null),
    omdb(imdbId),
  ]);
  const number = text => (text && text !== 'N/A' ? text : null);
  return {
    tmdbId: cs.id,
    imdbId,
    title: cs.title,
    originalTitle: cs.original_title,
    year: cs.release_date ? Number(cs.release_date.slice(0, 4)) : null,
    overview: cs.overview || en?.overview || '',
    runtime: cs.runtime || null,
    genres: (cs.genres ?? []).map(g => g.name),
    poster: cs.poster_path ? POSTER_BASE + cs.poster_path : null,
    trailer: trailerUrl(cs.videos),
    rating: number(imdb?.imdbRating) ? Number(imdb.imdbRating) : (cs.vote_average ? Math.round(cs.vote_average * 10) / 10 : null),
    ratingSource: number(imdb?.imdbRating) ? 'IMDb' : 'TMDB',
    votes: number(imdb?.imdbVotes),
    director: number(imdb?.Director),
  };
}

export function imdbUrl(imdbId) {
  return imdbId ? `https://www.imdb.com/title/${imdbId}/` : null;
}

export function tmdbUrl(tmdbId) {
  return `https://www.themoviedb.org/movie/${tmdbId}`;
}
