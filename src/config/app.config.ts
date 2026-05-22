import { registerAs } from '@nestjs/config';
import { AppConfig } from 'src/interfaces/app-config.inteface';

export default registerAs(
  'app',
  (): AppConfig => ({
    port: parseInt(process.env.PORT || '3000', 10),
    grpcUrl: process.env.GRPC_URL || '0.0.0.0:50051',
    rmqUrl: process.env.RMQ_URL || 'amqp://localhost:5672',
    rmqQueue: process.env.RMQ_QUEUE || 'loyalty_ticket_purchased',
  }),
);
