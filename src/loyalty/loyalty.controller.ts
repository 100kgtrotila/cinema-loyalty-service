import { Controller } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';
import { GrpcMethod } from '@nestjs/microservices';
import type { GetBalanceRequest } from 'src/interfaces/get-balance-request.interface';

@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @GrpcMethod('LoyaltyService', 'GetBalance')
  async getBalance(data: GetBalanceRequest) {
    return this.loyaltyService.getBalance(data.userId);
  }
}
