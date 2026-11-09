import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PasswordResetService } from './password-reset.service';
import { Public } from './decorators/auth.decorators';
import {
  ConfirmPasswordResetDto,
  ConfirmPasswordResetResponseDto,
  RequestPasswordResetDto,
  RequestPasswordResetResponseDto,
} from './dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { allowUnauthenticatedAuditRow } from '../audit/auth-failure-audit-limiter';
import { resolveClientIp } from '../../common/utils/ip';

/**
 * Password reset for dashboard users, by a code emailed to the address. Public like `login`: the
 * caller has no key, that is the point. Both routes are rate-limited per client IP more tightly
 * than sign-in, since a request costs an email and a confirmation is a guess at a code.
 */
@ApiTags('auth')
@Controller('auth/password-reset')
export class PasswordResetController {
  constructor(
    private readonly resets: PasswordResetService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  @Post('request')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({
    short: { limit: 3, ttl: 60_000 },
    medium: { limit: 10, ttl: 900_000 },
    long: { limit: 30, ttl: 3_600_000 },
  })
  @ApiOperation({ summary: 'Email a password reset code to a dashboard user' })
  @ApiResponse({
    status: 200,
    description: 'Answered the same whether or not the address has a user.',
    type: RequestPasswordResetResponseDto,
  })
  @ApiResponse({ status: 400, description: 'The body is malformed or carries a field the DTO does not declare.' })
  @ApiResponse({ status: 429, description: 'Too many requests from this client IP.' })
  @ApiResponse({ status: 503, description: 'Email is not configured on this gateway (`EMAIL_API_KEY` unset).' })
  async request(@Body() dto: RequestPasswordResetDto, @Req() req: Request): Promise<RequestPasswordResetResponseDto> {
    const { known, sent } = await this.resets.request(dto.email);
    await this.auditService.logInfo(AuditAction.USER_PASSWORD_RESET_REQUESTED, {
      ...this.context(req),
      metadata: { email: dto.email, known, sent },
    });
    return { sent: true };
  }

  @Post('confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({
    short: { limit: 5, ttl: 60_000 },
    medium: { limit: 20, ttl: 900_000 },
    long: { limit: 100, ttl: 3_600_000 },
  })
  @ApiOperation({ summary: 'Set a new password with the emailed code' })
  @ApiResponse({
    status: 200,
    description: 'The password was changed and every login key of the user deleted.',
    type: ConfirmPasswordResetResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed body, or `"Invalid or expired code"` for a wrong, used, expired or exhausted code.',
  })
  @ApiResponse({ status: 429, description: 'Too many attempts from this client IP.' })
  async confirm(@Body() dto: ConfirmPasswordResetDto, @Req() req: Request): Promise<ConfirmPasswordResetResponseDto> {
    const context = this.context(req);
    try {
      const user = await this.resets.confirm(dto.email, dto.code, dto.password);
      await this.auditService.logInfo(AuditAction.USER_PASSWORD_RESET, {
        ...context,
        metadata: { userId: user.id, email: user.email },
      });
      return { reset: true };
    } catch (err) {
      // A refused code costs the caller nothing, so its audit row is bounded per client IP like a
      // refused sign-in; the throttle above bounds the guesses themselves.
      if (allowUnauthenticatedAuditRow(context.ipAddress)) {
        void this.auditService.logWarn(AuditAction.USER_PASSWORD_RESET_FAILED, {
          ...context,
          metadata: { email: dto.email },
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  /** The public routes run before the API-key guard, so the trusted-proxy-aware IP is resolved here. */
  private context(req: Request) {
    return {
      ipAddress: resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []),
      method: req.method,
      path: req.path,
    };
  }
}
