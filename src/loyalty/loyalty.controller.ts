import { Controller, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { LoyaltyService } from './loyalty.service';
import type {
  DeductPointsRequest,
  GetBalanceRequest,
  GetFullProfileRequest,
  UseGoldUpgradeRequest,
} from './interfaces/loyalty-request.interface';
import { GrpcApiKeyGuard } from 'src/guards/grpc-api-key.guard';

@Controller()
@UseGuards(GrpcApiKeyGuard)
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @GrpcMethod('LoyaltyService', 'GetBalance')
  getBalance(data: GetBalanceRequest) {
    return this.loyaltyService.getBalance(data.userId);
  }

  @GrpcMethod('LoyaltyService', 'GetFullProfile')
  getFullProfile(data: GetFullProfileRequest) {
    return this.loyaltyService.getFullProfile(data.userId);
  }

  @GrpcMethod('LoyaltyService', 'DeductPoints')
  deductPoints(data: DeductPointsRequest) {
    return this.loyaltyService.deductPoints(
      data.userId,
      data.amount,
      data.orderId,
      data.idempotencyKey,
    );
  }

  @GrpcMethod('LoyaltyService', 'UseGoldUpgrade')
  useGoldUpgrade(data: UseGoldUpgradeRequest) {
    return this.loyaltyService.useGoldUpgrade(data.userId, data.orderId);
  }
}
