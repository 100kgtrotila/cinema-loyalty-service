import { Injectable } from '@nestjs/common';
import type { Achievement, UserAchievement } from 'src/generated/prisma/client';
import {
  AchievementDto,
  UserAchievementDto,
} from '../interfaces/achievements-response.interface';
import {
  CategoryToGrpc,
  RarityToGrpc,
  StrategyToGrpc,
} from '../enums/achievement-maps.enum';
import type { UserAchievementMapperOptions } from '../interfaces/achievement-mapper-options.interface';

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
    options: UserAchievementMapperOptions = {},
  ): UserAchievementDto {
    const shouldMask =
      options.maskLockedSecrets &&
      userAchievement.achievement.isSecret &&
      !userAchievement.isUnlocked;

    if (shouldMask) {
      return {
        achievement: this.toLockedSecretGrpc(userAchievement.achievement),
        current: 0,
        target: 1,
        isUnlocked: false,
        unlockedAt: undefined,
      };
    }

    return {
      achievement: this.toGrpc(userAchievement.achievement),
      current: userAchievement.current,
      target: userAchievement.target,
      isUnlocked: userAchievement.isUnlocked,
      unlockedAt: userAchievement.unlockedAt?.toISOString() ?? undefined,
    };
  }

  private toLockedSecretGrpc(achievement: Achievement): AchievementDto {
    return {
      id: achievement.id,
      code: `secret-${achievement.id}`,
      name: 'Secret achievement',
      description: achievement.secretHint ?? '',
      secretHint: achievement.secretHint ?? undefined,
      isSecret: true,
      icon: 'lock',
      category: CategoryToGrpc[achievement.category] ?? 0,
      rarity: RarityToGrpc[achievement.rarity] ?? 0,
      strategy: StrategyToGrpc[achievement.strategy] ?? 0,
      criteriaJson: '{}',
      rewardPoints: 0,
      sortOrder: achievement.sortOrder,
      isActive: achievement.isActive,
      createdAt: achievement.createdAt.toISOString(),
      updatedAt: achievement.updatedAt.toISOString(),
    };
  }
}
