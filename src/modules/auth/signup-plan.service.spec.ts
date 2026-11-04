import 'reflect-metadata';
import {
  DEFAULT_SIGNUP_PLAN,
  SIGNUP_PLAN_KEY,
  SignupPlanService,
  normalizeSignupPlan,
  type SignupPlan,
} from './signup-plan.service';
import { SignupPlanController, toSignupPlanResponse } from './signup-plan.controller';
import { REQUIRED_ROLE_KEY, UNSCOPED_KEY } from './decorators/auth.decorators';
import { ApiKeyRole } from './entities/api-key.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';

describe('normalizeSignupPlan', () => {
  it('returns the default for nothing, junk, or an empty object', () => {
    expect(normalizeSignupPlan(null)).toEqual(DEFAULT_SIGNUP_PLAN);
    expect(normalizeSignupPlan('x')).toEqual(DEFAULT_SIGNUP_PLAN);
    expect(normalizeSignupPlan({})).toEqual(DEFAULT_SIGNUP_PLAN);
  });

  it('keeps valid fields and replaces each invalid one on its own', () => {
    expect(
      normalizeSignupPlan({
        description: '  Yearly  ',
        amount: 12.5,
        currencyCode: 'EUR',
        paymentsNumber: 24,
        fallbackAmountIls: null,
      }),
    ).toEqual({
      description: 'Yearly',
      amount: 12.5,
      currencyCode: 'EUR',
      paymentsNumber: 24,
      chargeFrequency: 'monthly',
      fallbackAmountIls: null,
    });
    expect(
      normalizeSignupPlan({
        description: '',
        amount: -1,
        currencyCode: 'GBP',
        paymentsNumber: 1,
        fallbackAmountIls: 'x',
      }),
    ).toEqual({ ...DEFAULT_SIGNUP_PLAN, fallbackAmountIls: null });
  });
});

describe('SignupPlanService', () => {
  const makeService = (stored?: string) => {
    const rows = new Map<string, { key: string; value: string }>();
    if (stored !== undefined) rows.set(SIGNUP_PLAN_KEY, { key: SIGNUP_PLAN_KEY, value: stored });
    const repository = {
      findOne: jest.fn(({ where }: { where: { key: string } }) => Promise.resolve(rows.get(where.key) ?? null)),
      create: jest.fn((row: { key: string; value: string }) => row),
      save: jest.fn((row: { key: string; value: string }) => {
        rows.set(row.key, row);
        return Promise.resolve(row);
      }),
    };
    return { service: new SignupPlanService(repository as never), repository, rows };
  };

  it('answers the default until a plan is saved, reading the row once', async () => {
    const { service, repository } = makeService();
    expect(await service.get()).toEqual(DEFAULT_SIGNUP_PLAN);
    expect(await service.get()).toEqual(DEFAULT_SIGNUP_PLAN);
    expect(repository.findOne).toHaveBeenCalledTimes(1);
  });

  it('reads a stored plan back, and falls back to the default when the row is not JSON', async () => {
    const stored: SignupPlan = { ...DEFAULT_SIGNUP_PLAN, amount: 25, currencyCode: 'ILS', fallbackAmountIls: null };
    expect(await makeService(JSON.stringify(stored)).service.get()).toEqual(stored);
    expect(await makeService('{not json').service.get()).toEqual(DEFAULT_SIGNUP_PLAN);
  });

  it('saves a normalized plan under the setting key and serves it from then on', async () => {
    const { service, rows } = makeService();
    const saved = await service.update({ ...DEFAULT_SIGNUP_PLAN, amount: 45, description: ' Pro ' });
    expect(saved).toEqual({ ...DEFAULT_SIGNUP_PLAN, amount: 45, description: 'Pro' });
    expect(JSON.parse(rows.get(SIGNUP_PLAN_KEY)?.value ?? '{}')).toEqual(saved);
    expect(await service.get()).toEqual(saved);
  });
});

describe('SignupPlanController', () => {
  it('is fenced like user management: an unscoped ADMIN key', () => {
    expect(Reflect.getMetadata(UNSCOPED_KEY, SignupPlanController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, SignupPlanController)).toBe(ApiKeyRole.ADMIN);
  });

  it('adds the total and whether sign-up is enabled to the plan', () => {
    expect(toSignupPlanResponse({ ...DEFAULT_SIGNUP_PLAN, amount: 10.5, paymentsNumber: 3 }, false)).toEqual(
      expect.objectContaining({ total: 31.5, enabled: false, amount: 10.5 }),
    );
  });

  it('saves the plan, forgets refused currencies and audits the change with before and after', async () => {
    const plans = {
      get: jest.fn(() => Promise.resolve(DEFAULT_SIGNUP_PLAN)),
      update: jest.fn((plan: SignupPlan) => Promise.resolve(plan)),
    };
    const signupService = { enabled: true, forgetRefusals: jest.fn() };
    const auditService = { logInfo: jest.fn().mockResolvedValue(null) };
    const controller = new SignupPlanController(plans as never, signupService as never, auditService as never);
    const result = await controller.update(
      { description: 'Pro', amount: 50, currencyCode: 'USD', paymentsNumber: 12, fallbackAmountIls: undefined },
      { method: 'PUT', path: '/auth/signup-plan' } as never,
      { id: 'key-1' } as never,
    );
    expect(result).toEqual(
      expect.objectContaining({ amount: 50, description: 'Pro', fallbackAmountIls: null, total: 600, enabled: true }),
    );
    expect(signupService.forgetRefusals).toHaveBeenCalledTimes(1);
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.SIGNUP_PLAN_UPDATED,
      expect.objectContaining({
        metadata: expect.objectContaining({
          before: DEFAULT_SIGNUP_PLAN,
          after: expect.objectContaining({ amount: 50 }) as unknown,
        }) as unknown,
      }),
    );
  });
});
