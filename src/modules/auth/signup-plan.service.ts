import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from './entities/setting.entity';
import { createLogger } from '../../common/services/logger.service';

/** Currencies the payment service accepts on a recurring link. */
export const SIGNUP_CURRENCIES = ['USD', 'ILS', 'EUR'] as const;
export type SignupCurrency = (typeof SIGNUP_CURRENCIES)[number];

/** Bounds shared by the DTO and the stored-row check. */
export const SIGNUP_PLAN_LIMITS = {
  amountMin: 0.01,
  amountMax: 1_000_000,
  paymentsMin: 2,
  paymentsMax: 9999,
  descriptionMax: 255,
};

/**
 * What the site sells: a recurring link of `paymentsNumber` monthly charges of `amount` in
 * `currencyCode`. When the payment service refuses that currency with a 422 and
 * `fallbackAmountIls` is set, the link is created in ILS at that amount instead.
 */
export interface SignupPlan {
  description: string;
  amount: number;
  currencyCode: SignupCurrency;
  paymentsNumber: number;
  chargeFrequency: 'monthly';
  fallbackAmountIls: number | null;
}

export const SIGNUP_PLAN_KEY = 'signup.plan';

export const DEFAULT_SIGNUP_PLAN: SignupPlan = {
  description: 'Scalorus WA — 12 months',
  amount: 30,
  currencyCode: 'USD',
  paymentsNumber: 12,
  chargeFrequency: 'monthly',
  fallbackAmountIls: 95,
};

const isMoney = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= SIGNUP_PLAN_LIMITS.amountMin && value <= max;

/**
 * Read a stored plan back, field by field, falling back to the default for anything missing or
 * malformed, so a hand-edited or older row can never take sign-up down.
 */
export function normalizeSignupPlan(raw: unknown): SignupPlan {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof SignupPlan, unknown>>;
  const { amountMax, paymentsMin, paymentsMax, descriptionMax } = SIGNUP_PLAN_LIMITS;
  const description =
    typeof value.description === 'string' && value.description.trim() && value.description.length <= descriptionMax
      ? value.description.trim()
      : DEFAULT_SIGNUP_PLAN.description;
  const currencyCode = (SIGNUP_CURRENCIES as readonly string[]).includes(String(value.currencyCode))
    ? (value.currencyCode as SignupCurrency)
    : DEFAULT_SIGNUP_PLAN.currencyCode;
  const paymentsNumber =
    Number.isInteger(value.paymentsNumber) &&
    (value.paymentsNumber as number) >= paymentsMin &&
    (value.paymentsNumber as number) <= paymentsMax
      ? (value.paymentsNumber as number)
      : DEFAULT_SIGNUP_PLAN.paymentsNumber;
  return {
    description,
    amount: isMoney(value.amount, amountMax) ? value.amount : DEFAULT_SIGNUP_PLAN.amount,
    currencyCode,
    paymentsNumber,
    chargeFrequency: 'monthly',
    fallbackAmountIls:
      value.fallbackAmountIls === undefined
        ? DEFAULT_SIGNUP_PLAN.fallbackAmountIls
        : isMoney(value.fallbackAmountIls, amountMax)
          ? value.fallbackAmountIls
          : null,
  };
}

/** The sign-up plan, kept as the `signup.plan` setting; the default until an admin saves one. */
@Injectable()
export class SignupPlanService {
  private readonly logger = createLogger('SignupPlan');
  private cached: SignupPlan | null = null;

  constructor(
    @InjectRepository(Setting, 'main')
    private readonly settings: Repository<Setting>,
  ) {}

  async get(): Promise<SignupPlan> {
    if (this.cached) return this.cached;
    const row = await this.settings.findOne({ where: { key: SIGNUP_PLAN_KEY } });
    let parsed: unknown = null;
    if (row) {
      try {
        parsed = JSON.parse(row.value);
      } catch {
        this.logger.warn('Stored sign-up plan is not JSON; using the default');
      }
    }
    this.cached = normalizeSignupPlan(parsed);
    return this.cached;
  }

  async update(plan: SignupPlan): Promise<SignupPlan> {
    const normalized = normalizeSignupPlan(plan);
    await this.settings.save(this.settings.create({ key: SIGNUP_PLAN_KEY, value: JSON.stringify(normalized) }));
    this.cached = normalized;
    this.logger.log('Sign-up plan updated', {
      amount: normalized.amount,
      currency: normalized.currencyCode,
      payments: normalized.paymentsNumber,
      action: 'signup_plan_updated',
    });
    return normalized;
  }
}
