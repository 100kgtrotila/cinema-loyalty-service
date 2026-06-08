import type { CreateAchievementRequest } from '../interfaces/achievements-request.interface';

export type AchievementMutationRequest = Pick<
  CreateAchievementRequest,
  | 'code'
  | 'name'
  | 'description'
  | 'secretHint'
  | 'isSecret'
  | 'icon'
  | 'category'
  | 'rarity'
  | 'strategy'
  | 'criteriaJson'
  | 'rewardPoints'
  | 'sortOrder'
  | 'isActive'
>;
