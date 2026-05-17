import { Tier } from 'src/generated/prisma/enums';

export const TIME_CONSTANTS = {
  MS_IN_A_DAY: 1000 * 60 * 60 * 24,
};

export const LOYALTY_RULES = {
  BIRTHDAY_WEEK_RADIUS_DAYS: 3,
  SPECIAL_EVENT_MULTIPLIER: 2.0,

  MINIMUM_DEDUCTION: 75,

  TIER_THRESHOLDS: {
    [Tier.GOLD]: { visits: 20, points: 5000 },
    [Tier.SILVER]: { visits: 8, points: 2000 },
  },

  TIER_MULTIPLIERS: {
    [Tier.GOLD]: 2.0,
    [Tier.SILVER]: 1.5,
    [Tier.BRONZE]: 1.0,
  },

  BIRTHDAY_MULTIPLIERS: {
    [Tier.GOLD]: 5,
    [Tier.SILVER]: 3,
    [Tier.BRONZE]: 2,
  },
};
