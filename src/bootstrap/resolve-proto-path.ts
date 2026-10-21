import { join } from 'path';
import { existsSync } from 'fs';

export function resolveProtoPath(): string {
  // Nest CLI copies src/proto to dist/proto; both sit alongside the bootstrap directory.
  const protoPath = join(__dirname, '..', 'proto/loyalty/v1/loyalty.proto');
  if (!existsSync(protoPath)) {
    throw new Error(
      'Loyalty protobuf asset is missing; restore src/proto or run bun run build.',
    );
  }
  return protoPath;
}
