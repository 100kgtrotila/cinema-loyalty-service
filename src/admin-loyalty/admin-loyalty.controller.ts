import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  UseGuards,
} from '@nestjs/common';
import { AdminLoyaltyService } from './admin-loyalty.service';
import { ModifyPointsDto } from './dto/modify-points.dto';
import { GetTransactionsQueryDto } from './dto/get-transactions-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseUUIDPipe } from '@nestjs/common';
import { User } from 'src/auth/decorators/user.decorator';

@Controller('admin/loyalty')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('Admin')
export class AdminLoyaltyController {
  constructor(private readonly adminLoyaltyService: AdminLoyaltyService) {}

  @Get('users/:userId/balance')
  async getUserBalance(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.adminLoyaltyService.getUserBalance(userId);
  }

  @Get('users/:userId/transactions')
  async getTransactionHistory(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: GetTransactionsQueryDto,
  ) {
    return this.adminLoyaltyService.getTransactionHistory(
      userId,
      query.limit,
      query.skip,
    );
  }

  @Post('modify-points')
  async modifyPoints(
    @Body() dto: ModifyPointsDto,
    @User('userId') adminId: string,
  ) {
    return this.adminLoyaltyService.modifyPoints(
      dto.userId,
      adminId,
      dto.points,
      dto.reason,
    );
  }
}
