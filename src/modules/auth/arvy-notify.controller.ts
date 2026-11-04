import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { SignupService } from './signup.service';
import { ArvyClient } from './arvy-client';
import { Public } from './decorators/auth.decorators';
import { ArvyNotifyResponseDto } from './dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { resolveClientIp } from '../../common/utils/ip';
import { createLogger } from '../../common/services/logger.service';
import { parseArvyNotification } from './arvy-client';

/**
 * The notify URL registered with the payment service for this gateway's source (`/notify`, outside
 * the `/api` prefix). Arvy POSTs here once, when a sign-up's card is saved and billing becomes
 * active. The body is trusted only through its HMAC signature over the raw bytes, keyed with
 * `ARVY_SOURCE_SECRET`; it is then parsed from those same bytes, never from the JSON parser's view.
 */
@ApiTags('auth')
@Controller('notify')
export class ArvyNotifyController {
  private readonly logger = createLogger('ArvyNotify');

  constructor(
    private readonly signupService: SignupService,
    private readonly arvy: ArvyClient,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Payment-service notification: a sign-up’s recurring payment became active' })
  @ApiResponse({
    status: 200,
    description: 'Received. `activated` says whether this call activated the user; other events are ignored.',
    type: ArvyNotifyResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'The body is neither a recurring-payment nor a one-time-link notification.',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid `X-Arvy-Signature`.' })
  @ApiResponse({ status: 404, description: 'No sign-up matches the payment link or its reference.' })
  @ApiResponse({ status: 503, description: 'Notifications are not configured (`ARVY_SOURCE_SECRET` unset).' })
  async notify(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-arvy-signature') signature: string | undefined,
  ): Promise<ArvyNotifyResponseDto> {
    if (!this.arvy.notificationsEnabled) {
      throw new ServiceUnavailableException('Payment notifications are not configured on this gateway');
    }
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    if (!this.arvy.verifyNotification(rawBody, signature)) {
      this.logger.warn('Payment notification refused: bad signature', { ipAddress: this.clientIp(req) });
      throw new UnauthorizedException('Invalid notification signature');
    }
    const notification = parseArvyNotification(rawBody);
    if (!notification) throw new BadRequestException('The body is not a payment notification');

    const { user, activated, ignored } = await this.signupService.activateFromNotification(notification);
    if (activated && user && notification.recurring_payment) {
      await this.auditService.logInfo(AuditAction.USER_UPDATED, {
        ipAddress: this.clientIp(req),
        method: req.method,
        path: req.path,
        metadata: {
          targetUserId: user.id,
          before: { isActive: false },
          after: { isActive: true },
          activatedByPayment: true,
          paymentLinkId: String(notification.recurring_payment.id),
          event: notification.event,
        },
      });
    }
    return { received: true, event: notification.event, activated, ignored };
  }

  private clientIp(req: Request): string {
    return resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []);
  }
}
