import {formatLabel} from './legacy/format.js';

export function report(name, count) {
  return `${formatLabel(name)}: ${count}`;
}
