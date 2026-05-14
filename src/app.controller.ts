import { Controller } from '@nestjs/common';
import { AppService } from './app.service';
import { GrpcMethod } from '@nestjs/microservices';
import type { GetBalanceRequest } from './interfaces/get-balance-request.interface';
import type { GetBalanceResponse } from './interfaces/get-balance-response.interface';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @GrpcMethod('LoyaltyService', 'GetBalance')
  getBalace(data: GetBalanceRequest): GetBalanceResponse {
    console.log(`Перевірка балансу для юзера ${data.userId}`);

    return {
      points: 1000,
      tier: 'Golden',
    };
  }
}
