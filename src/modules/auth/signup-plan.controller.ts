import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SignupPlanService, type SignupPlan } from './signup-plan.service';
import { SignupService } from './signup.service';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from './decorators/auth.decorators';
import { type ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { SignupPlanDto, SignupPlanResponseDto } from './dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/** The public view of the plan, shared with `GET /api/auth/register/plan`. */
export function toSignupPlanResponse(plan: SignupPlan, enabled: boolean): SignupPlanResponseDto {
  return {
    ...plan,
    total: Math.round(plan.amount * plan.paymentsNumber * 100) / 100,
    enabled,
  };
}

/**
 * The subscription an admin sells through the site's sign-up. Fenced like user management: the
 * price is what every self-service sign-up is charged, so only an unscoped ADMIN key changes it.
 */
@ApiTags('auth')
@Controller('auth/signup-plan')
@RequireUnscopedKey()
@RequireRole(ApiKeyRole.ADMIN)
export class SignupPlanController {
  constructor(
    private readonly plans: SignupPlanService,
    private readonly signupService: SignupService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The sign-up plan: what a self-service sign-up is charged (admin only)' })
  @ApiResponse({ status: 200, description: 'The current plan.', type: SignupPlanResponseDto })
  async get(): Promise<SignupPlanResponseDto> {
    return toSignupPlanResponse(await this.plans.get(), this.signupService.enabled);
  }

  @Put()
  @ApiOperation({ summary: 'Change the sign-up plan (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'The plan as saved; later sign-ups are charged this.',
    type: SignupPlanResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  async update(
    @Body() dto: SignupPlanDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<SignupPlanResponseDto> {
    const before = await this.plans.get();
    const plan = await this.plans.update({
      description: dto.description,
      amount: dto.amount,
      currencyCode: dto.currencyCode,
      paymentsNumber: dto.paymentsNumber,
      chargeFrequency: 'monthly',
      fallbackAmountIls: dto.fallbackAmountIls ?? null,
    });
    // A currency the service refused under the old plan gets another chance under the new one.
    this.signupService.forgetRefusals();
    await this.auditService.logInfo(AuditAction.SIGNUP_PLAN_UPDATED, {
      apiKey: actor,
      ipAddress: (req as Request & { clientIp?: string }).clientIp ?? undefined,
      method: req.method,
      path: req.path,
      metadata: { before, after: plan },
    });
    return toSignupPlanResponse(plan, this.signupService.enabled);
  }
}
