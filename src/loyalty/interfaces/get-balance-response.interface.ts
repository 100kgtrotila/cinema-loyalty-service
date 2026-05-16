import { Tier } from 'src/generated/prisma/enums';

export interface GetBalanceResponse {
  balance: number;
  lifetimePoints: number;
  yearPoints: number;
  tier: Tier;
}
