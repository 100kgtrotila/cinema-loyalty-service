// src/common/grpc-status.ts
export const GrpcStatus = {
  OK: 0,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  FAILED_PRECONDITION: 9,
  INTERNAL: 13,
} as const satisfies Record<string, number>;
