import { PipeTransform } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { z } from 'zod';
import { GrpcStatus } from './grpc-status';

// Validate only gaps at the transport boundary. Preserve proto defaults and all
// other fields for existing service validators, calculations and response rules.
export const userRequestSchema = z.looseObject({ userId: z.guid() });
export const goldRequestSchema = userRequestSchema.extend({
  orderId: z.guid(),
});
export const discountRequestSchema = userRequestSchema.extend({
  orderAmount: z.number().finite().default(0),
});
export const achievementIdSchema = z.looseObject({ id: z.guid() });
export const adminUsersRequestSchema = z.looseObject({
  tierFilter: z.enum(['', 'BRONZE', 'SILVER', 'GOLD']).optional(),
  userIds: z.array(z.guid()).optional(),
});

export class GrpcRequestPipe implements PipeTransform<unknown, unknown> {
  constructor(private readonly schema: z.ZodType) {}

  transform(value: unknown): unknown {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message:
          'Invalid request fields: ' +
          [
            ...new Set(
              parsed.error.issues.map((issue) => issue.path.join('.')),
            ),
          ].join(', '),
      });
    }
    return parsed.data;
  }
}
