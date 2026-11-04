import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { INVALID_CREDENTIALS, UserService, resolveLoginSessionTtlMs } from './user.service';
import { AuthService } from './auth.service';
import { User } from './entities/user.entity';
import { ApiKeyRole } from './entities/api-key.entity';
import { hashPassword, verifyPassword } from './password-hash';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'admin@example.com',
    passwordHash: 'scrypt$1$1$1$x$y',
    role: ApiKeyRole.ADMIN,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('resolveLoginSessionTtlMs', () => {
  it('defaults to a day and clamps a configured value to [1, 720] hours', () => {
    expect(resolveLoginSessionTtlMs({})).toBe(24 * 3_600_000);
    expect(resolveLoginSessionTtlMs({ LOGIN_SESSION_TTL_HOURS: '12' })).toBe(12 * 3_600_000);
    expect(resolveLoginSessionTtlMs({ LOGIN_SESSION_TTL_HOURS: ' 0.5 ' })).toBe(3_600_000);
    expect(resolveLoginSessionTtlMs({ LOGIN_SESSION_TTL_HOURS: '100000' })).toBe(720 * 3_600_000);
    expect(resolveLoginSessionTtlMs({ LOGIN_SESSION_TTL_HOURS: 'soon' })).toBe(24 * 3_600_000);
    expect(resolveLoginSessionTtlMs({ LOGIN_SESSION_TTL_HOURS: '-3' })).toBe(24 * 3_600_000);
  });
});

describe('UserService', () => {
  let service: UserService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let authService: { createLoginKey: jest.Mock; deleteLoginKeysOfUser: jest.Mock; purgeExpiredLoginKeys: jest.Mock };
  const ORIGINAL_ENV = process.env;

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((dto: Partial<User>) => ({ ...makeUser(), ...dto })),
      save: jest.fn((user: User) => Promise.resolve(user)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    authService = {
      createLoginKey: jest.fn().mockResolvedValue({ apiKey: { id: 'login-key' }, rawKey: 'owa_k1_raw' }),
      deleteLoginKeysOfUser: jest.fn().mockResolvedValue(0),
      purgeExpiredLoginKeys: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User, 'main'), useValue: repo },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    service = module.get(UserService);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('seeding from ADMIN_EMAIL / ADMIN_PASSWORD', () => {
    it('does nothing when the variables are unset', async () => {
      await service.onModuleInit();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('creates an ADMIN user, with the address normalized, when none holds it yet', async () => {
      process.env.ADMIN_EMAIL = ' Admin@Example.com ';
      process.env.ADMIN_PASSWORD = 'correct horse battery staple';
      await service.onModuleInit();
      expect(repo.exists).toHaveBeenCalledWith({ where: { email: 'admin@example.com' } });
      const saved = (repo.save.mock.calls[0] as [User])[0];
      expect(saved.email).toBe('admin@example.com');
      expect(saved.role).toBe(ApiKeyRole.ADMIN);
      await expect(verifyPassword('correct horse battery staple', saved.passwordHash)).resolves.toBe(true);
    });

    it('leaves an existing user alone: a changed ADMIN_PASSWORD does not rotate the password', async () => {
      process.env.ADMIN_EMAIL = 'admin@example.com';
      process.env.ADMIN_PASSWORD = 'a-new-password-value';
      repo.exists.mockResolvedValue(true);
      await service.onModuleInit();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    const password = 'correct horse battery staple';
    let user: User;

    beforeEach(async () => {
      user = makeUser({ passwordHash: await hashPassword(password) });
      repo.findOne.mockResolvedValue(user);
    });

    it('mints a login key for the right password and stamps lastLoginAt', async () => {
      const result = await service.login('admin@example.com', password);
      expect(result.rawKey).toBe('owa_k1_raw');
      expect(authService.purgeExpiredLoginKeys).toHaveBeenCalled();
      expect(authService.createLoginKey).toHaveBeenCalledWith(user, 24 * 3_600_000);
      expect(repo.update).toHaveBeenCalledWith('user-1', { lastLoginAt: expect.any(Date) as Date });
    });

    const refusals: Array<[string, () => void, string]> = [
      ['a wrong password', () => undefined, 'not-the-password'],
      ['an unknown email', () => repo.findOne.mockResolvedValue(null), password],
      ['a deactivated user', () => repo.findOne.mockResolvedValue({ ...user, isActive: false }), password],
    ];
    it.each(refusals)('refuses %s with the one shared 401 and mints nothing', async (_case, arrange, attempt) => {
      arrange();
      await expect(service.login('admin@example.com', attempt)).rejects.toThrow(
        new UnauthorizedException(INVALID_CREDENTIALS),
      );
      expect(authService.createLoginKey).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('create hashes the password, defaults the role to operator, and refuses a taken email', async () => {
      const created = await service.create({ email: 'ops@example.com', password: 'password-123' });
      expect(created.role).toBe(ApiKeyRole.OPERATOR);
      expect(created.passwordHash).not.toContain('password-123');
      await expect(verifyPassword('password-123', created.passwordHash)).resolves.toBe(true);

      repo.exists.mockResolvedValue(true);
      await expect(service.create({ email: 'ops@example.com', password: 'password-123' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('findOne answers 404 for an unknown id', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('nope')).rejects.toThrow(NotFoundException);
    });

    it('a rename keeps the login keys; a password, role or deactivation change deletes them', async () => {
      repo.findOne.mockResolvedValue(makeUser());
      await service.update('user-1', { email: 'new@example.com' });
      expect(authService.deleteLoginKeysOfUser).not.toHaveBeenCalled();

      await service.update('user-1', { role: ApiKeyRole.ADMIN });
      expect(authService.deleteLoginKeysOfUser).not.toHaveBeenCalled();

      await service.update('user-1', { password: 'another-password' });
      await service.update('user-1', { role: ApiKeyRole.VIEWER });
      await service.update('user-1', { isActive: false });
      expect(authService.deleteLoginKeysOfUser).toHaveBeenCalledTimes(3);
    });

    it('a rename to another user’s email is refused', async () => {
      repo.findOne.mockResolvedValue(makeUser());
      repo.exists.mockResolvedValue(true);
      await expect(service.update('user-1', { email: 'taken@example.com' })).rejects.toThrow(ConflictException);
    });

    it('delete removes the login keys before the row', async () => {
      repo.findOne.mockResolvedValue(makeUser());
      const order: string[] = [];
      authService.deleteLoginKeysOfUser.mockImplementation(() => Promise.resolve(order.push('keys')));
      repo.delete.mockImplementation(() => {
        order.push('row');
        return Promise.resolve({ affected: 1, raw: undefined });
      });
      await service.delete('user-1');
      expect(order).toEqual(['keys', 'row']);
    });
  });
});
