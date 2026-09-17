import {WORD_SEPARATOR} from './constants.js';

export function normalizeTitle(value) {
  return value.trim().toLowerCase().replace(/\s+/g, WORD_SEPARATOR);
}
