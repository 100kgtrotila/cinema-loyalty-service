export const GrpcStatus = {
  OK: 0,
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  FAILED_PRECONDITION: 9,
  INTERNAL: 13,
  UNAUTHENTICATED: 16,
} as const satisfies Record<string, number>;
