import { Tier } from 'src/generated/prisma/enums';

export interface LoyaltyProfileSnapshot {
  id: string;
  tier: Tier;
  balance: number;
  lifetimePoints: number;
  yearPoints: number;
  yearVisits: number;
  birthdayDate: Date | null;
}
