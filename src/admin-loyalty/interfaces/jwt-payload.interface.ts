export interface JwtPayload {
  [key: string]: unknown;
  role?: string | string[];
  roles?: string | string[];
  sub?: string;
  nameid?: string;
}
