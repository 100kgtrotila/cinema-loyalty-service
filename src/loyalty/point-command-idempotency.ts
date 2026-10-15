import { z } from 'zod';
import { Prisma } from 'src/generated/prisma/client';
import { ERROR_MESSAGES } from './constants/loyalty.constants';

const PointCommandSchema = z.object({
  operation: z.enum(['DEDUCT', 'REFUND']),
  userId: z.uuid().transform((value) => value.toLowerCase()),
  orderId: z.uuid().transform((value) => value.toLowerCase()),
  amount: z.number().int().positive().max(2147483647),
  idempotencyKey: z.string().min(1).max(128),
});
export type PointCommand = z.infer<typeof PointCommandSchema>;
export interface PointCommandResult {
  success: boolean;
  balanceAfter: number;
  errorMessage: string;
}

export function parsePointCommand(input: PointCommand): PointCommand | null {
  const parsed = PointCommandSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

// Uses the caller's transaction after its profile lock. Successes retain the
// committed response; business rejections with no effect remain retryable.
export async function replayPointCommand(
  tx: Prisma.TransactionClient,
  command: PointCommand,
): Promise<PointCommandResult | undefined> {
  const existing = await tx.processedEvent.findUnique({
    where: { eventId: command.idempotencyKey },
  });
  if (!existing) return undefined;
  if (existing.operation === null) {
    return {
      success: false,
      balanceAfter: 0,
      errorMessage: ERROR_MESSAGES.LEGACY_IDEMPOTENCY,
    };
  }
  if (
    existing.operation !== command.operation ||
    existing.userId !== command.userId ||
    existing.orderId !== command.orderId ||
    existing.amount !== command.amount
  ) {
    return {
      success: false,
      balanceAfter: 0,
      errorMessage: ERROR_MESSAGES.IDEMPOTENCY_CONFLICT,
    };
  }
  if (existing.balanceAfter === null)
    throw new Error('Point command result is missing');
  return {
    success: true,
    balanceAfter: existing.balanceAfter,
    errorMessage: '',
  };
}

export async function claimPointCommand(
  tx: Prisma.TransactionClient,
  command: PointCommand,
  balanceAfter: number,
): Promise<PointCommandResult | undefined> {
  // INSERT ... ON CONFLICT serializes a shared key even for different profiles
  // and generic event writers. Uncommitted claims disappear with the transaction.
  const inserted = await tx.processedEvent.createMany({
    data: {
      eventId: command.idempotencyKey,
      operation: command.operation,
      userId: command.userId,
      orderId: command.orderId,
      amount: command.amount,
      balanceAfter,
    },
    skipDuplicates: true,
  });
  if (inserted.count === 1) return undefined;
  const replay = await replayPointCommand(tx, command);
  if (!replay) throw new Error('Point command record disappeared during claim');
  return replay;
}
