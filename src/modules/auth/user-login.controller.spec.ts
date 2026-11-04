import 'reflect-metadata';
import type { Request } from 'express';
import { UnauthorizedException } from '@nestjs/common';
import { UserLoginController } from './user-login.controller';
import { UserController } from './user.controller';
import { PUBLIC_KEY, REQUIRED_ROLE_KEY, UNSCOPED_KEY } from './decorators/auth.decorators';
import { ApiKeyRole, type ApiKey } from './entities/api-key.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { INVALID_CREDENTIALS } from './user.service';

const handler = (controller: object, name: string): object =>
  Object.getOwnPropertyDescriptor(controller, name)?.value as object;

describe('UserLoginController — route markers', () => {
  it.each(['loginOptions', 'login'] as const)('%s is public: it runs before any key exists', name => {
    expect(Reflect.getMetadata(PUBLIC_KEY, handler(UserLoginController.prototype, name))).toBe(true);
  });

  it('logout is not public and refuses a session-scoped key like every global route', () => {
    expect(Reflect.getMetadata(PUBLIC_KEY, handler(UserLoginController.prototype, 'logout'))).toBeUndefined();
    expect(Reflect.getMetadata(UNSCOPED_KEY, handler(UserLoginController.prototype, 'logout'))).toBe(true);
  });

  it('login is throttled more tightly than the deployment-wide tiers, per tier name', () => {
    const limit = (tier: string): unknown =>
      Reflect.getMetadata(`THROTTLER:LIMIT${tier}`, handler(UserLoginController.prototype, 'login'));
    expect(limit('short')).toBe(5);
    expect(limit('medium')).toBe(20);
    expect(limit('long')).toBe(100);
  });
});

describe('UserController — fenced like API-key management', () => {
  it('requires an unscoped ADMIN key at the class level', () => {
    expect(Reflect.getMetadata(UNSCOPED_KEY, UserController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, UserController)).toBe(ApiKeyRole.ADMIN);
  });
});

describe('UserLoginController — sign-in audit trail', () => {
  const req = { method: 'POST', path: '/auth/login', socket: { remoteAddress: '203.0.113.7' } } as unknown as Request;
  let userService: { login: jest.Mock };
  let authService: { deleteLoginKey: jest.Mock };
  let auditService: { logInfo: jest.Mock; logWarn: jest.Mock };
  let controller: UserLoginController;

  beforeEach(() => {
    userService = { login: jest.fn() };
    authService = { deleteLoginKey: jest.fn() };
    auditService = { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) };
    controller = new UserLoginController(
      userService as never,
      authService as never,
      { getCurrentEngine: () => 'baileys' } as never,
      auditService as never,
      { get: () => [] } as never,
    );
  });

  it('answers the login key with the user’s role, the engine and the expiry, and audits the sign-in', async () => {
    const expiresAt = new Date('2026-11-04T10:00:00.000Z');
    userService.login.mockResolvedValue({
      user: { id: 'u1', email: 'admin@example.com', role: ApiKeyRole.ADMIN },
      apiKey: { id: 'k1', expiresAt },
      rawKey: 'owa_k1_raw',
    });
    await expect(controller.login({ email: 'admin@example.com', password: 'pw' }, req)).resolves.toEqual({
      apiKey: 'owa_k1_raw',
      role: ApiKeyRole.ADMIN,
      engineType: 'baileys',
      scoped: false,
      expiresAt,
    });
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_LOGIN,
      expect.objectContaining({
        ipAddress: '203.0.113.7',
        metadata: expect.objectContaining({ userId: 'u1', email: 'admin@example.com', loginKeyId: 'k1' }) as object,
      }),
    );
  });

  it('audits a refused sign-in as a warning, with the address tried, and rethrows the 401', async () => {
    userService.login.mockRejectedValue(new UnauthorizedException(INVALID_CREDENTIALS));
    await expect(controller.login({ email: 'who@example.com', password: 'pw' }, req)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.USER_LOGIN_FAILED,
      expect.objectContaining({
        ipAddress: '203.0.113.7',
        metadata: { email: 'who@example.com' },
        errorMessage: INVALID_CREDENTIALS,
      }),
    );
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });

  it('logout audits only a login key it actually deleted', async () => {
    const plain = { id: 'k-plain', userId: null } as unknown as ApiKey;
    authService.deleteLoginKey.mockResolvedValue(false);
    await controller.logout(req, plain);
    expect(auditService.logInfo).not.toHaveBeenCalled();

    const login = { id: 'k-login', userId: 'u1' } as unknown as ApiKey;
    authService.deleteLoginKey.mockResolvedValue(true);
    await controller.logout(req, login);
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_LOGOUT,
      expect.objectContaining({ apiKey: login, metadata: { userId: 'u1', loginKeyId: 'k-login' } }),
    );
  });
});
