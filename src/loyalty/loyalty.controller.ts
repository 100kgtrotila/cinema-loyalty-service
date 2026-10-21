import {
  GrpcRequestPipe,
  userRequestSchema,
  goldRequestSchema,
  discountRequestSchema,
  adminUsersRequestSchema,
} from '../common/grpc-request.pipe';
import { GrpcExceptionFilter } from '../common/grpc-exception.filter';
import {
  Controller,
  forwardRef,
  Inject,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyExpirationService } from './loyalty-expiration.service';
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
import { AdminLoyaltyService } from './admin-loyalty.service';

@Controller()
@UseGuards(GrpcApiKeyGuard)
@UseFilters(GrpcExceptionFilter)
export class LoyaltyController {
  constructor(
    private readonly loyaltyService: LoyaltyService,
    private readonly loyaltyExpiration: LoyaltyExpirationService,

    @Inject(forwardRef(() => AdminLoyaltyService))
    private readonly adminLoyaltyService: AdminLoyaltyService,
  ) {}

  @GrpcMethod('LoyaltyService', 'GetBalance')
  getBalance(
    @Payload(new GrpcRequestPipe(userRequestSchema)) data: GetBalanceRequest,
  ) {
    return this.loyaltyService.getBalance(data.userId);
  }

  @GrpcMethod('LoyaltyService', 'GetFullProfile')
  getFullProfile(
    @Payload(new GrpcRequestPipe(userRequestSchema))
    data: GetFullProfileRequest,
  ) {
    return this.loyaltyService.getFullProfile(data.userId);
  }

  @GrpcMethod('LoyaltyService', 'GetTransactions')
  getTransactions(
    @Payload(new GrpcRequestPipe(userRequestSchema))
    data: {
      userId: string;
      limit?: number;
      skip?: number;
    },
  ) {
    return this.loyaltyService.getUserTransactions(
      data.userId,
      data.limit ?? 20,
      data.skip ?? 0,
    );
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
  useGoldUpgrade(
    @Payload(new GrpcRequestPipe(goldRequestSchema))
    data: UseGoldUpgradeRequest,
  ) {
    return this.loyaltyService.useGoldUpgrade(data.userId, data.orderId);
  }

  @GrpcMethod('LoyaltyService', 'CalculateDiscount')
  calculateDiscount(
    @Payload(new GrpcRequestPipe(discountRequestSchema))
    data: CalculateDiscountRequest,
  ) {
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
    @Payload(new GrpcRequestPipe(goldRequestSchema))
    data: RollbackGoldUpgradeRequest,
  ): Promise<RollbackGoldUpgradeResponse> {
    return this.loyaltyService.rollbackGoldUpgrade(data.userId, data.orderId);
  }

  @GrpcMethod('LoyaltyService', 'GetAdminUserBalance')
  async getAdminUserBalance(
    @Payload(new GrpcRequestPipe(userRequestSchema)) data: { userId: string },
  ) {
    return this.adminLoyaltyService.getUserBalanceGrpc(data.userId);
  }

  @GrpcMethod('LoyaltyService', 'GetAdminTransactionHistory')
  async getAdminTransactionHistory(
    @Payload(new GrpcRequestPipe(userRequestSchema))
    data: {
      userId: string;
      limit?: number;
      skip?: number;
    },
  ) {
    return this.adminLoyaltyService.getTransactionHistoryGrpc(
      data.userId,
      data.limit ?? 50,
      data.skip ?? 0,
    );
  }

  @GrpcMethod('LoyaltyService', 'ModifyUserPoints')
  async modifyUserPoints(
    @Payload(new GrpcRequestPipe(userRequestSchema))
    data: {
      userId: string;
      adminId: string;
      points: number;
      reason: string;
    },
  ) {
    return this.adminLoyaltyService.modifyPointsGrpc(
      data.userId,
      data.adminId,
      data.points,
      data.reason,
    );
  }

  @GrpcMethod('LoyaltyService', 'GetAdminUsers')
  async getAdminUsers(
    @Payload(new GrpcRequestPipe(adminUsersRequestSchema))
    data: {
      limit?: number;
      skip?: number;
      tierFilter?: string;
      userIds?: string[];
    },
  ) {
    return this.adminLoyaltyService.getUsersGrpc(
      data.limit ?? 50,
      data.skip ?? 0,
      data.tierFilter,
      data.userIds,
    );
  }

  @GrpcMethod('LoyaltyService', 'GrantVipStatus')
  async grantVipStatus(
    @Payload(new GrpcRequestPipe(userRequestSchema))
    data: {
      userId: string;
      adminId: string;
      reason: string;
    },
  ) {
    return this.adminLoyaltyService.grantVipStatusGrpc(
      data.userId,
      data.adminId,
      data.reason,
    );
  }
}
