import { config } from './config.js';
import cs from './locales/cs.js';
import en from './locales/en.js';

const CATALOGS = { cs, en };

function fill(value, vars) {
  if (typeof value === 'function') return value(vars);
  // A function as the replacement: values containing "$" or "%{...}" are inserted as they are.
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** Text for `key` in a language. A key the language lacks falls back to Czech, which has them all. */
export function tIn(language, key, vars = {}) {
  const value = CATALOGS[language]?.[key] ?? cs[key];
  return value === undefined ? key : fill(value, vars);
}

/** Text for `key` in the configured language; vars fill the {name} placeholders. */
export function t(key, vars) {
  return tIn(config.language, key, vars);
}

/**
 * The text of a key in every language: for recognising our own older messages by their
 * title after LANGUAGE was changed.
 */
export function allT(key) {
  return Object.keys(CATALOGS).map(language => tIn(language, key));
}
