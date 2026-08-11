import type {ConfirmDecision} from './events.js';

export type ConfirmChoice = {key: string; label: string; decision: ConfirmDecision};

export function confirmChoices(suppressible: boolean): ConfirmChoice[] {
  const choices: ConfirmChoice[] = [
    {key: 'y', label: 'approve once', decision: 'once'},
  ];
  if (suppressible) {
    choices.push({
      key: 'a',
      label: 'allow for this session',
      decision: 'session',
    });
  }
  choices.push({key: 'n', label: 'deny', decision: 'deny'});
  return choices;
}

export function confirmDecisionForKey(
  input: string,
  suppressible: boolean,
): ConfirmDecision | undefined {
  const key = input.toLowerCase();
  return confirmChoices(suppressible).find((choice) => choice.key === key)
    ?.decision;
}
