import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  INVALID_RESET_CODE,
  PasswordResetService,
  RESET_CODE_MAX_ATTEMPTS,
  RESET_CODE_TTL_MS,
  generateResetCode,
} from './password-reset.service';
import { hashPassword, verifyPassword } from './password-hash';
import type { User } from './entities/user.entity';

function makeService(users: Partial<User>[] = [], emailEnabled = true) {
  const rows = users.map(
    u => ({ id: 'u1', resetCodeHash: null, resetCodeExpiresAt: null, resetAttempts: 0, ...u }) as User,
  );
  const repository = {
    findOne: jest.fn(({ where }: { where: { email: string } }) =>
      Promise.resolve(rows.find(r => r.email === where.email) ?? null),
    ),
    update: jest.fn((id: string, patch: Partial<User>) => {
      const row = rows.find(r => r.id === id);
      if (row) Object.assign(row, patch);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
  };
  const authService = { deleteLoginKeysOfUser: jest.fn().mockResolvedValue(1) };
  const emails = { enabled: emailEnabled, sendPasswordReset: jest.fn().mockResolvedValue(true) };
  const service = new PasswordResetService(repository as never, authService as never, emails as never);
  return { service, repository, authService, emails, rows };
}

describe('generateResetCode', () => {
  it('is six digits, zero-padded', () => {
    for (let i = 0; i < 50; i++) expect(generateResetCode()).toMatch(/^\d{6}$/);
  });
});

describe('PasswordResetService.request', () => {
  it('refuses when email is not configured, before touching any user', async () => {
    const { service, repository } = makeService([{ email: 'dana@example.com' }], false);
    await expect(service.request('dana@example.com')).rejects.toThrow(ServiceUnavailableException);
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('stores the hash of the code it emails, with the expiry, and resets the attempt count', async () => {
    const { service, rows, emails } = makeService([{ email: 'dana@example.com', resetAttempts: 3 }]);
    const before = Date.now();
    await expect(service.request('dana@example.com')).resolves.toEqual({ known: true, sent: true });
    const [user, code, minutes] = emails.sendPasswordReset.mock.calls[0] as [User, string, number];
    expect(user.email).toBe('dana@example.com');
    expect(code).toMatch(/^\d{6}$/);
    expect(minutes).toBe(RESET_CODE_TTL_MS / 60_000);
    expect(rows[0].resetAttempts).toBe(0);
    expect(rows[0].resetCodeExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + RESET_CODE_TTL_MS);
    await expect(verifyPassword(code, rows[0].resetCodeHash as string)).resolves.toBe(true);
  });

  it('answers an unknown address without a mail, after hashing a code like a known one', async () => {
    const { service, emails, repository } = makeService([]);
    await expect(service.request('who@example.com')).resolves.toEqual({ known: false, sent: false });
    expect(emails.sendPasswordReset).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('PasswordResetService.confirm', () => {
  const pending = async (over: Partial<User> = {}): Promise<Partial<User>> => ({
    email: 'dana@example.com',
    passwordHash: 'old',
    resetCodeHash: await hashPassword('048213'),
    resetCodeExpiresAt: new Date(Date.now() + 60_000),
    resetAttempts: 0,
    ...over,
  });

  it('sets the password, clears the reset and deletes every login key for the right code', async () => {
    const { service, rows, authService } = makeService([await pending()]);
    const user = await service.confirm('dana@example.com', '048213', 'new password here');
    expect(user.id).toBe('u1');
    await expect(verifyPassword('new password here', rows[0].passwordHash)).resolves.toBe(true);
    expect(rows[0]).toMatchObject({ resetCodeHash: null, resetCodeExpiresAt: null, resetAttempts: 0 });
    expect(authService.deleteLoginKeysOfUser).toHaveBeenCalledWith('u1');
    // The code is single-use.
    await expect(service.confirm('dana@example.com', '048213', 'again')).rejects.toThrow(INVALID_RESET_CODE);
  });

  it('refuses an unknown address, no pending reset and an expired code with the one message', async () => {
    const expired = await pending({ resetCodeExpiresAt: new Date(Date.now() - 1) });
    const { service, rows, authService } = makeService([expired, { id: 'u2', email: 'none@example.com' }]);
    for (const email of ['who@example.com', 'none@example.com', 'dana@example.com']) {
      await expect(service.confirm(email, '048213', 'new password here')).rejects.toThrow(
        new BadRequestException(INVALID_RESET_CODE),
      );
    }
    // The expired hash is discarded, and nothing else changed.
    expect(rows[0]).toMatchObject({ resetCodeHash: null, passwordHash: 'old' });
    expect(authService.deleteLoginKeysOfUser).not.toHaveBeenCalled();
  });

  it('counts wrong codes and discards the reset at the limit', async () => {
    const { service, rows } = makeService([await pending()]);
    for (let i = 1; i < RESET_CODE_MAX_ATTEMPTS; i++) {
      await expect(service.confirm('dana@example.com', '000000', 'new password here')).rejects.toThrow(
        INVALID_RESET_CODE,
      );
      expect(rows[0].resetAttempts).toBe(i);
      expect(rows[0].resetCodeHash).not.toBeNull();
    }
    await expect(service.confirm('dana@example.com', '000000', 'new password here')).rejects.toThrow(
      INVALID_RESET_CODE,
    );
    expect(rows[0].resetCodeHash).toBeNull();
    // Even the right code is refused now: a new one must be requested.
    await expect(service.confirm('dana@example.com', '048213', 'new password here')).rejects.toThrow(
      INVALID_RESET_CODE,
    );
    expect(rows[0].passwordHash).toBe('old');
  });
});
