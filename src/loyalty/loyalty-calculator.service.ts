import { Injectable } from '@nestjs/common';
import { Tier } from 'src/generated/prisma/enums';
import { EventType } from './enums/event-type.enum';
import { PointsTransactionType } from './events/points-transaction-type.enum';
import {
  LOYALTY_RULES,
  TIER_ORDER,
  TIME_CONSTANTS,
} from './constants/loyalty.constants';
import { LoyaltyProfileSnapshot } from './interfaces/loyalty-profile.inteface';

@Injectable()
export class LoyaltyCalculatorService {
  public resolveMultiplier(
    profile: LoyaltyProfileSnapshot,
    eventType: EventType,
  ): number {
    let multiplier = LOYALTY_RULES.TIER_MULTIPLIERS[profile.tier];

    if (this.isBirthdayWeek(profile.birthdayDate)) {
      multiplier *= LOYALTY_RULES.BIRTHDAY_MULTIPLIERS[profile.tier];
    }

    if (eventType === EventType.SPECIAL || eventType === EventType.PREMIERE) {
      multiplier *= LOYALTY_RULES.SPECIAL_EVENT_MULTIPLIER;
    }

    return multiplier;
  }

  public resolveNewTier(
    currentTier: Tier,
    visits: number,
    points: number,
  ): Tier {
    const calculatedTier = this.calculateTierByMetrics(visits, points);

    return TIER_ORDER[calculatedTier] > TIER_ORDER[currentTier]
      ? calculatedTier
      : currentTier;
  }

  public resolveTransactionType(eventType: EventType): PointsTransactionType {
    if (eventType === EventType.SPECIAL || eventType === EventType.PREMIERE) {
      return PointsTransactionType.EARN_SPECIAL;
    }
    return PointsTransactionType.EARN_TICKET;
  }

  public addYears(date: Date, years: number): Date {
    const result = new Date(date);
    const targetYear = result.getFullYear() + years;
    const targetMonth = result.getMonth();

    result.setFullYear(targetYear);

    if (result.getMonth() !== targetMonth) {
      result.setDate(0);
    }

    return result;
  }

  public isBirthdayWeek(birthdayDate: Date | null): boolean {
    if (!birthdayDate) return false;

    const today = new Date();
    const birthday = new Date(birthdayDate);

    const candidates = [-1, 0, 1].map((yearOffset) => {
      const candidate = new Date(birthday);
      candidate.setFullYear(today.getFullYear() + yearOffset);
      return candidate;
    });

    return candidates.some((candidate) => {
      const diffMs = Math.abs(today.getTime() - candidate.getTime());
      const diffDays = diffMs / TIME_CONSTANTS.MS_IN_A_DAY;
      return diffDays <= LOYALTY_RULES.BIRTHDAY_WEEK_RADIUS_DAYS;
    });
  }

  private calculateTierByMetrics(visits: number, points: number): Tier {
    const { GOLD, SILVER } = LOYALTY_RULES.TIER_THRESHOLDS;

    if (visits >= GOLD.visits || points >= GOLD.points) return Tier.GOLD;
    if (visits >= SILVER.visits || points >= SILVER.points) return Tier.SILVER;

    return Tier.BRONZE;
  }
}
