import { OutboxEventStatus } from 'src/generated/prisma/enums';

export interface RawOutboxEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: OutboxEventStatus;
  aggregate_type: string;
  aggregate_id: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
