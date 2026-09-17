import {formatLabel} from './legacy/format.js';

export function summary(labels) {
  return labels.map((label) => formatLabel(label)).join(', ');
}
