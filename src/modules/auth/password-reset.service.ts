import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomInt } from 'node:crypto';
import { User } from './entities/user.entity';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { hashPassword, verifyPassword } from './password-hash';
import { RESET_CODE_LENGTH } from './dto';
import { createLogger } from '../../common/services/logger.service';

/** How long an emailed code is accepted. */
export const RESET_CODE_TTL_MS = 15 * 60_000;
/** Wrong codes allowed before the pending reset is thrown away and a new code must be requested. */
export const RESET_CODE_MAX_ATTEMPTS = 5;
/** One message for every refusal, so a response never says which part was wrong. */
export const INVALID_RESET_CODE = 'Invalid or expired code';
export const RESET_UNAVAILABLE = 'Password reset is not available: email is not configured on this gateway';

/** A fresh code of RESET_CODE_LENGTH digits, from the CSPRNG and zero-padded. */
export function generateResetCode(): string {
  return String(randomInt(0, 10 ** RESET_CODE_LENGTH)).padStart(RESET_CODE_LENGTH, '0');
}

const CLEARED = { resetCodeHash: null, resetCodeExpiresAt: null, resetAttempts: 0 } as const;

/**
 * Password reset by emailed code. A request stores the scrypt hash of a six-digit code on the user
 * and emails the code; a confirmation that presents the code within its lifetime sets the new
 * password and deletes every login key the user holds. Neither route says whether an address has
 * a user: a request for an unknown address answers like any other, and every refused confirmation
 * gets the same message.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = createLogger('PasswordReset');

  constructor(
    @InjectRepository(User, 'main')
    private readonly userRepository: Repository<User>,
    private readonly authService: AuthService,
    private readonly emails: EmailService,
  ) {}

  get enabled(): boolean {
    return this.emails.enabled;
  }

  /**
   * Email a code to the address when it has a user. Resolves either way, after the same work, so
   * the answer and its timing do not tell an unknown address from a known one. Returns whether a
   * user exists, for the audit row only; the response never carries it.
   */
  async request(email: string): Promise<{ known: boolean; sent: boolean }> {
    if (!this.enabled) throw new ServiceUnavailableException(RESET_UNAVAILABLE);
    const user = await this.userRepository.findOne({ where: { email } });
    const code = generateResetCode();
    const resetCodeHash = await hashPassword(code);
    if (!user) return { known: false, sent: false };
    const resetCodeExpiresAt = new Date(Date.now() + RESET_CODE_TTL_MS);
    await this.userRepository.update(user.id, { resetCodeHash, resetCodeExpiresAt, resetAttempts: 0 });
    const sent = await this.emails.sendPasswordReset(user, code, RESET_CODE_TTL_MS / 60_000);
    this.logger.log(`Password reset code ${sent ? 'sent' : 'NOT sent'}: ${user.email}`, {
      userId: user.id,
      sent,
      action: 'password_reset_requested',
    });
    return { known: true, sent };
  }

  /**
   * Check the code and set the password. A wrong code counts against RESET_CODE_MAX_ATTEMPTS;
   * reaching it, or the expiry, discards the pending reset. The new password deletes every login
   * key the user holds, like a password change by an admin does.
   */
  async confirm(email: string, code: string, password: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { email } });
    const pending =
      user?.resetCodeHash && user.resetCodeExpiresAt && user.resetCodeExpiresAt.getTime() > Date.now() ? user : null;
    if (!pending) {
      // A stale hash is cleared so it cannot be tried again after the expiry.
      if (user?.resetCodeHash) await this.userRepository.update(user.id, CLEARED);
      throw new BadRequestException(INVALID_RESET_CODE);
    }
    if (!(await verifyPassword(code, pending.resetCodeHash as string))) {
      const resetAttempts = pending.resetAttempts + 1;
      await this.userRepository.update(
        pending.id,
        resetAttempts >= RESET_CODE_MAX_ATTEMPTS ? CLEARED : { resetAttempts },
      );
      throw new BadRequestException(INVALID_RESET_CODE);
    }
    pending.passwordHash = await hashPassword(password);
    await this.userRepository.update(pending.id, { passwordHash: pending.passwordHash, ...CLEARED });
    await this.authService.deleteLoginKeysOfUser(pending.id);
    this.logger.log(`Password reset: ${pending.email}`, { userId: pending.id, action: 'password_reset' });
    return pending;
  }
}
