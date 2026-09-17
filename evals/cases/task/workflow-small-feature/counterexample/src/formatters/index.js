import {formatCsv} from './csv.js';
import {formatJson} from './json.js';
import {formatText} from './text.js';

export const formatters = {
  csv: formatCsv,
  json: formatJson,
  text: formatText,
};
