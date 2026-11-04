import 'reflect-metadata';
import type { Request } from 'express';
import { SignupController } from './signup.controller';
import { PUBLIC_KEY } from './decorators/auth.decorators';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { ArvyLink } from './arvy-client';
import type { User } from './entities/user.entity';

const handler = (controller: object, name: string): object =>
  Object.getOwnPropertyDescriptor(controller, name)?.value as object;

describe('SignupController — route markers', () => {
  it.each(['register', 'status'] as const)('%s is public: a visitor has no key yet', name => {
    expect(Reflect.getMetadata(PUBLIC_KEY, handler(SignupController.prototype, name))).toBe(true);
  });

  it('register is throttled as tightly as sign-in, per tier name', () => {
    const limit = (tier: string): unknown =>
      Reflect.getMetadata(`THROTTLER:LIMIT${tier}`, handler(SignupController.prototype, 'register'));
    expect(limit('short')).toBe(5);
    expect(limit('medium')).toBe(20);
    expect(limit('long')).toBe(100);
  });
});

describe('SignupController — responses and audit trail', () => {
  const req = {
    method: 'POST',
    path: '/auth/register',
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Request;
  const user = { id: 'u1', email: 'dana@example.com', role: 'operator', isActive: false, paymentLinkId: '42' } as User;
  const link: ArvyLink = {
    id: 42,
    status: 'pending_card',
    payment_link: 'https://arvy.store/billing/setup/uuid',
    amount: 30,
    currency_code: 'USD',
    description: 'Scalorus WA — 12 months',
    charge_frequency: 'monthly',
    sto_payments_number: 12,
    first_charge_date: '2026-11-04',
    source_id: 1,
    reference: 'u1',
    source_notified_at: null,
    charges_completed: 0,
  };
  let signupService: { register: jest.Mock; status: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SignupController;

  beforeEach(() => {
    signupService = { register: jest.fn(), status: jest.fn() };
    auditService = { logInfo: jest.fn().mockResolvedValue(null) };
    controller = new SignupController(signupService as never, auditService as never, { get: () => [] } as never);
  });

  it('answers the payment link and the plan, and audits the self-registration as a user creation', async () => {
    signupService.register.mockResolvedValue({ user, link });
    const result = await controller.register({ email: user.email, password: 'correct horse battery staple' }, req);
    expect(result).toEqual({
      id: 'u1',
      email: 'dana@example.com',
      paymentLink: link.payment_link,
      amount: 30,
      currencyCode: 'USD',
      chargeFrequency: 'monthly',
      paymentsNumber: 12,
      status: 'pending_card',
      active: false,
    });
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_CREATED,
      expect.objectContaining({
        ipAddress: '203.0.113.7',
        metadata: expect.objectContaining({ targetUserId: 'u1', selfRegistered: true, paymentLinkId: '42' }) as unknown,
      }),
    );
  });

  it('audits the activation once, when the status call flips the user active', async () => {
    signupService.status
      .mockResolvedValueOnce({
        user: { ...user, isActive: true },
        link: { ...link, status: 'active' },
        activated: true,
      })
      .mockResolvedValueOnce({
        user: { ...user, isActive: true },
        link: { ...link, status: 'active' },
        activated: false,
      });
    const first = await controller.status('u1', req);
    expect(first.active).toBe(true);
    expect(first.status).toBe('active');
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_UPDATED,
      expect.objectContaining({
        metadata: expect.objectContaining({ activatedByPayment: true, targetUserId: 'u1' }) as unknown,
      }),
    );
    await controller.status('u1', req);
    expect(auditService.logInfo).toHaveBeenCalledTimes(1);
  });
});
