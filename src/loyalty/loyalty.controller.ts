import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { LoyaltyService } from './loyalty.service';
import type { GetBalanceRequest } from './interfaces/get-balance-request.interface';

@Controller()
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @GrpcMethod('LoyaltyService', 'GetBalance')
  async getBalance(data: GetBalanceRequest) {
    return this.loyaltyService.getBalance(data.userId);
  }
}
