import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { SignupService } from './signup.service';
import { SignupPlanService } from './signup-plan.service';
import { toSignupPlanResponse } from './signup-plan.controller';
import { Public } from './decorators/auth.decorators';
import { RegisterDto, RegisterResponseDto, SignupPlanResponseDto } from './dto';
import type { User } from './entities/user.entity';
import type { ArvyLink } from './arvy-client';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { resolveClientIp } from '../../common/utils/ip';

/**
 * Self-service sign-up from the site. Public like `login`: a visitor has no key yet. Creating a
 * user is rate-limited per client IP as tightly as sign-in, since each attempt costs a password
 * hash and a call to the payment API.
 */
@ApiTags('auth')
@Controller('auth/register')
export class SignupController {
  constructor(
    private readonly signupService: SignupService,
    private readonly plans: SignupPlanService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  // Declared before `:id` so the literal segment wins.
  @Get('plan')
  @Public()
  @ApiOperation({ summary: 'What a sign-up is charged: the plan the site shows' })
  @ApiResponse({
    status: 200,
    description: 'The current plan and whether sign-up is enabled.',
    type: SignupPlanResponseDto,
  })
  async plan(): Promise<SignupPlanResponseDto> {
    return toSignupPlanResponse(await this.plans.get(), this.signupService.enabled);
  }

  @Post()
  @Public()
  @Throttle({
    short: { limit: 5, ttl: 60_000 },
    medium: { limit: 20, ttl: 900_000 },
    long: { limit: 100, ttl: 3_600_000 },
  })
  @ApiOperation({ summary: 'Sign up: create an inactive dashboard user and its payment link' })
  @ApiResponse({
    status: 201,
    description: 'User created, inactive until a card is saved on `paymentLink`.',
    type: RegisterResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 409, description: 'A user with this email already exists.' })
  @ApiResponse({ status: 429, description: 'Too many sign-up attempts from this client IP.' })
  @ApiResponse({ status: 502, description: 'The payment service refused or did not answer; no user was kept.' })
  @ApiResponse({ status: 503, description: 'Sign-up is not enabled (`ARVY_API_TOKEN` unset).' })
  async register(@Body() dto: RegisterDto, @Req() req: Request): Promise<RegisterResponseDto> {
    const { user, link } = await this.signupService.register(dto);
    await this.auditService.logInfo(AuditAction.USER_CREATED, {
      ...this.context(req),
      metadata: {
        targetUserId: user.id,
        email: user.email,
        role: user.role,
        selfRegistered: true,
        paymentLinkId: user.paymentLinkId,
      },
    });
    return this.toResponse(user, link);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Payment status of a sign-up; activates the user once a card is saved' })
  @ApiResponse({
    status: 200,
    description: 'The sign-up and the current status of its payment link.',
    type: RegisterResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No sign-up with this id.' })
  @ApiResponse({ status: 502, description: 'The payment service did not answer.' })
  async status(@Param('id') id: string, @Req() req: Request): Promise<RegisterResponseDto> {
    const { user, link, activated } = await this.signupService.status(id);
    if (activated) {
      await this.auditService.logInfo(AuditAction.USER_UPDATED, {
        ...this.context(req),
        metadata: {
          targetUserId: user.id,
          before: { isActive: false },
          after: { isActive: true },
          activatedByPayment: true,
          paymentLinkId: user.paymentLinkId,
        },
      });
    }
    return this.toResponse(user, link);
  }

  private toResponse(user: User, link: ArvyLink): RegisterResponseDto {
    return {
      id: user.id,
      email: user.email,
      paymentLink: link.payment_link,
      amount: link.amount,
      currencyCode: link.currency_code,
      chargeFrequency: link.charge_frequency,
      paymentsNumber: link.sto_payments_number,
      status: link.status,
      active: user.isActive,
    };
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
