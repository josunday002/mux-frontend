import { NextRequest, NextResponse } from 'next/server';

/**
 * Activity feed pagination endpoint.
 *
 * Cursor/limit-based pagination for the wallet activity feed with a stable,
 * typed response shape and stable error codes. Deny-by-default authz: the
 * caller must present a valid owner/delegate/guardian/API-key/JWT credential
 * and may only read the feed for a wallet they are authorized on.
 */

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Stable error codes surfaced to clients (never leak internals). */
export const ActivityFeedErrorCode = {
  UNAUTHORIZED: 'ACTIVITY_FEED_UNAUTHORIZED',
  FORBIDDEN: 'ACTIVITY_FEED_FORBIDDEN',
  INVALID_CURSOR: 'ACTIVITY_FEED_INVALID_CURSOR',
  INVALID_LIMIT: 'ACTIVITY_FEED_INVALID_LIMIT',
  UPSTREAM_UNAVAILABLE: 'ACTIVITY_FEED_UPSTREAM_UNAVAILABLE',
  INTERNAL: 'ACTIVITY_FEED_INTERNAL',
} as const;

export type ActivityFeedErrorCodeValue =
  (typeof ActivityFeedErrorCode)[keyof typeof ActivityFeedErrorCode];

export type ActivityFeedRole = 'owner' | 'delegate' | 'guardian';

export interface ActivityFeedItem {
  id: string;
  walletId: string;
  type: string;
  createdAt: string;
  /** Redacted, non-sensitive summary only. */
  summary: string;
}

export interface ActivityFeedPage {
  items: ActivityFeedItem[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface ActivityFeedErrorBody {
  error: {
    code: ActivityFeedErrorCodeValue;
    message: string;
    correlationId: string;
  };
}

interface AuthContext {
  subject: string;
  role: ActivityFeedRole;
  walletIds: string[];
}

/**
 * Resolve the caller's auth context. Deny-by-default: any missing/invalid
 * credential, expired token, or revoked delegate yields null.
 *
 * NOTE: wire this to the real auth provider (JWT/API-key/owner-delegate
 * registry). Kept as a single seam so authz cannot be bypassed by callers.
 */
async function resolveAuthContext(
  req: NextRequest,
): Promise<AuthContext | null> {
  const authz = req.headers.get('authorization');
  const apiKey = req.headers.get('x-api-key');
  if (!authz && !apiKey) return null;

  // Placeholder verification seam. Real implementation validates the JWT
  // signature/expiry or API-key hash and resolves role + wallet scope.
  const subject = req.headers.get('x-subject');
  const role = req.headers.get('x-role') as ActivityFeedRole | null;
  const walletIds = (req.headers.get('x-wallet-ids') ?? '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);

  if (!subject || !role) return null;
  if (role !== 'owner' && role !== 'delegate' && role !== 'guardian') {
    return null;
  }
  return { subject, role, walletIds };
}

function isAuthorizedForWallet(
  auth: AuthContext,
  walletId: string,
): boolean {
  // Deny-by-default: caller must be explicitly scoped to the wallet.
  return auth.walletIds.includes(walletId);
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const createdAt = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!createdAt || !id) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_LIMIT) return null;
  return n;
}

function errorResponse(
  code: ActivityFeedErrorCodeValue,
  message: string,
  status: number,
  correlationId: string,
): NextResponse<ActivityFeedErrorBody> {
  return NextResponse.json(
    { error: { code, message, correlationId } },
    { status },
  );
}

/**
 * Fetch a page of activity from the source of truth. Fail-closed: any upstream
 * (RPC/DB/Horizon) failure throws so the caller returns a 503 rather than a
 * partial/incorrect page.
 */
async function fetchActivityPage(
  _walletId: string,
  _limit: number,
  _cursor: { createdAt: string; id: string } | null,
): Promise<ActivityFeedItem[]> {
  // Placeholder data source seam. Real implementation queries the activity
  // store with a stable (createdAt, id) keyset ordering.
  return [];
}

export async function GET(
  req: NextRequest,
): Promise<NextResponse<ActivityFeedPage | ActivityFeedErrorBody>> {
  const correlationId =
    req.headers.get('x-correlation-id') ?? crypto.randomUUID();

  const auth = await resolveAuthContext(req);
  if (!auth) {
    return errorResponse(
      ActivityFeedErrorCode.UNAUTHORIZED,
      'Authentication required.',
      401,
      correlationId,
    );
  }

  const { searchParams } = new URL(req.url);
  const walletId = searchParams.get('walletId');
  if (!walletId) {
    return errorResponse(
      ActivityFeedErrorCode.FORBIDDEN,
      'walletId is required.',
      400,
      correlationId,
    );
  }

  if (!isAuthorizedForWallet(auth, walletId)) {
    return errorResponse(
      ActivityFeedErrorCode.FORBIDDEN,
      'Not authorized for this wallet.',
      403,
      correlationId,
    );
  }

  const limit = parseLimit(searchParams.get('limit'));
  if (limit === null) {
    return errorResponse(
      ActivityFeedErrorCode.INVALID_LIMIT,
      `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      400,
      correlationId,
    );
  }

  const rawCursor = searchParams.get('cursor');
  let cursor: { createdAt: string; id: string } | null = null;
  if (rawCursor !== null) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) {
      return errorResponse(
        ActivityFeedErrorCode.INVALID_CURSOR,
        'cursor is malformed.',
        400,
        correlationId,
      );
    }
  }

  let items: ActivityFeedItem[];
  try {
    items = await fetchActivityPage(walletId, limit, cursor);
  } catch {
    // Fail-closed: never return a partial page on upstream outage.
    return errorResponse(
      ActivityFeedErrorCode.UPSTREAM_UNAVAILABLE,
      'Activity source temporarily unavailable.',
      503,
      correlationId,
    );
  }

  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;
  const last = pageItems[pageItems.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return NextResponse.json(
    { items: pageItems, nextCursor, hasMore, limit },
    { status: 200, headers: { 'x-correlation-id': correlationId } },
  );
}
