import { logger } from '../logger';

export interface LimitRule {
  limit: number;
  windowMs: number;
}

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
  if (p.startsWith('/api/v1/devices/link')) return 'devices/link';
  if (p.startsWith('/api/v1/devices')) return 'devices';
  if (p.startsWith('/api/v1/messages')) return 'messages';
  if (/^\/api\/v1\/conversations\/[^/]+\/keys\/request$/.test(p)) return 'conversations/keys/request';
  if (p.startsWith('/api/v1/conversations')) return 'conversations';
  if (p.startsWith('/api/v1/users')) return 'users';
  return 'default';
}

let cachedRaw: string | undefined;
let cachedOverrides: Record<string, LimitRule> = {};
let warnedRaw: string | undefined;

function isRule(v: unknown): v is LimitRule {
  if (!v || typeof v !== 'object') return false;
  const { limit, windowMs } = v as Record<string, unknown>;
  return Number.isInteger(limit) && (limit as number) > 0 && Number.isInteger(windowMs) && (windowMs as number) > 0;
}

/** Read at request time (cached only by raw string, so changing the env var takes effect immediately). */
function getOverrides(): Record<string, LimitRule> {
  const raw = process.env.RATE_LIMITS_JSON;
  if (raw === cachedRaw) return cachedOverrides;
  cachedRaw = raw;
  cachedOverrides = {};
  if (!raw || !raw.trim()) return cachedOverrides;
  try {
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (isRule(v)) cachedOverrides[k] = v;
      else if (warnedRaw !== raw) logger.warn('invalid_rate_limit_override', { rule: k });
    }
  } catch {
    if (warnedRaw !== raw) logger.warn('invalid_rate_limits_json');
  }
  warnedRaw = raw;
  return cachedOverrides;
}

export function limitForRequest(
  pathname: string,
  method: string,
  who: { projectId: string; userId?: string }
): ResolvedLimit {
  const rules = { ...DEFAULT_RULES, ...getOverrides() };
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
