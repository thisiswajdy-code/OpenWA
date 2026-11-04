import { IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, normalizeEmail } from './user.dto';
import { ToStrictNumber } from '../../../common/utils/strict-boolean';
import { SIGNUP_CURRENCIES, SIGNUP_PLAN_LIMITS, type SignupCurrency } from '../signup-plan.service';

export const SIGNUP_LOCALES = ['he', 'en', 'ar'] as const;
export type SignupLocale = (typeof SIGNUP_LOCALES)[number];

export class RegisterDto {
  @ApiPropertyOptional({ description: 'Customer name, passed to the payment page.', maxLength: 120, example: 'Dana' })
  @IsOptional()
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiProperty({ description: 'Email address; the sign-in name. Stored lower-cased.', example: 'dana@example.com' })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({
    description: 'Password for the dashboard. Never returned.',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    example: 'correct horse battery staple',
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({ description: 'Language of the payment page.', enum: SIGNUP_LOCALES, example: 'he' })
  @IsOptional()
  @IsIn(SIGNUP_LOCALES)
  locale?: SignupLocale;
}

export class RegisterResponseDto {
  @ApiProperty({
    description: 'The user id; poll `GET /api/auth/register/:id` with it.',
    example: '0a941dac-a965-45e7-b318-74ae8be134f0',
  })
  id!: string;

  @ApiProperty({ example: 'dana@example.com' })
  email!: string;

  @ApiProperty({
    description: 'The page where the customer saves a card; embed or open it.',
    example: 'https://arvy.store/billing/setup/3f2b…',
  })
  paymentLink!: string;

  @ApiProperty({ description: 'Charge per period.', example: 30 })
  amount!: number;

  @ApiProperty({ description: 'Three-letter currency of `amount`.', example: 'USD' })
  currencyCode!: string;

  @ApiProperty({ example: 'monthly' })
  chargeFrequency!: string;

  @ApiProperty({ description: 'Number of charges.', example: 12 })
  paymentsNumber!: number;

  @ApiProperty({
    description:
      'Payment link status: pending_card until a card is saved, then active; completed after the last charge; cancelled.',
    example: 'pending_card',
  })
  status!: string;

  @ApiProperty({ description: 'Whether the user can sign in: true once a card was saved.', example: false })
  active!: boolean;
}

export class ArvyNotifyResponseDto {
  @ApiProperty({ example: true })
  received!: boolean;

  @ApiProperty({ description: 'The event the notification carried.', example: 'recurring_payment.active' })
  event!: string;

  @ApiProperty({ description: 'Whether this notification activated the user.', example: true })
  activated!: boolean;

  @ApiProperty({
    description: 'True for an event other than `recurring_payment.active`, which is acknowledged and ignored.',
    example: false,
  })
  ignored!: boolean;
}

export class SignupPlanDto {
  @ApiProperty({
    description: 'Shown on the payment page.',
    maxLength: SIGNUP_PLAN_LIMITS.descriptionMax,
    example: 'Scalorus WA — 12 months',
  })
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(SIGNUP_PLAN_LIMITS.descriptionMax)
  description!: string;

  @ApiProperty({ description: 'Charge per month.', minimum: SIGNUP_PLAN_LIMITS.amountMin, example: 30 })
  @ToStrictNumber()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(SIGNUP_PLAN_LIMITS.amountMin)
  @Max(SIGNUP_PLAN_LIMITS.amountMax)
  amount!: number;

  @ApiProperty({ description: 'Currency of `amount`.', enum: SIGNUP_CURRENCIES, example: 'USD' })
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn(SIGNUP_CURRENCIES)
  currencyCode!: SignupCurrency;

  @ApiProperty({
    description: 'Number of monthly charges.',
    minimum: SIGNUP_PLAN_LIMITS.paymentsMin,
    maximum: SIGNUP_PLAN_LIMITS.paymentsMax,
    example: 12,
  })
  @ToStrictNumber()
  @IsInt()
  @Min(SIGNUP_PLAN_LIMITS.paymentsMin)
  @Max(SIGNUP_PLAN_LIMITS.paymentsMax)
  paymentsNumber!: number;

  @ApiPropertyOptional({
    description:
      'Monthly charge in ILS used when the payment service refuses `currencyCode`; null or absent disables the fallback.',
    nullable: true,
    example: 95,
  })
  @IsOptional()
  @ToStrictNumber()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(SIGNUP_PLAN_LIMITS.amountMin)
  @Max(SIGNUP_PLAN_LIMITS.amountMax)
  fallbackAmountIls?: number | null;
}

export class SignupPlanResponseDto {
  @ApiProperty({ example: 'Scalorus WA — 12 months' })
  description!: string;

  @ApiProperty({ description: 'Charge per month.', example: 30 })
  amount!: number;

  @ApiProperty({ enum: SIGNUP_CURRENCIES, example: 'USD' })
  currencyCode!: SignupCurrency;

  @ApiProperty({ description: 'Number of monthly charges.', example: 12 })
  paymentsNumber!: number;

  @ApiProperty({ example: 'monthly' })
  chargeFrequency!: 'monthly';

  @ApiPropertyOptional({
    description: 'ILS monthly charge used when the service refuses `currencyCode`.',
    nullable: true,
    example: 95,
  })
  fallbackAmountIls!: number | null;

  @ApiProperty({ description: '`amount` × `paymentsNumber`.', example: 360 })
  total!: number;

  @ApiProperty({ description: 'Whether sign-up is enabled on this gateway (`ARVY_API_TOKEN` set).', example: true })
  enabled!: boolean;
}
