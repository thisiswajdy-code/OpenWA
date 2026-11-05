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
import { SignupPlanService, type SignupPlan } from './signup-plan.service';
import { SignupEmailService } from './signup-email.service';
import {
  ARVY_ACTIVE_EVENT,
  ARVY_LANG_FOR_LOCALE,
  ArvyApiError,
  ArvyClient,
  type ArvyLink,
  type ArvyNotification,
} from './arvy-client';
import { createLogger } from '../../common/services/logger.service';

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
  /**
   * Currencies the payment service refused with a 422 since the plan was last saved, so later
   * sign-ups go straight to the fallback instead of paying for the refusal again.
   */
  private readonly refusedCurrencies = new Set<string>();

  constructor(
    @InjectRepository(User, 'main')
    private readonly userRepository: Repository<User>,
    private readonly arvy: ArvyClient,
    private readonly plans: SignupPlanService,
    private readonly emails: SignupEmailService,
  ) {}

  /** Called when the plan changes: a currency refused under the old plan gets another chance. */
  forgetRefusals(): void {
    this.refusedCurrencies.clear();
  }

  /** The prices to try for a plan, in order: the plan's own, then the ILS fallback when set. */
  static attemptsFor(plan: SignupPlan): Array<{ amount: number; currencyCode: string }> {
    const attempts = [{ amount: plan.amount, currencyCode: plan.currencyCode }];
    if (plan.currencyCode !== 'ILS' && plan.fallbackAmountIls !== null) {
      attempts.push({ amount: plan.fallbackAmountIls, currencyCode: 'ILS' });
    }
    return attempts;
  }

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
      link = await this.createLink(dto, user.id);
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
    // The welcome mail carries the payment page, so a closed tab does not lose the sign-up.
    this.emails.sendRegistered(user, link, dto.name);
    return { user, link };
  }

  /** The link is created under this gateway's source, with the user id as its reference. */
  private async createLink(dto: RegisterDto, reference: string): Promise<ArvyLink> {
    const plan = await this.plans.get();
    const attempts = SignupService.attemptsFor(plan);
    for (let i = 0; i < attempts.length; i++) {
      const price = attempts[i];
      const next = attempts[i + 1];
      if (next && this.refusedCurrencies.has(price.currencyCode)) continue;
      try {
        return await this.arvy.createLink({
          amount: price.amount,
          currency_code: price.currencyCode,
          charge_frequency: plan.chargeFrequency,
          description: plan.description,
          first_charge_date: todayInIsrael(),
          sto_payments_number: plan.paymentsNumber,
          source_id: this.arvy.sourceId,
          reference,
          customer_email: dto.email,
          customer_name: dto.name,
          // Both spellings of the card-page language; the API prefers `lang`.
          lang: dto.locale ? ARVY_LANG_FOR_LOCALE[dto.locale] : undefined,
          locale: dto.locale,
        });
      } catch (error) {
        if (!next || !(error instanceof ArvyApiError) || error.status !== 422) throw error;
        this.refusedCurrencies.add(price.currencyCode);
        this.logger.warn(`Payment API refused ${price.currencyCode}; trying ${next.currencyCode}`, {
          body: error.body,
        });
      }
    }
    throw new Error('No price to try');
  }

  /**
   * Apply Arvy's notification for the source: the payment it names became active, so its user is
   * activated. Found by the link id, or by the reference (the user id) when the id is unknown. Any
   * other event (a one-time link paid, say) is acknowledged and ignored.
   */
  async activateFromNotification(
    notification: ArvyNotification,
  ): Promise<{ user: User | null; activated: boolean; ignored: boolean }> {
    const payment = notification.recurring_payment;
    if (notification.event !== ARVY_ACTIVE_EVENT || !payment) return { user: null, activated: false, ignored: true };
    const user =
      (await this.userRepository.findOne({ where: { paymentLinkId: String(payment.id) } })) ??
      (payment.reference ? await this.userRepository.findOne({ where: { id: payment.reference } }) : null);
    if (!user) throw new NotFoundException(`No sign-up for payment link ${payment.id}`);
    let activated = false;
    if (!user.isActive && PAID_STATUSES.has(payment.status)) {
      user.isActive = true;
      await this.userRepository.update(user.id, { isActive: true });
      activated = true;
      this.logger.log(`User activated by payment notification: ${user.email}`, {
        userId: user.id,
        paymentLinkId: String(payment.id),
        action: 'user_activated',
      });
      this.emails.sendSubscriptionActive(user);
    }
    return { user, activated, ignored: false };
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
      this.emails.sendSubscriptionActive(user);
    }
    return { user, link, activated };
  }
}
