import type {
  AchievementCategory,
  AchievementRarity,
  AchievementStrategy,
} from 'src/generated/prisma/client';

const CATEGORY = {
  VISITS: 'VISITS',
  SPENDING: 'SPENDING',
  TIER: 'TIER',
  TIME: 'TIME',
  SPECIAL: 'SPECIAL',
  STREAK: 'STREAK',
  SECRET: 'SECRET',
} as const satisfies Record<AchievementCategory, AchievementCategory>;

const RARITY = {
  COMMON: 'COMMON',
  UNCOMMON: 'UNCOMMON',
  RARE: 'RARE',
  EPIC: 'EPIC',
  LEGENDARY: 'LEGENDARY',
} as const satisfies Record<AchievementRarity, AchievementRarity>;

const STRATEGY = {
  INSTANT: 'INSTANT',
  THRESHOLD: 'THRESHOLD',
  STREAK: 'STREAK',
} as const satisfies Record<AchievementStrategy, AchievementStrategy>;

export const GrpcToCategory: Record<number, AchievementCategory> = {
  1: CATEGORY.VISITS,
  2: CATEGORY.SPENDING,
  3: CATEGORY.TIER,
  4: CATEGORY.TIME,
  5: CATEGORY.SPECIAL,
  6: CATEGORY.STREAK,
  7: CATEGORY.SECRET,
};

export const GrpcToRarity: Record<number, AchievementRarity> = {
  1: RARITY.COMMON,
  2: RARITY.UNCOMMON,
  3: RARITY.RARE,
  4: RARITY.EPIC,
  5: RARITY.LEGENDARY,
};

export const GrpcToStrategy: Record<number, AchievementStrategy> = {
  1: STRATEGY.INSTANT,
  2: STRATEGY.THRESHOLD,
  3: STRATEGY.STREAK,
};

export const CategoryToGrpc: Record<AchievementCategory, number> = {
  [CATEGORY.VISITS]: 1,
  [CATEGORY.SPENDING]: 2,
  [CATEGORY.TIER]: 3,
  [CATEGORY.TIME]: 4,
  [CATEGORY.SPECIAL]: 5,
  [CATEGORY.STREAK]: 6,
  [CATEGORY.SECRET]: 7,
};

export const RarityToGrpc: Record<AchievementRarity, number> = {
  [RARITY.COMMON]: 1,
  [RARITY.UNCOMMON]: 2,
  [RARITY.RARE]: 3,
  [RARITY.EPIC]: 4,
  [RARITY.LEGENDARY]: 5,
};

export const StrategyToGrpc: Record<AchievementStrategy, number> = {
  [STRATEGY.INSTANT]: 1,
  [STRATEGY.THRESHOLD]: 2,
  [STRATEGY.STREAK]: 3,
};
