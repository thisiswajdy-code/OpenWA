import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ModuleRef } from '@nestjs/core';
import { createHash } from 'crypto';
import { IsNull } from 'typeorm';
import { AuthService, loginKeyName } from './auth.service';
import { User } from './entities/user.entity';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

/**
 * Login keys (api_keys rows with a userId) are sessions minted by a password sign-in, not credentials
 * an admin manages: they stay out of the key list, never count as a usable admin for the last-admin
 * guard, and are deleted on logout or with their user.
 */
describe('AuthService — login keys', () => {
  let service: AuthService;
  let repo: {
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let usageTracker: { forget: jest.Mock };
  let evicted: Array<[string, string]>;
  let executed: Array<{ sql: string; params: Record<string, unknown> }>;

  beforeEach(async () => {
    delete process.env.API_KEY_PEPPER;
    evicted = [];
    executed = [];
    const qb = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation((sql: string, params: Record<string, unknown>) => {
        executed.push({ sql, params });
        return qb;
      }),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    repo = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((dto: Partial<ApiKey>) => ({ id: 'new-id', ...dto })),
      save: jest.fn((key: ApiKey) => Promise.resolve(key)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qb),
    };
    usageTracker = { forget: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(ApiKey, 'main'), useValue: repo },
        { provide: getRepositoryToken(User, 'main'), useValue: { findOne: jest.fn() } },
        { provide: ApiKeyUsageTracker, useValue: usageTracker },
        {
          provide: ModuleRef,
          useValue: { get: () => ({ evictApiKey: (id: string, reason: string) => evicted.push([id, reason]) }) },
        },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('names a login key after its user, within the column width', () => {
    expect(loginKeyName('admin@example.com')).toBe('Dashboard login: admin@example.com');
    expect(Array.from(loginKeyName(`${'x'.repeat(200)}@example.com`))).toHaveLength(100);
  });

  it('createLoginKey mints an owned, expiring, unscoped key with the user role and returns the raw key once', async () => {
    const before = Date.now();
    const { apiKey, rawKey } = await service.createLoginKey(
      { id: 'u1', email: 'ops@example.com', role: ApiKeyRole.OPERATOR },
      3_600_000,
    );
    expect(rawKey).toMatch(/^owa_k1_[a-f0-9]{64}$/);
    expect(apiKey).toMatchObject({
      name: 'Dashboard login: ops@example.com',
      keyHash: createHash('sha256').update(rawKey).digest('hex'),
      keyPrefix: rawKey.slice(0, 12),
      role: ApiKeyRole.OPERATOR,
      userId: 'u1',
      allowedIps: null,
      allowedSessions: null,
      allowedChats: null,
    });
    const expiry = (apiKey.expiresAt as Date).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('findAll lists only keys without an owner', async () => {
    await service.findAll();
    expect(repo.find).toHaveBeenCalledWith({ where: { userId: IsNull() }, order: { createdAt: 'DESC' } });
  });

  it('deleteLoginKey deletes only a key with an owner, then forgets and evicts it', async () => {
    await expect(service.deleteLoginKey({ id: 'plain', userId: null })).resolves.toBe(false);
    expect(repo.delete).not.toHaveBeenCalled();

    await expect(service.deleteLoginKey({ id: 'login', userId: 'u1' })).resolves.toBe(true);
    expect(repo.delete).toHaveBeenCalledWith({ id: 'login', userId: 'u1' });
    expect(usageTracker.forget).toHaveBeenCalledWith('login');
    expect(evicted).toEqual([['login', 'deleted']]);
  });

  it('deleteLoginKey reports false when the row was already gone', async () => {
    repo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.deleteLoginKey({ id: 'login', userId: 'u1' })).resolves.toBe(false);
    expect(evicted).toEqual([]);
  });

  it('deleteLoginKeysOfUser deletes every key of the user and evicts each live socket', async () => {
    repo.find.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await expect(service.deleteLoginKeysOfUser('u1')).resolves.toBe(2);
    expect(repo.delete).toHaveBeenCalledWith({ userId: 'u1' });
    expect(evicted).toEqual([
      ['a', 'revoked'],
      ['b', 'revoked'],
    ]);
  });

  it('purgeExpiredLoginKeys deletes only owned keys past their expiry, bound in the stored datetime format', async () => {
    await service.purgeExpiredLoginKeys();
    expect(executed).toHaveLength(1);
    expect(executed[0].sql).toBe('"userId" IS NOT NULL AND "expiresAt" IS NOT NULL AND "expiresAt" < :now');
    expect(executed[0].params.now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});
