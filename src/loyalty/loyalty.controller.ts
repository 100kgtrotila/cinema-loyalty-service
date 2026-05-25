import { Controller, forwardRef, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyExpirationService } from './loyalty-expiration.service';
import { AdminLoyaltyService } from 'src/admin-loyalty/admin-loyalty.service';
import { GrpcApiKeyGuard } from 'src/guards/grpc-api-key.guard';
import type {
  CalculateDiscountRequest,
  DeductPointsRequest,
  GetBalanceRequest,
  GetFullProfileRequest,
  RefundPointsRequest,
  RollbackGoldUpgradeRequest,
  UseGoldUpgradeRequest,
} from './interfaces/loyalty-request.interface';
import { RollbackGoldUpgradeResponse } from './interfaces/loyalty-response.interface';

@Controller()
@UseGuards(GrpcApiKeyGuard)
export class LoyaltyController {
  constructor(
    private readonly loyaltyService: LoyaltyService,
    private readonly loyaltyExpiration: LoyaltyExpirationService,

    @Inject(forwardRef(() => AdminLoyaltyService))
    private readonly adminLoyaltyService: AdminLoyaltyService,
  ) {}

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

  @GrpcMethod('LoyaltyService', 'CalculateDiscount')
  calculateDiscount(data: CalculateDiscountRequest) {
    return this.loyaltyService.calculateDiscount(data.userId, data.orderAmount);
  }

  @GrpcMethod('LoyaltyService', 'RefundPoints')
  refundPoints(data: RefundPointsRequest) {
    return this.loyaltyExpiration.refundPoints(
      data.userId,
      data.amount,
      data.orderId,
      data.idempotencyKey,
    );
  }

  @GrpcMethod('LoyaltyService', 'RollbackGoldUpgrade')
  async rollbackGoldUpgrade(
    data: RollbackGoldUpgradeRequest,
  ): Promise<RollbackGoldUpgradeResponse> {
    return this.loyaltyService.rollbackGoldUpgrade(data.userId, data.orderId);
  }

  @GrpcMethod('LoyaltyService', 'GetAdminUserBalance')
  async getAdminUserBalance(data: { userId: string }) {
    return this.adminLoyaltyService.getUserBalanceGrpc(data.userId);
  }

  @GrpcMethod('LoyaltyService', 'GetAdminTransactionHistory')
  async getAdminTransactionHistory(data: {
    userId: string;
    limit?: number;
    skip?: number;
  }) {
    return this.adminLoyaltyService.getTransactionHistoryGrpc(
      data.userId,
      data.limit ?? 50,
      data.skip ?? 0,
    );
  }

  @GrpcMethod('LoyaltyService', 'ModifyUserPoints')
  async modifyUserPoints(data: {
    userId: string;
    adminId: string;
    points: number;
    reason: string;
  }) {
    return this.adminLoyaltyService.modifyPointsGrpc(
      data.userId,
      data.adminId,
      data.points,
      data.reason,
    );
  }
}
