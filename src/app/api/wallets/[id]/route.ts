import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Wallet onboarding + activity feed for a wallet.
 *
 * POST /api/wallets/:id/onboard
 *   First key + wallet onboarding entrypoint. Creates the wallet's first key
 *   and provisions the invisible wallet. Idempotent on `Idempotency-Key`.
 *
 * GET /api/wallets/:id/activity?cursor=<opaque>&limit=<1..100>
 *   Cursor/limit pagination with a stable, typed response shape.
 *
 * Invariants:
 *  - Deny-by-default authz: caller must be owner, delegate, or guardian of the wallet.
 *  - Onboarding is idempotent: replayed/concurrent requests with the same
 *    Idempotency-Key return the original result and never double-provision.
 *  - Fail-closed on dependency outage for any write path; reads return a typed error.
 *  - No secrets, keys, JWTs, or webhook secrets are logged or returned.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/;

// Stable error codes surfaced to clients.
const ErrorCode = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  INVALID_INPUT: 'invalid_input',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  INTERNAL: 'internal_error',
} as const;

type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

type ActivityItem = {
  id: string;
  type: string;
  createdAt: string;
  amount?: string;
  asset?: string;
  counterparty?: string;
};

type ActivityPage = {
  items: ActivityItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

type OnboardResult = {
  walletId: string;
  keyId: string;
  address: string;
  status: 'active' | 'pending';
  createdAt: string;
};

const querySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const onboardSchema = z.object({
  // Optional client hint; server remains source of truth for key material.
  label: z.string().min(1).max(64).optional(),
});

function errorResponse(
  status: number,
  code: ErrorCodeValue,
  message: string,
  correlationId: string,
) {
  return NextResponse.json(
    { error: { code, message, correlationId } },
    { status, headers: { 'x-correlation-id': correlationId } },
  );
}

function correlationIdFrom(req: NextRequest): string {
  const incoming = req.headers.get('x-correlation-id');
  if (incoming && /^[A-Za-z0-9._-]{1,128}$/.test(incoming)) return incoming;
  return crypto.randomUUID();
}

/**
 * Resolve the caller's role for the wallet. Returns null when the caller has no
 * relationship to the wallet (deny-by-default).
 *
 * NOTE: wire this to the real auth/session + wallet membership store. The shape
 * is intentionally narrow so policy cannot be bypassed by client-supplied roles.
 */
async function resolveRole(
  _req: NextRequest,
  _walletId: string,
): Promise<'owner' | 'delegate' | 'guardian' | null> {
  // Placeholder: real implementation reads the authenticated session and the
  // wallet membership record. Returning null keeps the surface deny-by-default.
  return null;
}

/**
 * Fetch a page of activity. Must fail-closed: on dependency outage throw so the
 * caller returns a typed error rather than an empty (misleading) page.
 */
async function fetchActivityPage(
  _walletId: string,
  _cursor: string | undefined,
  _limit: number,
): Promise<ActivityPage> {
  // Placeholder: real implementation queries the activity store with the cursor.
  return { items: [], nextCursor: null, hasMore: false };
}

/**
 * Provision the first key + wallet for the given wallet id. Must be idempotent
 * on `idempotencyKey` and fail-closed: on dependency outage throw so the caller
 * returns a typed error rather than a partial success.
 */
async function onboardFirstKey(
  _walletId: string,
  _idempotencyKey: string,
  _label: string | undefined,
): Promise<OnboardResult> {
  // Placeholder: real implementation provisions the first key + invisible
  // wallet via the wallet service, keyed by idempotencyKey for replay safety.
  throw new Error('wallet service not configured');
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const correlationId = correlationIdFrom(req);
  const walletId = params.id;

  if (!walletId || !/^[A-Za-z0-9_-]{1,128}$/.test(walletId)) {
    return errorResponse(400, ErrorCode.INVALID_INPUT, 'Invalid wallet id', correlationId);
  }

  const parsed = querySchema.safeParse({
    cursor: req.nextUrl.searchParams.get('cursor') ?? undefined,
    limit: req.nextUrl.searchParams.get('limit') ?? undefined,
  });

  if (!parsed.success) {
    return errorResponse(400, ErrorCode.INVALID_INPUT, 'Invalid pagination parameters', correlationId);
  }

  const limit = parsed.data.limit ?? DEFAULT_LIMIT;

  let role: 'owner' | 'delegate' | 'guardian' | null;
  try {
    role = await resolveRole(req, walletId);
  } catch {
    return errorResponse(503, ErrorCode.DEPENDENCY_UNAVAILABLE, 'Auth service unavailable', correlationId);
  }

  if (!role) {
    return errorResponse(403, ErrorCode.FORBIDDEN, 'Not authorized for this wallet', correlationId);
  }

  try {
    const page = await fetchActivityPage(walletId, parsed.data.cursor, limit);
    return NextResponse.json(page, { headers: { 'x-correlation-id': correlationId } });
  } catch {
    // Fail-closed: never return a partial/empty page on dependency outage.
    return errorResponse(503, ErrorCode.DEPENDENCY_UNAVAILABLE, 'Activity store unavailable', correlationId);
  }
}

/**
 * Onboarding: first key + wallet.
 *
 * Deny-by-default authz (owner only for provisioning), idempotent on the
 * `Idempotency-Key` header, and fail-closed on dependency outage.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const correlationId = correlationIdFrom(req);
  const walletId = params.id;

  if (!walletId || !/^[A-Za-z0-9_-]{1,128}$/.test(walletId)) {
    return errorResponse(400, ErrorCode.INVALID_INPUT, 'Invalid wallet id', correlationId);
  }

  const idempotencyKey = req.headers.get('idempotency-key');
  if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return errorResponse(
      400,
      ErrorCode.INVALID_INPUT,
      'Missing or invalid Idempotency-Key header',
      correlationId,
    );
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parsed = onboardSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, ErrorCode.INVALID_INPUT, 'Invalid onboarding payload', correlationId);
  }

  let role: 'owner' | 'delegate' | 'guardian' | null;
  try {
    role = await resolveRole(req, walletId);
  } catch {
    return errorResponse(503, ErrorCode.DEPENDENCY_UNAVAILABLE, 'Auth service unavailable', correlationId);
  }

  // Deny-by-default: only the owner may provision the first key + wallet.
  if (role !== 'owner') {
    return errorResponse(403, ErrorCode.FORBIDDEN, 'Not authorized to onboard this wallet', correlationId);
  }

  try {
    const result = await onboardFirstKey(walletId, idempotencyKey, parsed.data.label);
    return NextResponse.json(result, {
      status: 201,
      headers: { 'x-correlation-id': correlationId },
    });
  } catch {
    // Fail-closed: never report success on a dependency outage for a write path.
    return errorResponse(
      503,
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      'Wallet service unavailable',
      correlationId,
    );
  }
}
