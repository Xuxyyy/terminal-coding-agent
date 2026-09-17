import {readFileSync} from 'node:fs';

const configUrl = new URL('../config/formats.json', import.meta.url);

function readFormats() {
  const config = JSON.parse(readFileSync(configUrl, 'utf8'));
  return config.formats;
}

export function listFormats() {
  return readFormats().map((format) => ({...format}));
}

export function getFormat(id) {
  const format = readFormats().find((candidate) => candidate.id === id);
  return format === undefined ? null : {...format};
}
