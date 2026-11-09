import { Injectable } from '@nestjs/common';
import type { User } from './entities/user.entity';
import type { ArvyLink } from './arvy-client';
import { createLogger } from '../../common/services/logger.service';

/** The CRM endpoint the Scalorus sites send mail through; the same call the PHP side makes. */
export const EMAIL_DEFAULT_API_URL = 'https://crm.qadralabs.com/api/send-email';
export const EMAIL_DEFAULT_FROM = 'Scalorus';
export const EMAIL_DEFAULT_SMTP_ID = 4;
/** Where the emails send the customer: the site, and the dashboard under it. */
export const SIGNUP_DEFAULT_SITE_URL = 'https://wa.scalorus.com';
const TIMEOUT_MS = 15_000;

export interface EmailConfig {
  /** Unset disables sending: every send is skipped and logged, never failed. */
  apiKey: string | undefined;
  apiUrl: string;
  from: string;
  fromName: string;
  smtpId: number;
  /** An address told about each subscription that became active (the account now awaits approval). */
  notifyTo: string | undefined;
  siteUrl: string;
}

const trimmed = (value: string | undefined): string | undefined => value?.trim() || undefined;

/**
 * Read the mail settings from the environment. `EMAIL_API_KEY` turns sending on; the rest default to
 * what the PHP sites use, and `BASE_URL` (the gateway's public URL) is where the emails link to.
 */
export function resolveEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const smtpId = Number(trimmed(env.EMAIL_SMTP_ID));
  return {
    apiKey: trimmed(env.EMAIL_API_KEY),
    apiUrl: trimmed(env.EMAIL_API_URL) ?? EMAIL_DEFAULT_API_URL,
    from: trimmed(env.EMAIL_FROM) ?? EMAIL_DEFAULT_FROM,
    fromName: trimmed(env.EMAIL_FROM_NAME) ?? EMAIL_DEFAULT_FROM,
    smtpId: Number.isInteger(smtpId) && smtpId > 0 ? smtpId : EMAIL_DEFAULT_SMTP_ID,
    notifyTo: trimmed(env.SIGNUP_NOTIFY_EMAIL),
    siteUrl: (trimmed(env.BASE_URL) ?? SIGNUP_DEFAULT_SITE_URL).replace(/\/+$/, ''),
  };
}

/** The request body the CRM expects: the fields the PHP helper sends, under the same names. */
export interface EmailPayload {
  api_key: string;
  subject: string;
  content: string;
  recipients: string;
  from: string;
  from_name: string;
  smtp_id: number;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const money = (amount: number, currency: string, locale: string): string => {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
};

/** One email, Hebrew first then English, since the site serves both. */
function bilingual(he: string, en: string, siteUrl: string): string {
  const footer = `<p style="color:#6b7280;font-size:12px;margin-top:24px">Scalorus WA · <a href="${siteUrl}">${siteUrl.replace(/^https?:\/\//, '')}</a></p>`;
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111827">` +
    `<div dir="rtl" style="text-align:right">${he}</div>` +
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">` +
    `<div dir="ltr" style="text-align:left">${en}</div>${footer}</div>`
  );
}

export interface SignupEmail {
  subject: string;
  html: string;
}

/** The email a sign-up gets at once: the account exists, and here is the payment page to finish on. */
export function registeredEmail(
  user: Pick<User, 'email'>,
  link: Pick<ArvyLink, 'payment_link' | 'amount' | 'currency_code' | 'sto_payments_number'>,
  siteUrl: string,
  name?: string,
): SignupEmail {
  const who = name ? escapeHtml(name) : undefined;
  const email = escapeHtml(user.email);
  const pay = escapeHtml(link.payment_link);
  const total = link.amount * link.sto_payments_number;
  const he =
    `<p>שלום${who ? ` ${who}` : ''},</p>` +
    `<p>ההרשמה ל‑Scalorus WA התקבלה עבור <strong dir="ltr">${email}</strong>.</p>` +
    `<p>החשבון יופעל לאחר שמירת אמצעי התשלום: ${money(link.amount, link.currency_code, 'he-IL')} × ${link.sto_payments_number} חודשים ` +
    `(סה"כ ${money(total, link.currency_code, 'he-IL')}).</p>` +
    `<p><a href="${pay}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">לעמוד התשלום</a></p>` +
    `<p>לאחר התשלום החשבון ממתין לאישור מנהל; נעדכן אתכם במייל כשהוא יאושר.</p>`;
  const en =
    `<p>Hello${who ? ` ${who}` : ''},</p>` +
    `<p>Your Scalorus WA registration for <strong>${email}</strong> was received.</p>` +
    `<p>The account is activated once a payment method is saved: ${money(link.amount, link.currency_code, 'en-US')} × ${link.sto_payments_number} months ` +
    `(${money(total, link.currency_code, 'en-US')} in total).</p>` +
    `<p><a href="${pay}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open the payment page</a></p>` +
    `<p>After payment the account awaits an administrator's approval; we will email you when it is approved.</p>`;
  return { subject: 'Scalorus WA — ההרשמה התקבלה / Registration received', html: bilingual(he, en, siteUrl) };
}

/** The email a sign-up gets once its card is saved and the subscription is active. */
export function subscriptionActiveEmail(user: Pick<User, 'email'>, siteUrl: string): SignupEmail {
  const email = escapeHtml(user.email);
  const app = `${siteUrl}/app`;
  const he =
    `<p>שלום,</p>` +
    `<p>אמצעי התשלום נשמר והמנוי של <strong dir="ltr">${email}</strong> ב‑Scalorus WA פעיל.</p>` +
    `<p>החשבון ממתין כעת לאישור מנהל. אפשר להתחבר ללוח הבקרה ולעקוב אחרי הסטטוס; הוא ייפתח אוטומטית עם האישור.</p>` +
    `<p><a href="${app}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">ללוח הבקרה</a></p>`;
  const en =
    `<p>Hello,</p>` +
    `<p>Your payment method was saved and the Scalorus WA subscription for <strong>${email}</strong> is active.</p>` +
    `<p>The account now awaits an administrator's approval. You can sign in to the dashboard and follow its status; it unlocks on its own once approved.</p>` +
    `<p><a href="${app}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open the dashboard</a></p>`;
  return { subject: 'Scalorus WA — המנוי הופעל / Subscription active', html: bilingual(he, en, siteUrl) };
}

/** The note an operator gets when a subscription became active and the account awaits approval. */
export function adminSubscriptionEmail(user: Pick<User, 'email' | 'id'>, siteUrl: string): SignupEmail {
  const email = escapeHtml(user.email);
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111827">` +
    `<p>A Scalorus WA subscription became active and the account awaits approval:</p>` +
    `<p><strong>${email}</strong> (user ${escapeHtml(user.id)})</p>` +
    `<p><a href="${siteUrl}/app/users">Open the Users page to approve it</a></p></div>`;
  return { subject: `Scalorus WA — new subscription awaiting approval: ${user.email}`, html };
}

/** The code a password reset emails: typed back into the dashboard within `minutes`. */
export function passwordResetEmail(
  user: Pick<User, 'email'>,
  code: string,
  minutes: number,
  siteUrl: string,
): SignupEmail {
  const email = escapeHtml(user.email);
  const digits = escapeHtml(code);
  const box = `<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:12px 0" dir="ltr">${digits}</p>`;
  const he =
    `<p>שלום,</p>` +
    `<p>התבקש איפוס סיסמה ללוח הבקרה של Scalorus WA עבור <strong dir="ltr">${email}</strong>. הקוד שלכם:</p>${box}` +
    `<p>הקוד תקף ל‑${minutes} דקות. אם לא ביקשתם איפוס, אפשר להתעלם מהודעה זו; הסיסמה לא תשתנה.</p>`;
  const en =
    `<p>Hello,</p>` +
    `<p>A password reset was requested for the Scalorus WA dashboard account <strong>${email}</strong>. Your code:</p>${box}` +
    `<p>It is valid for ${minutes} minutes. If you did not ask for a reset, ignore this email; the password stays as it is.</p>`;
  return { subject: `Scalorus WA — קוד לאיפוס סיסמה / Password reset code: ${code}`, html: bilingual(he, en, siteUrl) };
}

/**
 * Transactional mail for the sign-up flow, sent through the Scalorus CRM like the PHP sites do.
 * Every send is best-effort: it runs after the request's work is done, never throws, and logs a
 * refusal or timeout, because a registration or an activation must not fail over mail.
 */
@Injectable()
export class EmailService {
  private readonly logger = createLogger('SignupEmail');
  private readonly config: EmailConfig;

  constructor() {
    this.config = resolveEmailConfig();
  }

  /** For tests: a service with explicit settings. */
  static withConfig(config: EmailConfig): EmailService {
    const service = new EmailService();
    (service as unknown as { config: EmailConfig }).config = config;
    return service;
  }

  get enabled(): boolean {
    return this.config.apiKey !== undefined;
  }

  get siteUrl(): string {
    return this.config.siteUrl;
  }

  /** Fire-and-forget: the caller never waits on mail. */
  sendRegistered(user: Pick<User, 'email'>, link: ArvyLink, name?: string): void {
    const mail = registeredEmail(user, link, this.config.siteUrl, name);
    void this.send(user.email, mail, 'registered');
  }

  /** Fire-and-forget: the customer, and the operator address when one is configured. */
  sendSubscriptionActive(user: Pick<User, 'email' | 'id'>): void {
    void this.send(user.email, subscriptionActiveEmail(user, this.config.siteUrl), 'subscription_active');
    if (this.config.notifyTo) {
      void this.send(
        this.config.notifyTo,
        adminSubscriptionEmail(user, this.config.siteUrl),
        'subscription_active_admin',
      );
    }
  }

  /** The reset code is awaited: the request answers only once the mail was accepted or refused. */
  sendPasswordReset(user: Pick<User, 'email'>, code: string, minutes: number): Promise<boolean> {
    return this.send(user.email, passwordResetEmail(user, code, minutes, this.config.siteUrl), 'password_reset');
  }

  /** POST one email; true when the CRM accepted it. Never throws. */
  async send(to: string, mail: SignupEmail, kind: string): Promise<boolean> {
    if (!this.config.apiKey) {
      this.logger.debug(`Email not sent (EMAIL_API_KEY unset): ${kind}`, { to, kind });
      return false;
    }
    const payload: EmailPayload = {
      api_key: this.config.apiKey,
      subject: mail.subject,
      content: mail.html,
      recipients: to,
      from: this.config.from,
      from_name: this.config.fromName,
      smtp_id: this.config.smtpId,
    };
    try {
      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.error('Email API error', {
          kind,
          to,
          status: response.status,
          body: (await response.text().catch(() => '')).slice(0, 500),
        });
        return false;
      }
      this.logger.log(`Email sent: ${kind}`, { to, kind, action: 'email_sent' });
      return true;
    } catch (error) {
      this.logger.error('Email API exception', {
        kind,
        to,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
