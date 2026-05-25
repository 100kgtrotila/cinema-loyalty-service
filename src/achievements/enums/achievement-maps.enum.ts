import {
  AchievementCategory,
  AchievementRarity,
  AchievementStrategy,
} from 'src/generated/prisma/client';

export const GrpcToCategory: Record<number, AchievementCategory> = {
  1: AchievementCategory.VISITS,
  2: AchievementCategory.SPENDING,
  3: AchievementCategory.TIER,
  4: AchievementCategory.TIME,
  5: AchievementCategory.SPECIAL,
  6: AchievementCategory.STREAK,
  7: AchievementCategory.SECRET,
};

export const GrpcToRarity: Record<number, AchievementRarity> = {
  1: AchievementRarity.COMMON,
  2: AchievementRarity.UNCOMMON,
  3: AchievementRarity.RARE,
  4: AchievementRarity.EPIC,
  5: AchievementRarity.LEGENDARY,
};

export const GrpcToStrategy: Record<number, AchievementStrategy> = {
  1: AchievementStrategy.INSTANT,
  2: AchievementStrategy.THRESHOLD,
  3: AchievementStrategy.STREAK,
};

export const CategoryToGrpc: Record<AchievementCategory, number> = {
  [AchievementCategory.VISITS]: 1,
  [AchievementCategory.SPENDING]: 2,
  [AchievementCategory.TIER]: 3,
  [AchievementCategory.TIME]: 4,
  [AchievementCategory.SPECIAL]: 5,
  [AchievementCategory.STREAK]: 6,
  [AchievementCategory.SECRET]: 7,
};

export const RarityToGrpc: Record<AchievementRarity, number> = {
  [AchievementRarity.COMMON]: 1,
  [AchievementRarity.UNCOMMON]: 2,
  [AchievementRarity.RARE]: 3,
  [AchievementRarity.EPIC]: 4,
  [AchievementRarity.LEGENDARY]: 5,
};

export const StrategyToGrpc: Record<AchievementStrategy, number> = {
  [AchievementStrategy.INSTANT]: 1,
  [AchievementStrategy.THRESHOLD]: 2,
  [AchievementStrategy.STREAK]: 3,
};
