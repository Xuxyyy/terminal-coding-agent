import {splitStages, stripWrappers, tokenize} from './stages.js';

const EXTERNAL_DIFF_GIT_COMMANDS = ['diff', 'log', 'show'];
const NO_EXTERNAL_DIFF_OPTION = '--no-ext-diff';
const GIT_DIFF_SUBCOMMAND_PATTERN = new RegExp(
  `^(\\s*(?:\\S+\\s+)*?git\\s+(?:${EXTERNAL_DIFF_GIT_COMMANDS.join('|')}))\\b`,
);

function hardenStage(stage: string): string {
  const words = tokenize(stage);
  if (words === null) return stage;
  const parts = stripWrappers(words);
  if (parts.length < 2 || parts[0] !== 'git') return stage;
  if (!EXTERNAL_DIFF_GIT_COMMANDS.includes(parts[1])) return stage;
  if (parts.includes(NO_EXTERNAL_DIFF_OPTION)) return stage;
  return stage.replace(GIT_DIFF_SUBCOMMAND_PATTERN, `$1 ${NO_EXTERNAL_DIFF_OPTION}`);
}

export function hardenCommand(command: string): string {
  const stages = splitStages(command);
  if (stages === null) return command;
  return stages.map((stage) => hardenStage(stage.text) + stage.separator).join('');
}
