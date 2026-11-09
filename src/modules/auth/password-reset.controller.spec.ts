import 'reflect-metadata';
import type { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import { PasswordResetController } from './password-reset.controller';
import { PUBLIC_KEY } from './decorators/auth.decorators';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { INVALID_RESET_CODE } from './password-reset.service';

const handler = (name: string): object =>
  Object.getOwnPropertyDescriptor(PasswordResetController.prototype, name)?.value as object;

describe('PasswordResetController — route markers', () => {
  it.each(['request', 'confirm'] as const)('%s is public: the caller has no key', name => {
    expect(Reflect.getMetadata(PUBLIC_KEY, handler(name))).toBe(true);
  });

  it('a request is throttled tighter than sign-in (each one costs an email); a confirmation like sign-in', () => {
    const limit = (name: string, tier: string): unknown => Reflect.getMetadata(`THROTTLER:LIMIT${tier}`, handler(name));
    expect([limit('request', 'short'), limit('request', 'medium'), limit('request', 'long')]).toEqual([3, 10, 30]);
    expect([limit('confirm', 'short'), limit('confirm', 'medium'), limit('confirm', 'long')]).toEqual([5, 20, 100]);
  });
});

describe('PasswordResetController — answers and audit trail', () => {
  const req = (path: string) =>
    ({ method: 'POST', path, socket: { remoteAddress: '203.0.113.7' } }) as unknown as Request;
  let resets: { request: jest.Mock; confirm: jest.Mock };
  let auditService: { logInfo: jest.Mock; logWarn: jest.Mock };
  let controller: PasswordResetController;

  beforeEach(() => {
    resets = { request: jest.fn(), confirm: jest.fn() };
    auditService = { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) };
    controller = new PasswordResetController(resets as never, auditService as never, { get: () => [] } as never);
  });

  it('a request answers sent:true for a known and an unknown address alike, and audits which it was', async () => {
    resets.request.mockResolvedValue({ known: true, sent: true });
    await expect(
      controller.request({ email: 'dana@example.com' }, req('/auth/password-reset/request')),
    ).resolves.toEqual({
      sent: true,
    });
    resets.request.mockResolvedValue({ known: false, sent: false });
    await expect(
      controller.request({ email: 'who@example.com' }, req('/auth/password-reset/request')),
    ).resolves.toEqual({
      sent: true,
    });
    expect(auditService.logInfo).toHaveBeenLastCalledWith(
      AuditAction.USER_PASSWORD_RESET_REQUESTED,
      expect.objectContaining({
        ipAddress: '203.0.113.7',
        metadata: { email: 'who@example.com', known: false, sent: false },
      }),
    );
  });

  it('a confirmation audits the reset with the user, and a refusal as a warning that names the address', async () => {
    resets.confirm.mockResolvedValue({ id: 'u1', email: 'dana@example.com' });
    const body = { email: 'dana@example.com', code: '048213', password: 'new password here' };
    await expect(controller.confirm(body, req('/auth/password-reset/confirm'))).resolves.toEqual({ reset: true });
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_PASSWORD_RESET,
      expect.objectContaining({ metadata: { userId: 'u1', email: 'dana@example.com' } }),
    );

    resets.confirm.mockRejectedValue(new BadRequestException(INVALID_RESET_CODE));
    await expect(controller.confirm(body, req('/auth/password-reset/confirm'))).rejects.toThrow(BadRequestException);
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.USER_PASSWORD_RESET_FAILED,
      expect.objectContaining({ metadata: { email: 'dana@example.com' }, errorMessage: INVALID_RESET_CODE }),
    );
  });
});
