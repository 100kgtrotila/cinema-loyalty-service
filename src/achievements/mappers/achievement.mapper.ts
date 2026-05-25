import { Injectable } from '@nestjs/common';
import { Achievement, UserAchievement } from 'src/generated/prisma/client';
import {
  AchievementDto,
  UserAchievementDto,
} from '../interfaces/achievements-response.interface';
import {
  CategoryToGrpc,
  RarityToGrpc,
  StrategyToGrpc,
} from '../enums/achievement-maps.enum';

@Injectable()
export class AchievementMapper {
  toGrpc(achievement: Achievement): AchievementDto {
    return {
      id: achievement.id,
      code: achievement.code,
      name: achievement.name,
      description: achievement.description,
      secretHint: achievement.secretHint ?? undefined,
      isSecret: achievement.isSecret,
      icon: achievement.icon,
      category: CategoryToGrpc[achievement.category] ?? 0,
      rarity: RarityToGrpc[achievement.rarity] ?? 0,
      strategy: StrategyToGrpc[achievement.strategy] ?? 0,
      criteriaJson: JSON.stringify(achievement.criteria),
      rewardPoints: achievement.rewardPoints,
      sortOrder: achievement.sortOrder,
      isActive: achievement.isActive,
      createdAt: achievement.createdAt.toISOString(),
      updatedAt: achievement.updatedAt.toISOString(),
    };
  }

  toUserAchievementGrpc(
    userAchievement: UserAchievement & { achievement: Achievement },
  ): UserAchievementDto {
    return {
      achievement: this.toGrpc(userAchievement.achievement),
      current: userAchievement.current,
      target: userAchievement.target,
      isUnlocked: userAchievement.isUnlocked,
      unlockedAt: userAchievement.unlockedAt?.toISOString() ?? undefined,
    };
  }
}
