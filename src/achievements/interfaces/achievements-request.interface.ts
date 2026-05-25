export interface CreateAchievementRequest {
  code: string;
  name: string;
  description: string;
  secretHint?: string;
  isSecret: boolean;
  icon: string;
  category: number;
  rarity: number;
  strategy: number;
  criteriaJson: string;
  rewardPoints: number;
  sortOrder: number;
  isActive: boolean;
}

export interface UpdateAchievementRequest {
  id: string;
  code: string;
  name: string;
  description: string;
  secretHint?: string;
  isSecret: boolean;
  icon: string;
  category: number;
  rarity: number;
  strategy: number;
  criteriaJson: string;
  rewardPoints: number;
  sortOrder: number;
  isActive: boolean;
}

export interface DeleteAchievementRequest {
  id: string;
}

export interface GetAdminAchievementsRequest {
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

export interface GetUserAchievementsRequest {
  userId: string;
  includeLocked?: boolean;
}
