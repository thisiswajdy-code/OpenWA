import { BadGatewayException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SIGNUP_PLAN, SignupService, todayInIsrael } from './signup.service';
import {
  ArvyApiError,
  ArvyClient,
  arvyOrigin,
  resolveArvyConfig,
  type ArvyCreateLinkRequest,
  type ArvyLink,
} from './arvy-client';
import { ApiKeyRole } from './entities/api-key.entity';
import type { User } from './entities/user.entity';
import type { RegisterDto } from './dto';

const link = (overrides: Partial<ArvyLink> = {}): ArvyLink => ({
  id: 42,
  status: 'pending_card',
  payment_link: 'https://arvy.store/billing/setup/uuid',
  amount: 30,
  currency_code: 'USD',
  description: SIGNUP_PLAN.description,
  charge_frequency: 'monthly',
  sto_payments_number: 12,
  first_charge_date: '2026-11-04',
  charges_completed: 0,
  ...overrides,
});

const dto: RegisterDto = {
  email: 'dana@example.com',
  password: 'correct horse battery staple',
  name: 'Dana',
  locale: 'he',
};

function makeService(arvy: Partial<ArvyClient>, users: Partial<User>[] = []) {
  const rows = users.map(u => ({ id: 'u1', isActive: false, paymentLinkId: null, ...u }) as User);
  const repository = {
    exists: jest.fn(({ where }: { where: Partial<User> }) =>
      Promise.resolve(rows.some(r => (where.email ? r.email === where.email : false))),
    ),
    create: jest.fn((fields: Partial<User>) => ({ id: 'new-user', ...fields }) as User),
    save: jest.fn((user: User) => Promise.resolve(user)),
    update: jest.fn(() => Promise.resolve()),
    delete: jest.fn(() => Promise.resolve()),
    findOne: jest.fn(({ where }: { where: Partial<User> }) =>
      Promise.resolve(rows.find(r => r.id === where.id) ?? null),
    ),
  };
  const service = new SignupService(repository as never, { enabled: true, ...arvy } as ArvyClient);
  return { service, repository };
}

describe('todayInIsrael', () => {
  it('formats the date as the payment API expects, in Israel time', () => {
    // 23:30 UTC on the 3rd is already the 4th in Israel (UTC+2); a UTC date would be refused as past.
    expect(todayInIsrael(new Date('2026-11-03T23:30:00Z'))).toBe('2026-11-04');
    expect(todayInIsrael(new Date('2026-06-15T12:00:00Z'))).toBe('2026-06-15');
  });
});

describe('SIGNUP_PLAN', () => {
  it('sells twelve monthly charges of USD 30, falling back to ILS 95', () => {
    expect(SIGNUP_PLAN.paymentsNumber).toBe(12);
    expect(SIGNUP_PLAN.chargeFrequency).toBe('monthly');
    expect(SIGNUP_PLAN.prices).toEqual([
      { currencyCode: 'USD', amount: 30 },
      { currencyCode: 'ILS', amount: 95 },
    ]);
  });
});

describe('SignupService.register', () => {
  it('creates an inactive operator and a USD link when the API accepts USD', async () => {
    const createLink = jest.fn<Promise<ArvyLink>, [ArvyCreateLinkRequest]>(() => Promise.resolve(link()));
    const { service, repository } = makeService({ createLink });
    const result = await service.register(dto);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: dto.email, role: ApiKeyRole.OPERATOR, isActive: false }),
    );
    expect(createLink).toHaveBeenCalledTimes(1);
    expect(createLink.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        amount: 30,
        currency_code: 'USD',
        charge_frequency: 'monthly',
        sto_payments_number: 12,
        customer_email: dto.email,
        customer_name: 'Dana',
        locale: 'he',
        first_charge_date: todayInIsrael(),
      }),
    );
    expect(repository.update).toHaveBeenCalledWith('new-user', { paymentLinkId: '42' });
    expect(result.user.paymentLinkId).toBe('42');
    expect(result.link.payment_link).toBe('https://arvy.store/billing/setup/uuid');
  });

  it('retries in ILS at 95 when the API refuses USD with a 422, and remembers that', async () => {
    const createLink = jest
      .fn<Promise<ArvyLink>, [{ currency_code?: string }]>()
      .mockRejectedValueOnce(new ArvyApiError(422, { errors: { currency_code: ['unsupported'] } }))
      .mockImplementation(body => Promise.resolve(link({ currency_code: body.currency_code, amount: 95 })));
    const { service } = makeService({ createLink });
    const first = await service.register(dto);
    expect(first.link.currency_code).toBe('ILS');
    expect(createLink).toHaveBeenCalledTimes(2);
    expect(createLink.mock.calls[1][0]).toEqual(expect.objectContaining({ amount: 95, currency_code: 'ILS' }));

    await service.register({ ...dto, email: 'other@example.com' });
    // The refusal is remembered: the second sign-up goes straight to ILS.
    expect(createLink).toHaveBeenCalledTimes(3);
    expect(createLink.mock.calls[2][0]).toEqual(expect.objectContaining({ currency_code: 'ILS' }));
  });

  it('deletes the user and answers 502 when the API refuses every currency', async () => {
    const createLink = jest.fn().mockRejectedValue(new ArvyApiError(422, { errors: { first_charge_date: ['past'] } }));
    const { service, repository } = makeService({ createLink });
    await expect(service.register(dto)).rejects.toBeInstanceOf(BadGatewayException);
    expect(createLink).toHaveBeenCalledTimes(2);
    expect(repository.delete).toHaveBeenCalledWith('new-user');
  });

  it('does not retry a non-422 failure, and still frees the email', async () => {
    const createLink = jest.fn().mockRejectedValue(new ArvyApiError(401, null));
    const { service, repository } = makeService({ createLink });
    await expect(service.register(dto)).rejects.toBeInstanceOf(BadGatewayException);
    expect(createLink).toHaveBeenCalledTimes(1);
    expect(repository.delete).toHaveBeenCalledWith('new-user');
  });

  it('refuses an email that already has a user before calling the API', async () => {
    const createLink = jest.fn();
    const { service } = makeService({ createLink }, [{ id: 'u1', email: dto.email }]);
    await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(createLink).not.toHaveBeenCalled();
  });

  it('answers 503 when no token is configured', async () => {
    const { service, repository } = makeService({ enabled: false });
    await expect(service.register(dto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('SignupService.status', () => {
  it('activates the user the first time the link reports a saved card', async () => {
    const getLink = jest.fn(() => Promise.resolve(link({ status: 'active' })));
    const { service, repository } = makeService({ getLink }, [{ id: 'u1', email: dto.email, paymentLinkId: '42' }]);
    const first = await service.status('u1');
    expect(getLink).toHaveBeenCalledWith('42');
    expect(first.activated).toBe(true);
    expect(first.user.isActive).toBe(true);
    expect(repository.update).toHaveBeenCalledWith('u1', { isActive: true });

    const second = await service.status('u1');
    expect(second.activated).toBe(false);
    expect(repository.update).toHaveBeenCalledTimes(1);
  });

  it('leaves the user inactive while the card is pending or the link is cancelled', async () => {
    for (const status of ['pending_card', 'cancelled'] as const) {
      const { service, repository } = makeService({ getLink: () => Promise.resolve(link({ status })) }, [
        { id: 'u1', email: dto.email, paymentLinkId: '42' },
      ]);
      const result = await service.status('u1');
      expect(result.activated).toBe(false);
      expect(result.user.isActive).toBe(false);
      expect(repository.update).not.toHaveBeenCalled();
    }
  });

  it('404s an unknown id and a user without a payment link', async () => {
    const { service } = makeService({ getLink: () => Promise.resolve(link()) }, [{ id: 'u1', email: dto.email }]);
    await expect(service.status('u1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.status('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 502 when the API cannot be reached', async () => {
    const { service } = makeService({ getLink: () => Promise.reject(new Error('timeout')) }, [
      { id: 'u1', email: dto.email, paymentLinkId: '42' },
    ]);
    await expect(service.status('u1')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('Arvy configuration', () => {
  it('is enabled only with a token, defaults the base URL, and strips a trailing slash', () => {
    expect(resolveArvyConfig({})).toEqual({ token: undefined, baseUrl: 'https://arvy.store/api/v1' });
    expect(resolveArvyConfig({ ARVY_API_TOKEN: ' t ', ARVY_API_URL: 'https://pay.example.com/api/v1/' })).toEqual({
      token: 't',
      baseUrl: 'https://pay.example.com/api/v1',
    });
    expect(ArvyClient.withConfig(resolveArvyConfig({})).enabled).toBe(false);
    expect(ArvyClient.withConfig(resolveArvyConfig({ ARVY_API_TOKEN: 't' })).enabled).toBe(true);
  });

  it('derives the payment page origin for the site CSP from the API base', () => {
    expect(arvyOrigin({ baseUrl: 'https://arvy.store/api/v1' })).toBe('https://arvy.store');
  });
});

describe('ArvyClient.request', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends the bearer token and JSON, and wraps a non-2xx answer with its parsed body', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, text: () => Promise.resolve(JSON.stringify(link())) })
      .mockResolvedValueOnce({ ok: false, status: 422, text: () => Promise.resolve('{"errors":{"amount":["min"]}}') });
    global.fetch = fetchMock;
    const client = ArvyClient.withConfig({ token: 'secret', baseUrl: 'https://arvy.store/api/v1' });
    const created = await client.createLink({
      amount: 30,
      charge_frequency: 'monthly',
      description: 'x',
      first_charge_date: '2026-11-04',
      sto_payments_number: 12,
    });
    expect(created.id).toBe(42);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://arvy.store/api/v1/recurring-payment-links');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body as string)).toEqual(expect.objectContaining({ amount: 30 }));

    await expect(client.getLink('42')).rejects.toMatchObject({ status: 422, body: { errors: { amount: ['min'] } } });
  });
});
