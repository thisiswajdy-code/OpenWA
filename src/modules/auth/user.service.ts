import { ConflictException, Injectable, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { AuthService } from './auth.service';
import { hashPassword, verifyPassword } from './password-hash';
import { CreateUserDto, UpdateUserDto, normalizeEmail } from './dto';
import { createLogger } from '../../common/services/logger.service';

/** One message for every refusal, so a response never says whether the address has a user. */
export const INVALID_CREDENTIALS = 'Invalid email or password';

const HOUR_MS = 3_600_000;
const DEFAULT_LOGIN_TTL_HOURS = 24;
/** Thirty days: long enough for a kiosk, short enough that a forgotten tab does not hold a key for a year. */
const MAX_LOGIN_TTL_HOURS = 720;

/**
 * How long a login key lasts, from `LOGIN_SESSION_TTL_HOURS`. Unset or unparseable means a day; a
 * value is clamped to [1, 720] hours rather than refused, because a sign-in that fails over a config
 * typo is worse than one that lasts a different time than asked.
 */
export function resolveLoginSessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.LOGIN_SESSION_TTL_HOURS?.trim());
  const hours = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LOGIN_TTL_HOURS) : DEFAULT_LOGIN_TTL_HOURS;
  return Math.max(hours, 1) * HOUR_MS;
}

/**
 * Dashboard users and their password sign-in. A sign-in verifies the password and mints a login API
 * key through AuthService (see user.entity.ts for why a key, not a token of its own).
 */
@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = createLogger('UserService');
  /**
   * A hash no password matches, verified when the address has no user, so a missing user costs the
   * same time as a wrong password and the response timing does not reveal which addresses exist.
   */
  private decoyHash: Promise<string> | undefined;

  constructor(
    @InjectRepository(User, 'main')
    private readonly userRepository: Repository<User>,
    private readonly authService: AuthService,
  ) {}

  /**
   * Seed the first user from `ADMIN_EMAIL` + `ADMIN_PASSWORD`, read only while that address has no
   * user yet: changing the variables later changes nothing, so a password is rotated through
   * `PUT /api/auth/users/:id` (or by any ADMIN API key), never by editing the environment.
   */
  async onModuleInit(): Promise<void> {
    const email = normalizeEmail(process.env.ADMIN_EMAIL);
    const password = process.env.ADMIN_PASSWORD;
    if (typeof email !== 'string' || !email || !password) return;
    if (await this.userRepository.exists({ where: { email } })) return;
    await this.userRepository.save(
      this.userRepository.create({
        email,
        passwordHash: await hashPassword(password),
        role: ApiKeyRole.ADMIN,
        approvedAt: new Date(),
      }),
    );
    this.logger.log(`Seeded dashboard admin user from ADMIN_EMAIL: ${email}`, { action: 'user_seeded' });
  }

  /** Whether the email and password form can sign anyone in: at least one active user exists. */
  async passwordLoginAvailable(): Promise<boolean> {
    return this.userRepository.exists({ where: { isActive: true } });
  }

  /**
   * Verify a password and mint a login key for the user. Every refusal is the same 401, and a
   * missing user still runs a hash so it takes as long as a wrong password.
   */
  async login(email: string, password: string): Promise<{ user: User; apiKey: ApiKey; rawKey: string }> {
    const user = await this.userRepository.findOne({ where: { email } });
    const ok = await verifyPassword(password, user?.passwordHash ?? (await this.decoy()));
    if (!user || !ok || !user.isActive) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    user.lastLoginAt = new Date();
    await this.userRepository.update(user.id, { lastLoginAt: user.lastLoginAt });
    // Expired login keys are never used again; sweeping them here keeps the table from growing by
    // one row per sign-in without a scheduled job.
    await this.authService.purgeExpiredLoginKeys();
    const { apiKey, rawKey } = await this.authService.createLoginKey(user, resolveLoginSessionTtlMs());
    return { user, apiKey, rawKey };
  }

  async create(dto: CreateUserDto): Promise<User> {
    if (await this.userRepository.exists({ where: { email: dto.email } })) {
      throw new ConflictException(`A user with email '${dto.email}' already exists`);
    }
    const user = this.userRepository.create({
      email: dto.email,
      passwordHash: await hashPassword(dto.password),
      role: dto.role ?? ApiKeyRole.OPERATOR,
      // An admin creating a user is the approval; only a self-service sign-up waits for one.
      approvedAt: new Date(),
    });
    const saved = await this.userRepository.save(user);
    this.logger.log(`User created: ${saved.email}`, { userId: saved.id, role: saved.role, action: 'user_created' });
    return saved;
  }

  async findAll(): Promise<User[]> {
    return this.userRepository.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User with id '${id}' not found`);
    return user;
  }

  /**
   * Apply a change. A new password, role or deactivation deletes every login key the user holds,
   * because a key minted under the old credential or role must not keep its powers: the key carries
   * the role it was minted with, and the HTTP guard never re-reads the user.
   */
  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);
    if (dto.email !== undefined && dto.email !== user.email) {
      if (await this.userRepository.exists({ where: { email: dto.email } })) {
        throw new ConflictException(`A user with email '${dto.email}' already exists`);
      }
      user.email = dto.email;
    }
    const revokesLogins =
      dto.password !== undefined || (dto.role !== undefined && dto.role !== user.role) || dto.isActive === false;
    if (dto.password !== undefined) user.passwordHash = await hashPassword(dto.password);
    if (dto.role !== undefined) user.role = dto.role;
    if (dto.isActive !== undefined) user.isActive = dto.isActive;
    const saved = await this.userRepository.save(user);
    if (revokesLogins) await this.authService.deleteLoginKeysOfUser(id);
    return saved;
  }

  /**
   * Approve a self-service sign-up: from now on its login keys reach every route its role allows,
   * including the one the user is already signed in with (validateApiKey re-reads the user). An
   * already approved user is returned unchanged.
   */
  async approve(id: string): Promise<{ user: User; approved: boolean }> {
    const user = await this.findOne(id);
    if (user.approvedAt !== null) return { user, approved: false };
    user.approvedAt = new Date();
    await this.userRepository.update(id, { approvedAt: user.approvedAt });
    this.logger.log(`User approved: ${user.email}`, { userId: id, action: 'user_approved' });
    return { user, approved: true };
  }

  async delete(id: string): Promise<User> {
    const user = await this.findOne(id);
    await this.authService.deleteLoginKeysOfUser(id);
    await this.userRepository.delete(id);
    this.logger.log(`User deleted: ${user.email}`, { userId: id, action: 'user_deleted' });
    return user;
  }

  private decoy(): Promise<string> {
    // Any non-empty password works: it is never compared against anything but itself.
    this.decoyHash ??= hashPassword('decoy');
    return this.decoyHash;
  }
}
