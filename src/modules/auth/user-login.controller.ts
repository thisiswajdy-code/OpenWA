import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { UserService } from './user.service';
import { AuthService } from './auth.service';
import {
  AllowOwnerScoped,
  AllowPendingApproval,
  CurrentApiKey,
  Public,
  RequireUnscopedKey,
} from './decorators/auth.decorators';
import { CurrentUserResponseDto, LoginDto, LoginOptionsResponseDto, LoginResponseDto } from './dto';
import { type ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { allowUnauthenticatedAuditRow } from '../audit/auth-failure-audit-limiter';
import { resolveClientIp } from '../../common/utils/ip';

/**
 * Password sign-in for the dashboard. `login` and `login-options` are the only routes besides the
 * health probes that take no API key: they are what a browser calls before it has one. Sign-in is
 * rate-limited per client IP more tightly than the rest of the API, since a password can be guessed
 * and an API key cannot.
 */
@ApiTags('auth')
@Controller('auth')
export class UserLoginController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly engineFactory: EngineFactory,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  @Get('login-options')
  @Public()
  @ApiOperation({ summary: 'Which sign-in methods the dashboard can offer' })
  @ApiResponse({ status: 200, description: 'Sign-in availability', type: LoginOptionsResponseDto })
  async loginOptions(): Promise<LoginOptionsResponseDto> {
    return { password: await this.userService.passwordLoginAvailable() };
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Per client IP: 5 attempts a minute, 20 a quarter hour, 100 an hour. The named tiers override the
  // deployment-wide limits of the same names for this route only.
  @Throttle({
    short: { limit: 5, ttl: 60_000 },
    medium: { limit: 20, ttl: 900_000 },
    long: { limit: 100, ttl: 3_600_000 },
  })
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiResponse({
    status: 200,
    description: 'Signed in: the body carries a login API key that lasts until `expiresAt`.',
    type: LoginResponseDto,
  })
  @ApiResponse({ status: 400, description: 'The body is malformed or carries a field the DTO does not declare.' })
  @ApiResponse({
    status: 401,
    description: 'Unknown email, wrong password, or a deactivated user: always the same message.',
  })
  @ApiResponse({ status: 429, description: 'Too many sign-in attempts from this client IP.' })
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponseDto> {
    const ipAddress = this.clientIp(req);
    const context = { ipAddress, method: req.method, path: req.path };
    try {
      const { user, apiKey, rawKey } = await this.userService.login(dto.email, dto.password);
      await this.auditService.logInfo(AuditAction.USER_LOGIN, {
        ...context,
        apiKey,
        metadata: { userId: user.id, email: user.email, loginKeyId: apiKey.id, expiresAt: apiKey.expiresAt },
      });
      return {
        apiKey: rawKey,
        role: user.role,
        engineType: this.engineFactory.getCurrentEngine(),
        expiresAt: apiKey.expiresAt as Date,
        // A non-admin user's key is scoped to the sessions they own, so the dashboard behaves as for
        // a session-scoped key (no cross-session reads, no credential pages).
        scoped: user.role !== ApiKeyRole.ADMIN,
        pendingApproval: user.approvedAt === null,
      };
    } catch (err) {
      // A refused sign-in costs the caller nothing, so its audit row is bounded per client IP like a
      // 401 that resolved no API key; the throttle above bounds the attempts themselves.
      if (allowUnauthenticatedAuditRow(ipAddress)) {
        void this.auditService.logWarn(AuditAction.USER_LOGIN_FAILED, {
          ...context,
          metadata: { email: dto.email },
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  @Get('me')
  @RequireUnscopedKey()
  @AllowPendingApproval()
  @AllowOwnerScoped()
  @ApiOperation({ summary: 'The dashboard user behind the presented login key, and whether it awaits approval' })
  @ApiResponse({ status: 200, description: 'The signed-in user.', type: CurrentUserResponseDto })
  @ApiResponse({ status: 404, description: 'The key is not a login key: no dashboard user signed in with it.' })
  async me(@CurrentApiKey() apiKey?: ApiKey): Promise<CurrentUserResponseDto> {
    if (!apiKey?.userId) throw new NotFoundException('No dashboard user signed in with this key');
    const user = await this.userService.findOne(apiKey.userId);
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      pendingApproval: user.approvedAt === null,
      approvedAt: user.approvedAt ?? undefined,
    };
  }

  @Post('logout')
  @RequireUnscopedKey()
  @AllowPendingApproval()
  @AllowOwnerScoped()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End a password sign-in by deleting its login key' })
  @ApiResponse({
    status: 204,
    description: 'The login key presented is deleted. A key that is not a login key is left as it is.',
  })
  async logout(@Req() req: Request, @CurrentApiKey() apiKey?: ApiKey): Promise<void> {
    if (!apiKey || !(await this.authService.deleteLoginKey(apiKey))) return;
    await this.auditService.logInfo(AuditAction.USER_LOGOUT, {
      apiKey,
      ipAddress: (req as Request & { clientIp?: string }).clientIp,
      method: req.method,
      path: req.path,
      metadata: { userId: apiKey.userId, loginKeyId: apiKey.id },
    });
  }

  /** The public routes run before the API-key guard, so the trusted-proxy-aware IP is resolved here. */
  private clientIp(req: Request): string {
    return resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []);
  }
}
