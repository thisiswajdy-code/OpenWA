import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiKeyRole } from '../entities/api-key.entity';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

/** Bounds shared by the DTOs and the boot-time ADMIN_PASSWORD check. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** The longest address RFC 5321 allows; also the column width. */
export const EMAIL_MAX_LENGTH = 254;

/** Trim and lower-case an address so `Admin@Example.com ` and `admin@example.com` are one user. */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export class LoginDto {
  @ApiProperty({ description: 'The email address of a dashboard user.', example: 'admin@example.com' })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({ description: 'The user password.', example: 'correct horse battery staple' })
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class LoginResponseDto {
  @ApiProperty({
    description:
      'A login API key for this sign-in, valid until `expiresAt`. Send it as `X-API-Key` exactly like any ' +
      'other key; `POST /api/auth/logout` deletes it. It is returned only here.',
    example: 'owa_k1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  })
  apiKey!: string;

  @ApiProperty({ enum: ApiKeyRole, description: "The user's role, which the login key carries." })
  role!: ApiKeyRole;

  @ApiProperty({ description: 'Engine the process resolved at boot.', example: 'baileys' })
  engineType!: string;

  @ApiProperty({
    description: 'Always false: a login key is never restricted to selected sessions.',
    example: false,
  })
  scoped!: boolean;

  @ApiProperty({ description: 'When the login key stops authenticating.', example: '2026-11-04T10:00:00.000Z' })
  expiresAt!: Date;

  @ApiProperty({
    description:
      'True while an admin has not approved the account yet: the key then reaches only `POST /api/auth/validate`, ' +
      '`GET /api/auth/me` and `POST /api/auth/logout`, and the dashboard shows a locked "pending approval" screen.',
    example: false,
  })
  pendingApproval!: boolean;
}

/** The dashboard user behind the presented login key. */
export class CurrentUserResponseDto {
  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  id!: string;

  @ApiProperty({ example: 'ops@example.com' })
  email!: string;

  @ApiProperty({ enum: ApiKeyRole })
  role!: ApiKeyRole;

  @ApiProperty({ description: 'True until an admin approves the account.', example: false })
  pendingApproval!: boolean;

  @ApiPropertyOptional({ description: 'When an admin approved the account; absent while pending.' })
  approvedAt?: Date;
}

export class LoginOptionsResponseDto {
  @ApiProperty({
    description: 'Whether at least one active dashboard user exists, so the email and password form is useful.',
    example: true,
  })
  password!: boolean;
}

export class CreateUserDto {
  @ApiProperty({ description: 'Email address; the sign-in name. Stored lower-cased.', example: 'ops@example.com' })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({
    description: 'Password. Never returned.',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    example: 'correct horse battery staple',
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({
    description: 'Role the login key will carry.',
    enum: ApiKeyRole,
    default: ApiKeyRole.OPERATOR,
  })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ description: 'New email address.', example: 'ops@example.com' })
  @IsOptional()
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email?: string;

  @ApiPropertyOptional({
    description: 'New password. Every login key the user holds is deleted, so they sign in again.',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password?: string;

  @ApiPropertyOptional({
    description: 'New role. Every login key the user holds is deleted, so the next sign-in carries it.',
    enum: ApiKeyRole,
  })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional({
    description: 'false refuses new sign-ins and deletes every login key the user holds.',
    example: true,
  })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  isActive?: boolean;
}

export class UserResponseDto {
  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  id!: string;

  @ApiProperty({ example: 'ops@example.com' })
  email!: string;

  @ApiProperty({ enum: ApiKeyRole })
  role!: ApiKeyRole;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiPropertyOptional({ description: 'The last successful sign-in; absent before the first.' })
  lastLoginAt?: Date;

  @ApiProperty({
    description:
      'True until an admin approves the account (`POST /api/auth/users/:id/approve`). A user an admin creates is ' +
      'approved at once; a self-service sign-up is not, and signs in to a locked dashboard until approved.',
    example: false,
  })
  pendingApproval!: boolean;

  @ApiPropertyOptional({ description: 'When an admin approved the account; absent while pending.' })
  approvedAt?: Date;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
