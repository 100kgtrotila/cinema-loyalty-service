export interface AchievementDto {
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
  createdAt: string;
  updatedAt: string;
}

export interface UserAchievementDto {
  achievement: AchievementDto;
  current: number;
  target: number;
  isUnlocked: boolean;
  unlockedAt?: string;
}

export interface CreateAchievementResponse {
  achievement: AchievementDto;
}

export interface UpdateAchievementResponse {
  achievement: AchievementDto;
}

export interface DeleteAchievementResponse {
  achievement: AchievementDto;
}

export interface GetAdminAchievementsResponse {
  achievements: AchievementDto[];
  total: number;
}

export interface GetUserAchievementsResponse {
  achievements: UserAchievementDto[];
}
