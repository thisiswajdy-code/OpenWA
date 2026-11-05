import {
  EMAIL_DEFAULT_API_URL,
  EMAIL_DEFAULT_SMTP_ID,
  SIGNUP_DEFAULT_SITE_URL,
  SignupEmailService,
  adminSubscriptionEmail,
  registeredEmail,
  resolveEmailConfig,
  subscriptionActiveEmail,
  type EmailConfig,
  type EmailPayload,
} from './signup-email.service';
import type { ArvyLink } from './arvy-client';

const config = (over: Partial<EmailConfig> = {}): EmailConfig => ({
  apiKey: 'crm-key',
  apiUrl: 'https://crm.example.test/api/send-email',
  from: 'Scalorus',
  fromName: 'Scalorus',
  smtpId: 4,
  notifyTo: undefined,
  siteUrl: 'https://wa.example.test',
  ...over,
});

const link = {
  payment_link: 'https://arvy.store/billing/setup/uuid',
  amount: 30,
  currency_code: 'USD',
  sto_payments_number: 12,
} as ArvyLink;

describe('resolveEmailConfig', () => {
  it('is off without EMAIL_API_KEY and defaults the rest to what the PHP sites send', () => {
    const resolved = resolveEmailConfig({});
    expect(resolved).toEqual({
      apiKey: undefined,
      apiUrl: EMAIL_DEFAULT_API_URL,
      from: 'Scalorus',
      fromName: 'Scalorus',
      smtpId: EMAIL_DEFAULT_SMTP_ID,
      notifyTo: undefined,
      siteUrl: SIGNUP_DEFAULT_SITE_URL,
    });
    expect(SignupEmailService.withConfig(resolved).enabled).toBe(false);
  });

  it('reads every override, trims blanks to unset, and strips the site URL trailing slash', () => {
    expect(
      resolveEmailConfig({
        EMAIL_API_KEY: ' k ',
        EMAIL_API_URL: 'https://crm.example.test/send',
        EMAIL_FROM: 'WA',
        EMAIL_FROM_NAME: 'Scalorus WA',
        EMAIL_SMTP_ID: '7',
        SIGNUP_NOTIFY_EMAIL: 'ops@example.test',
        BASE_URL: 'https://wa.example.test/',
      }),
    ).toEqual({
      apiKey: 'k',
      apiUrl: 'https://crm.example.test/send',
      from: 'WA',
      fromName: 'Scalorus WA',
      smtpId: 7,
      notifyTo: 'ops@example.test',
      siteUrl: 'https://wa.example.test',
    });
    expect(resolveEmailConfig({ EMAIL_API_KEY: '  ', EMAIL_SMTP_ID: 'four' })).toMatchObject({
      apiKey: undefined,
      smtpId: EMAIL_DEFAULT_SMTP_ID,
    });
  });
});

describe('the emails', () => {
  it('the registration mail names the address, the price and the payment page, in Hebrew and English', () => {
    const mail = registeredEmail({ email: 'dana@example.com' }, link, 'https://wa.example.test', 'Dana <b>');
    expect(mail.subject).toContain('Registration received');
    expect(mail.html).toContain('dana@example.com');
    expect(mail.html).toContain(link.payment_link);
    expect(mail.html).toContain('× 12');
    expect(mail.html).toContain('$360.00');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toContain('Hello Dana &lt;b&gt;');
    expect(mail.html).not.toContain('<b>');
  });

  it('the activation mail sends the customer to the dashboard and says approval is next', () => {
    const mail = subscriptionActiveEmail({ email: 'dana@example.com' }, 'https://wa.example.test');
    expect(mail.subject).toContain('Subscription active');
    expect(mail.html).toContain('https://wa.example.test/app');
    expect(mail.html).toContain('approval');
  });

  it('the operator note links the Users page', () => {
    const mail = adminSubscriptionEmail({ email: 'dana@example.com', id: 'u1' }, 'https://wa.example.test');
    expect(mail.subject).toContain('dana@example.com');
    expect(mail.html).toContain('https://wa.example.test/app/users');
  });
});

describe('SignupEmailService', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  const okResponse = () => ({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}') });
  /** The JSON body of one recorded fetch call. */
  const bodyOf = (call: unknown[]): EmailPayload => JSON.parse((call[1] as { body: string }).body) as EmailPayload;

  it('posts the fields the PHP helper sends, under the same names, with a single recipient', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const service = SignupEmailService.withConfig(config());
    await expect(service.send('dana@example.com', { subject: 'S', html: '<p>H</p>' }, 'test')).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://crm.example.test/api/send-email');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(bodyOf(fetchMock.mock.calls[0] as unknown[])).toEqual({
      api_key: 'crm-key',
      subject: 'S',
      content: '<p>H</p>',
      recipients: 'dana@example.com',
      from: 'Scalorus',
      from_name: 'Scalorus',
      smtp_id: 4,
    });
  });

  it('sends nothing without an API key', async () => {
    const service = SignupEmailService.withConfig(config({ apiKey: undefined }));
    await expect(service.send('dana@example.com', { subject: 'S', html: 'H' }, 'test')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a refusal or an exception as false, and never throws', async () => {
    const service = SignupEmailService.withConfig(config());
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve('bad') });
    await expect(service.send('dana@example.com', { subject: 'S', html: 'H' }, 'test')).resolves.toBe(false);
    fetchMock.mockRejectedValue(new Error('timeout'));
    await expect(service.send('dana@example.com', { subject: 'S', html: 'H' }, 'test')).resolves.toBe(false);
  });

  it('the activation mail goes to the customer, and to the operator address when one is set', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const recipients = () => fetchMock.mock.calls.map(call => bodyOf(call as unknown[]).recipients);

    SignupEmailService.withConfig(config()).sendSubscriptionActive({ email: 'dana@example.com', id: 'u1' });
    await new Promise(resolve => setImmediate(resolve));
    expect(recipients()).toEqual(['dana@example.com']);

    fetchMock.mockClear();
    SignupEmailService.withConfig(config({ notifyTo: 'ops@example.test' })).sendSubscriptionActive({
      email: 'dana@example.com',
      id: 'u1',
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(recipients().sort()).toEqual(['dana@example.com', 'ops@example.test']);
  });

  it('the registration mail goes to the new address with the payment link', async () => {
    fetchMock.mockResolvedValue(okResponse());
    SignupEmailService.withConfig(config()).sendRegistered({ email: 'dana@example.com' }, link, 'Dana');
    await new Promise(resolve => setImmediate(resolve));
    const payload = bodyOf(fetchMock.mock.calls[0] as unknown[]);
    expect(payload.recipients).toBe('dana@example.com');
    expect(payload.content).toContain(link.payment_link);
    expect(payload.content).toContain('Dana');
  });
});
