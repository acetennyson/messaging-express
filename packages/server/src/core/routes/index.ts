import type { RouteDef } from '../routing';
import { routes as health } from './health';
import { routes as internalWebhooksRetry } from './internal-webhooks-retry';
import { routes as conversationsDevices } from './conversations-devices';
import { routes as conversationsKeysRequest } from './conversations-keys-request';
import { routes as conversationsKeys } from './conversations-keys';
import { routes as conversationsParticipantsItem } from './conversations-participants-item';
import { routes as conversationsParticipants } from './conversations-participants';
import { routes as conversations } from './conversations';
import { routes as devicesItem } from './devices-item';
import { routes as devicesBackup } from './devices-backup';
import { routes as devicesLink } from './devices-link';
import { routes as devicesPair } from './devices-pair';
import { routes as devices } from './devices';
import { routes as messages } from './messages';
import { routes as uploadsPresign } from './uploads-presign';
import { routes as uploads } from './uploads';
import { routes as usersDevicesReset } from './users-devices-reset';
import { routes as users } from './users';
import { routes as uploadsServe } from './uploads-serve';

/** Every route the server serves. Order does not matter: matchRoute prefers the most specific pattern. */
export const routes: RouteDef[] = [
  ...health,
  ...internalWebhooksRetry,
  ...conversationsDevices,
  ...conversationsKeysRequest,
  ...conversationsKeys,
  ...conversationsParticipantsItem,
  ...conversationsParticipants,
  ...conversations,
  ...devicesItem,
  ...devicesBackup,
  ...devicesLink,
  ...devicesPair,
  ...devices,
  ...messages,
  ...uploadsPresign,
  ...uploads,
  ...usersDevicesReset,
  ...users,
  ...uploadsServe,
];
