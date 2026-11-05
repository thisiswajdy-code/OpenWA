import 'reflect-metadata';
import { AuthValidateController } from './auth-validate.controller';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { PENDING_APPROVAL_ALLOWED_KEY } from './decorators/auth.decorators';
import { EngineFactory } from '../../engine/engine.factory';
import type { AuthService } from './auth.service';

describe('AuthValidateController', () => {
  const engineFactory = { getCurrentEngine: () => 'baileys' } as unknown as EngineFactory;
  const isPendingApproval = jest.fn().mockResolvedValue(false);
  const controller = new AuthValidateController(engineFactory, { isPendingApproval } as unknown as AuthService);

  const makeKey = (over: Partial<ApiKey> = {}): ApiKey =>
    ({ id: 'k1', role: ApiKeyRole.OPERATOR, isActive: true, allowedIps: null, userId: null, ...over }) as ApiKey;

  beforeEach(() => {
    isPendingApproval.mockResolvedValue(false);
  });

  it('reports the guard-validated key as valid, echoing its role and the running engine', async () => {
    await expect(controller.validate(makeKey({ role: ApiKeyRole.ADMIN }))).resolves.toEqual({
      valid: true,
      role: ApiKeyRole.ADMIN,
      engineType: 'baileys',
      scoped: false,
      pendingApproval: false,
    });
  });

  it('reports a key restricted to selected sessions as scoped', async () => {
    // The dashboard gates the unscoped-only stats reads on this, so a scoped admin never sends them.
    await expect(
      controller.validate(makeKey({ role: ApiKeyRole.ADMIN, allowedSessions: ['s1'] })),
    ).resolves.toMatchObject({ valid: true, scoped: true });
    await expect(controller.validate(makeKey({ allowedSessions: [] }))).resolves.toMatchObject({ scoped: false });
  });

  it('reports the engine to an operator key, which cannot read the admin-only infra route', async () => {
    // The dashboard needs the engine to gate status compose and the Channels tab for every writer.
    await expect(controller.validate(makeKey({ role: ApiKeyRole.OPERATOR }))).resolves.toMatchObject({
      engineType: 'baileys',
    });
  });

  it('returns valid:true for an IP-restricted key (no IP-less re-validation false negative)', async () => {
    // The global guard already validated this key against the real client IP and attached it.
    // The handler must NOT re-validate without an IP, which previously fail-closed and wrongly
    // reported valid:false for any key carrying an allowedIps restriction.
    const key = makeKey({ allowedIps: ['10.0.0.0/24'] });
    await expect(controller.validate(key)).resolves.toEqual({
      valid: true,
      role: key.role,
      engineType: 'baileys',
      scoped: false,
      pendingApproval: false,
    });
  });

  it('reports the login key of a user awaiting approval as pending, and admits it to the route', async () => {
    // The dashboard re-validates its stored key on every page load, including the locked one a paid
    // sign-up sees: the route must answer (with the lock) rather than refuse it as the others do.
    isPendingApproval.mockResolvedValue(true);
    const key = makeKey({ userId: 'u1' });
    await expect(controller.validate(key)).resolves.toMatchObject({ valid: true, pendingApproval: true });
    expect(isPendingApproval).toHaveBeenCalledWith(key);
    expect(
      Reflect.getMetadata(
        PENDING_APPROVAL_ALLOWED_KEY,
        Object.getOwnPropertyDescriptor(AuthValidateController.prototype, 'validate')?.value as object,
      ),
    ).toBe(true);
  });

  it('returns valid:false when no key is attached (defense-in-depth)', async () => {
    await expect(controller.validate(undefined)).resolves.toEqual({ valid: false });
  });
});
