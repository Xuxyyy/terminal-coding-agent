import {messageFor} from './message.js';

export function announce(name: string): string {
  return messageFor(name);
}
