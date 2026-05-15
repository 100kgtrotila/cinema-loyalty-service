import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class LoyaltyService {
  constructor(private readonly prismaService: PrismaService) {}

  async getBalance(userId: string) {
    const profile = await this.prismaService.loyaltyProfile.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
      },
    });

    return {
      points: profile.points,
      tier: profile.tier,
    };
  }
}
