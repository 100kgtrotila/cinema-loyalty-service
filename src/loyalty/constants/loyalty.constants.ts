import { Tier } from 'src/generated/prisma/enums';

export const BATCH_SIZE = 500;
export const NOTIFY_DAYS_BEFORE = 30;

export const TIME_CONSTANTS = {
  MS_IN_A_DAY: 1000 * 60 * 60 * 24,
};

export const TIER_ORDER: Record<Tier, number> = {
  [Tier.BRONZE]: 0,
  [Tier.SILVER]: 1,
  [Tier.GOLD]: 2,
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

export const LOYALTY_QUEUE_NAME = 'loyalty-queue';
export const LOYALTY_PUBLISHER_NAME = 'LOYALTY_PUBLISHER';

export const LOYALTY_JOBS = {
  EXPIRE_POINTS: 'expire-points',
  NOTIFY_EXPIRING: 'notify-expiring',
  ANNUAL_RESET: 'annual-reset',
  GOLD_RESET: 'gold-reset',
} as const;

export const CRON_SCHEDULES = {
  EVERY_NIGHT_03_00: '0 3 * * *',
  EVERY_NIGHT_04_00: '0 4 * * *',
  FIRST_OF_JAN_00_05: '5 0 1 1 *',
  FIRST_OF_MONTH_01_00: '0 1 1 * *',
} as const;

export const INJECTION_TOKENS = {
  RABBITMQ_LOYALTY_CLIENT: 'LOYALTY_PUBLISHER',
} as const;

export const RABBITMQ_EVENTS = {
  POINTS_EXPIRING: 'loyalty.points_expiring',
  TIER_UPGRADED: 'loyalty.tier_upgraded',
} as const;
