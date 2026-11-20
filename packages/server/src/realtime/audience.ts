import { conversationChannel, userChannel } from './channels';

/**
 * Who may receive an event (decision D11). Two kinds, so nothing pays for a recipient list it does not need:
 *  - `users`: a small explicit list, for private events (a device event for one user, a key request);
 *  - `conversation`: no list, for conversation events such as `message.created`. Page the members with listAudience().
 */
export type Audience = { kind: 'users'; userIds: string[] } | { kind: 'conversation'; conversationId: string };

/** What a custom transport receives (`chat.onEvent`): the event as the Socket.IO clients get it, plus who it is for. */
export interface ModuleEvent {
  type: string;
  data: unknown;
  audience: Audience;
}

const CONVERSATION = conversationChannel('');
const USER = userChannel('');

/** `conversation:<id>` and `user:<id>` are the only channels the module publishes to. */
export function audienceForChannel(channel: string): Audience | null {
  if (channel.startsWith(CONVERSATION) && channel.length > CONVERSATION.length) {
    return { kind: 'conversation', conversationId: channel.slice(CONVERSATION.length) };
  }
  if (channel.startsWith(USER) && channel.length > USER.length) {
    return { kind: 'users', userIds: [channel.slice(USER.length)] };
  }
  return null;
}
