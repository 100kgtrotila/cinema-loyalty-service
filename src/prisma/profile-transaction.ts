import { Prisma } from 'src/generated/prisma/client';
import { PrismaService } from './prisma.service';

const MAX_TRANSACTION_ATTEMPTS = 3;

// Each callback owns one profile. Lock it before dedupe/progress/ledger/outbox
// rows, and use only the supplied client. Retried callbacks must contain DB work
// only; queue and broker calls belong after commit.
export async function withTransactionRetry<T>(
  prisma: PrismaService,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    } catch (error: unknown) {
      if (!isRetryableConflict(error) || attempt >= MAX_TRANSACTION_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
}

function isRetryableConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return (
      error instanceof Error &&
      error.name === 'DriverAdapterError' &&
      isPostgresConflict(error.cause)
    );
  }
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;

  // Prisma 7's pg adapter wraps raw-query SQLSTATE in the driver error cause.
  const adapterError = error.meta?.driverAdapterError;
  if (
    typeof adapterError !== 'object' ||
    adapterError === null ||
    !('cause' in adapterError)
  ) {
    return false;
  }
  return isPostgresConflict(adapterError.cause);
}

function isPostgresConflict(cause: unknown): boolean {
  if (
    typeof cause !== 'object' ||
    cause === null ||
    !('originalCode' in cause)
  ) {
    return false;
  }
  return cause.originalCode === '40001' || cause.originalCode === '40P01';
}

// Does not open a transaction. Creating through ON CONFLICT also serializes
// first-time writers on the user_id unique constraint before taking the lock.
export async function lockLoyaltyProfile(
  tx: Prisma.TransactionClient,
  userId: string,
  createIfMissing = false,
): Promise<boolean> {
  if (createIfMissing) {
    await tx.loyaltyProfile.createMany({
      data: { userId },
      skipDuplicates: true,
    });
  }
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM loyalty_profiles WHERE user_id = ${userId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}
