import {rowLine, type SessionRow} from '../sessions.js';
import {Picker} from './Picker.js';

export function SessionPicker({
  rows,
  onPick,
  onCancel,
}: {
  rows: SessionRow[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <Picker
      title="Reopen a conversation"
      rows={rows}
      hint="↑↓ to move · enter to open · esc to cancel"
      empty="No past conversations in this folder yet."
      renderRow={rowLine}
      onPick={onPick}
      onCancel={onCancel}
    />
  );
}
