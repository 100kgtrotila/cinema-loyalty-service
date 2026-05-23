import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { DOTNET_CLAIM_TYPES } from '../../auth/constants/auth.constants';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload) {
    const rolesClaim =
      (payload[DOTNET_CLAIM_TYPES.ROLE] as string | string[] | undefined) ||
      payload.role ||
      payload.roles;

    const userIdClaim =
      (payload[DOTNET_CLAIM_TYPES.NAME_IDENTIFIER] as string | undefined) ||
      payload.sub ||
      payload.nameid;

    if (!userIdClaim) {
      throw new UnauthorizedException(
        'Invalid token payload: missing user identifier.',
      );
    }

    return {
      userId: userIdClaim,
      roles: Array.isArray(rolesClaim)
        ? rolesClaim
        : [rolesClaim].filter(Boolean),
    };
  }
}
