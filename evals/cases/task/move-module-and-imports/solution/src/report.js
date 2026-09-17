import {formatLabel} from './format.js';

export function report(name, count) {
  return `${formatLabel(name)}: ${count}`;
}
