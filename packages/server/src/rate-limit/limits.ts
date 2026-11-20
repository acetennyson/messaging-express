import type { ServerContext } from '../core/context';
import type { LimitRule } from '../core/config';

export type { LimitRule };

export interface ResolvedLimit extends LimitRule {
  /** Which rule matched, e.g. "messages:POST". Part of the counter key. */
  group: string;
  /** Full counter key: rl:<group>:<projectId>:<userId|api> */
  key: string;
}

const MINUTE = 60_000;

/**
 * Defaults, per user, per minute. Lookup order for a request:
 *   "<pathGroup>:<METHOD>"  ->  "<pathGroup>"  ->  "default"
 * Override any entry at runtime with RATE_LIMITS_JSON, e.g.
 *   {"messages:POST":{"limit":60,"windowMs":60000},"default":{"limit":600,"windowMs":60000}}
 */
export const DEFAULT_RULES: Record<string, LimitRule> = {
  'messages:POST': { limit: 120, windowMs: MINUTE },
  'messages:GET': { limit: 600, windowMs: MINUTE },
  'uploads:POST': { limit: 30, windowMs: MINUTE },
  'uploads/presign:POST': { limit: 60, windowMs: MINUTE },
  // E2EE (Stage 7.2/7.3). The new device polls /devices/link every 2 s for up to the pairing window (30 calls/min).
  devices: { limit: 60, windowMs: MINUTE },
  'devices/pair:POST': { limit: 5, windowMs: MINUTE },
  'devices/link:POST': { limit: 40, windowMs: MINUTE },
  'devices/backup': { limit: 10, windowMs: MINUTE },
  'conversations/keys/request:POST': { limit: 30, windowMs: MINUTE },
  conversations: { limit: 120, windowMs: MINUTE },
  users: { limit: 120, windowMs: MINUTE },
  default: { limit: 300, windowMs: MINUTE },
};

export function pathGroup(pathname: string): string {
  const p = pathname.replace(/\/+$/, '');
  if (p.startsWith('/api/v1/uploads/presign')) return 'uploads/presign';
  if (p.startsWith('/api/v1/uploads')) return 'uploads';
  if (p.startsWith('/api/v1/devices/pair')) return 'devices/pair';
  if (p.startsWith('/api/v1/devices/backup')) return 'devices/backup';
  if (p.startsWith('/api/v1/devices/link')) return 'devices/link';
  if (p.startsWith('/api/v1/devices')) return 'devices';
  if (p.startsWith('/api/v1/messages')) return 'messages';
  if (/^\/api\/v1\/conversations\/[^/]+\/keys\/request$/.test(p)) return 'conversations/keys/request';
  if (p.startsWith('/api/v1/conversations')) return 'conversations';
  if (p.startsWith('/api/v1/users')) return 'users';
  return 'default';
}

export function limitForRequest(
  ctx: ServerContext,
  pathname: string,
  method: string,
  who: { projectId: string; userId?: string }
): ResolvedLimit {
  const rules = { ...DEFAULT_RULES, ...ctx.config.rateLimitOverrides() };
  const pg = pathGroup(pathname);
  const m = method.toUpperCase();

  const group = [`${pg}:${m}`, pg, 'default'].find((g) => g in rules)!;
  const rule = rules[group];
  return {
    ...rule,
    group,
    key: `rl:${group}:${who.projectId}:${who.userId ?? 'api'}`,
  };
}
