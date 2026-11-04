import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ArvyNotifyController } from './arvy-notify.controller';
import { ArvyClient } from './arvy-client';
import { PUBLIC_KEY } from './decorators/auth.decorators';
import { AuditAction } from '../audit/entities/audit-log.entity';

const SECRET = 'ZycW-test-secret';
const ACTIVE = JSON.stringify({
  event: 'recurring_payment.active',
  sent_at: '2026-11-10T09:12:00+00:00',
  source: { id: 1, name: 'Scalorus WA' },
  recurring_payment: { id: 42, status: 'active', reference: 'u1', amount: 30, currency_code: 'USD' },
});
const sign = (raw: string, key = SECRET) => `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;
const request = (raw: string): Request & { rawBody?: Buffer } =>
  ({
    method: 'POST',
    path: '/notify',
    socket: { remoteAddress: '203.0.113.7' },
    rawBody: Buffer.from(raw),
  }) as unknown as Request & { rawBody?: Buffer };

describe('ArvyNotifyController', () => {
  let signupService: { activateFromNotification: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  const build = (secret?: string) =>
    new ArvyNotifyController(
      signupService as never,
      ArvyClient.withConfig({ baseUrl: 'https://arvy.store/api/v1', sourceId: 1, sourceSecret: secret }),
      auditService as never,
      { get: () => [] } as never,
    );

  beforeEach(() => {
    signupService = { activateFromNotification: jest.fn() };
    auditService = { logInfo: jest.fn().mockResolvedValue(null) };
  });

  it('is public: the payment service holds no API key, only the source secret', () => {
    const handler = Object.getOwnPropertyDescriptor(ArvyNotifyController.prototype, 'notify')?.value as object;
    expect(Reflect.getMetadata(PUBLIC_KEY, handler)).toBe(true);
  });

  it('answers 503 until a source secret is configured, before reading the body', async () => {
    await expect(build(undefined).notify(request(ACTIVE), sign(ACTIVE))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(signupService.activateFromNotification).not.toHaveBeenCalled();
  });

  it('refuses a missing, wrong or re-keyed signature with 401', async () => {
    const controller = build(SECRET);
    await expect(controller.notify(request(ACTIVE), undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.notify(request(ACTIVE), sign(ACTIVE, 'other'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Signed bytes differ from the delivered bytes (a proxy re-serialised the body).
    await expect(controller.notify(request(ACTIVE + '\n'), sign(ACTIVE))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(signupService.activateFromNotification).not.toHaveBeenCalled();
  });

  it('400s a signed body that is not a notification', async () => {
    const raw = '{"hello":"world"}';
    await expect(build(SECRET).notify(request(raw), sign(raw))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('activates the user from a signed active notification and audits it', async () => {
    signupService.activateFromNotification.mockResolvedValue({
      user: { id: 'u1', email: 'dana@example.com' },
      activated: true,
      ignored: false,
    });
    const result = await build(SECRET).notify(request(ACTIVE), sign(ACTIVE));
    expect(result).toEqual({ received: true, event: 'recurring_payment.active', activated: true, ignored: false });
    expect(signupService.activateFromNotification).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recurring_payment.active' }),
    );
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_UPDATED,
      expect.objectContaining({
        ipAddress: '203.0.113.7',
        metadata: expect.objectContaining({
          targetUserId: 'u1',
          activatedByPayment: true,
          paymentLinkId: '42',
        }) as unknown,
      }),
    );
  });

  it('acknowledges an already-active user and an ignored event without auditing', async () => {
    signupService.activateFromNotification
      .mockResolvedValueOnce({ user: { id: 'u1' }, activated: false, ignored: false })
      .mockResolvedValueOnce({ user: null, activated: false, ignored: true });
    const controller = build(SECRET);
    expect((await controller.notify(request(ACTIVE), sign(ACTIVE))).activated).toBe(false);
    const other = ACTIVE.replace('recurring_payment.active', 'recurring_payment.renewed');
    expect(await controller.notify(request(other), sign(other))).toEqual(
      expect.objectContaining({ ignored: true, activated: false }),
    );
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });

  it('acknowledges a signed one-time-link notification with 200 rather than refusing it', async () => {
    signupService.activateFromNotification.mockResolvedValue({ user: null, activated: false, ignored: true });
    const paid = JSON.stringify({
      event: 'payment_link.paid',
      source: { id: 1, name: 'Scalorus WA' },
      payment_link: { id: 7, status: 'paid', reference: 'inv-17', amount: 250, currency_code: 'ILS' },
    });
    expect(await build(SECRET).notify(request(paid), sign(paid))).toEqual({
      received: true,
      event: 'payment_link.paid',
      activated: false,
      ignored: true,
    });
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });

  it('lets a 404 from the service through, so the payment service can resend later', async () => {
    signupService.activateFromNotification.mockRejectedValue(new NotFoundException('nope'));
    await expect(build(SECRET).notify(request(ACTIVE), sign(ACTIVE))).rejects.toBeInstanceOf(NotFoundException);
  });
});
