import {
  BadGatewayException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { ApiKeyRole } from './entities/api-key.entity';
import { hashPassword } from './password-hash';
import { RegisterDto } from './dto';
import { ArvyApiError, ArvyClient, type ArvyLink } from './arvy-client';
import { createLogger } from '../../common/services/logger.service';

/**
 * The one account the site sells: twelve monthly charges. Prices are tried in order — USD first,
 * and ILS when the payment API refuses USD with a 422 — and the refusal is remembered for the
 * process lifetime, so later sign-ups go straight to the currency the API accepts.
 */
export const SIGNUP_PLAN = {
  description: 'Scalorus WA — 12 months',
  chargeFrequency: 'monthly' as const,
  paymentsNumber: 12,
  prices: [
    { currencyCode: 'USD', amount: 30 },
    { currencyCode: 'ILS', amount: 95 },
  ],
};

/**
 * `first_charge_date` must be today or later as the payment API sees it, and it bills in Israel:
 * the UTC date is a day behind for the first hours after midnight there, which the API would refuse
 * as a past date.
 */
export function todayInIsrael(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Link statuses that mean the customer saved a card, which activates the user. */
const PAID_STATUSES: ReadonlySet<string> = new Set(['active', 'completed']);

/**
 * Self-service sign-up from the site: a dashboard user is created inactive, a recurring payment
 * link is made for it, and the user is activated once the link reports that a card was saved.
 */
@Injectable()
export class SignupService {
  private readonly logger = createLogger('SignupService');
  /** Index into SIGNUP_PLAN.prices of the first currency the API has not refused. */
  private priceIndex = 0;

  constructor(
    @InjectRepository(User, 'main')
    private readonly userRepository: Repository<User>,
    private readonly arvy: ArvyClient,
  ) {}

  get enabled(): boolean {
    return this.arvy.enabled;
  }

  async register(dto: RegisterDto): Promise<{ user: User; link: ArvyLink }> {
    if (!this.arvy.enabled) throw new ServiceUnavailableException('Sign-up is not enabled on this gateway');
    if (await this.userRepository.exists({ where: { email: dto.email } })) {
      throw new ConflictException(`A user with email '${dto.email}' already exists`);
    }
    const user = await this.userRepository.save(
      this.userRepository.create({
        email: dto.email,
        passwordHash: await hashPassword(dto.password),
        role: ApiKeyRole.OPERATOR,
        isActive: false,
      }),
    );
    let link: ArvyLink;
    try {
      link = await this.createLink(dto);
    } catch (error) {
      // No link, no account: the email stays free for another attempt.
      await this.userRepository.delete(user.id);
      this.logger.warn('Payment link creation failed', {
        email: dto.email,
        status: error instanceof ArvyApiError ? error.status : undefined,
        error: error instanceof Error ? error.message : String(error),
        body: error instanceof ArvyApiError ? error.body : undefined,
      });
      throw new BadGatewayException('The payment service could not create a payment link');
    }
    user.paymentLinkId = String(link.id);
    await this.userRepository.update(user.id, { paymentLinkId: user.paymentLinkId });
    this.logger.log(`User signed up: ${user.email}`, {
      userId: user.id,
      paymentLinkId: user.paymentLinkId,
      currency: link.currency_code,
      action: 'user_signed_up',
    });
    return { user, link };
  }

  private async createLink(dto: RegisterDto): Promise<ArvyLink> {
    const { prices } = SIGNUP_PLAN;
    for (let i = this.priceIndex; i < prices.length; i++) {
      const price = prices[i];
      try {
        const link = await this.arvy.createLink({
          amount: price.amount,
          currency_code: price.currencyCode,
          charge_frequency: SIGNUP_PLAN.chargeFrequency,
          description: SIGNUP_PLAN.description,
          first_charge_date: todayInIsrael(),
          sto_payments_number: SIGNUP_PLAN.paymentsNumber,
          customer_email: dto.email,
          customer_name: dto.name,
          locale: dto.locale,
        });
        this.priceIndex = i;
        return link;
      } catch (error) {
        const next = prices[i + 1];
        if (!next || !(error instanceof ArvyApiError) || error.status !== 422) throw error;
        this.logger.warn(`Payment API refused ${price.currencyCode}; trying ${next.currencyCode}`, {
          body: error.body,
        });
      }
    }
    throw new Error('No price to try');
  }

  /** Where the sign-up's payment stands; activates the user the first time a card is reported saved. */
  async status(userId: string): Promise<{ user: User; link: ArvyLink; activated: boolean }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user?.paymentLinkId) throw new NotFoundException('No sign-up with this id');
    let link: ArvyLink;
    try {
      link = await this.arvy.getLink(user.paymentLinkId);
    } catch (error) {
      this.logger.warn('Payment link lookup failed', {
        paymentLinkId: user.paymentLinkId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadGatewayException('The payment service could not report the payment status');
    }
    let activated = false;
    if (!user.isActive && PAID_STATUSES.has(link.status)) {
      user.isActive = true;
      await this.userRepository.update(user.id, { isActive: true });
      activated = true;
      this.logger.log(`User activated by payment: ${user.email}`, { userId: user.id, action: 'user_activated' });
    }
    return { user, link, activated };
  }
}
