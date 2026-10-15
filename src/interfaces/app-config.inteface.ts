export interface AppConfig {
  port: number;
  grpcUrl: string;
  rmqUrl: string;
  rmqQueue: string;
  outboxPublishTimeoutMs: number;
  outboxLeaseMs: number;
  outboxPublishConcurrency: number;
}
