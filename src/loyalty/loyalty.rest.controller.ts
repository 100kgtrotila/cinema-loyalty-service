import { Controller, Get, UseGuards } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('loyalty')
export class LoyaltyRestController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Get('my-transactions')
  @UseGuards(JwtAuthGuard)
  async getMyTransactions(@CurrentUser('userId') userId: string) {
    return this.loyaltyService.getUserTransactions(userId);
  }
}
