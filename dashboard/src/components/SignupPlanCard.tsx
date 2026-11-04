import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CreditCard, Loader2 } from 'lucide-react';
import type { SignupCurrency, SignupPlanInput } from '../services/api';
import { useSignupPlanQuery, useUpdateSignupPlanMutation } from '../hooks/queries';
import { useToast } from '../hooks/useToast';

const CURRENCIES: SignupCurrency[] = ['USD', 'ILS', 'EUR'];
const AMOUNT_MIN = 0.01;
const PAYMENTS_MIN = 2;
const PAYMENTS_MAX = 9999;
const DESCRIPTION_MAX = 255;

interface Draft {
  description: string;
  amount: string;
  currencyCode: SignupCurrency;
  paymentsNumber: string;
  fallbackAmountIls: string;
}

const money = (amount: number, currency: string, locale: string): string => {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
};

/**
 * The subscription a self-service sign-up on the site is charged: amount per month, currency,
 * number of months, the description shown on the payment page and the ILS fallback. Admin only,
 * like the users table it sits above.
 */
export function SignupPlanCard() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { data: plan, isLoading, error } = useSignupPlanQuery();
  const updateMutation = useUpdateSignupPlanMutation();
  const [draft, setDraft] = useState<Draft | null>(null);

  // The form starts from the saved plan, and is reset to it after each save.
  useEffect(() => {
    if (!plan) return;
    setDraft({
      description: plan.description,
      amount: String(plan.amount),
      currencyCode: plan.currencyCode,
      paymentsNumber: String(plan.paymentsNumber),
      fallbackAmountIls: plan.fallbackAmountIls === null ? '' : String(plan.fallbackAmountIls),
    });
  }, [plan]);

  if (isLoading) {
    return (
      <section className="signup-plan-card" aria-busy="true">
        <Loader2 className="animate-spin" size={20} />
      </section>
    );
  }
  if (error || !plan || !draft) {
    return (
      <section className="signup-plan-card" role="alert">
        <AlertCircle size={20} />
        <span>{t('users.plan.loadFailed')}</span>
      </section>
    );
  }

  const amount = Number(draft.amount);
  const paymentsNumber = Number(draft.paymentsNumber);
  const fallback = draft.fallbackAmountIls.trim() === '' ? null : Number(draft.fallbackAmountIls);
  const amountValid = Number.isFinite(amount) && amount >= AMOUNT_MIN;
  const paymentsValid =
    Number.isInteger(paymentsNumber) && paymentsNumber >= PAYMENTS_MIN && paymentsNumber <= PAYMENTS_MAX;
  const fallbackValid = fallback === null || (Number.isFinite(fallback) && fallback >= AMOUNT_MIN);
  const descriptionValid = draft.description.trim().length > 0 && draft.description.length <= DESCRIPTION_MAX;
  const valid = amountValid && paymentsValid && fallbackValid && descriptionValid;
  const dirty =
    draft.description !== plan.description ||
    amount !== plan.amount ||
    draft.currencyCode !== plan.currencyCode ||
    paymentsNumber !== plan.paymentsNumber ||
    fallback !== plan.fallbackAmountIls;
  const total = amountValid && paymentsValid ? Math.round(amount * paymentsNumber * 100) / 100 : null;
  const locale = i18n.resolvedLanguage || i18n.language;

  const save = async () => {
    const body: SignupPlanInput = {
      description: draft.description.trim(),
      amount,
      currencyCode: draft.currencyCode,
      paymentsNumber,
      fallbackAmountIls: draft.currencyCode === 'ILS' ? null : fallback,
    };
    try {
      await updateMutation.mutateAsync(body);
      toast.success(t('users.plan.title'), t('users.plan.saved'));
    } catch (err) {
      toast.error(t('users.plan.title'), err instanceof Error ? err.message : t('users.plan.saveFailed'));
    }
  };

  const busy = updateMutation.isPending;
  return (
    <section className="signup-plan-card" aria-labelledby="signup-plan-title">
      <div className="signup-plan-head">
        <CreditCard size={20} />
        <div>
          <h2 id="signup-plan-title">{t('users.plan.title')}</h2>
          <p>{t('users.plan.subtitle')}</p>
        </div>
      </div>
      {!plan.enabled && <p className="signup-plan-disabled">{t('users.plan.disabledHint')}</p>}
      <form
        className="signup-plan-form"
        onSubmit={e => {
          e.preventDefault();
          if (valid && dirty && !busy) void save();
        }}
      >
        <label htmlFor="signup-plan-amount">
          {t('users.plan.amount')}
          <input
            id="signup-plan-amount"
            type="number"
            inputMode="decimal"
            min={AMOUNT_MIN}
            step="0.01"
            value={draft.amount}
            disabled={busy}
            onChange={e => setDraft({ ...draft, amount: e.target.value })}
          />
        </label>
        <label htmlFor="signup-plan-currency">
          {t('users.plan.currency')}
          <select
            id="signup-plan-currency"
            value={draft.currencyCode}
            disabled={busy}
            onChange={e => setDraft({ ...draft, currencyCode: e.target.value as SignupCurrency })}
          >
            {CURRENCIES.map(code => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="signup-plan-months">
          {t('users.plan.months')}
          <input
            id="signup-plan-months"
            type="number"
            inputMode="numeric"
            min={PAYMENTS_MIN}
            max={PAYMENTS_MAX}
            step="1"
            value={draft.paymentsNumber}
            disabled={busy}
            onChange={e => setDraft({ ...draft, paymentsNumber: e.target.value })}
          />
        </label>
        <label htmlFor="signup-plan-fallback">
          {t('users.plan.fallback')}
          <input
            id="signup-plan-fallback"
            type="number"
            inputMode="decimal"
            min={AMOUNT_MIN}
            step="0.01"
            value={draft.fallbackAmountIls}
            disabled={busy || draft.currencyCode === 'ILS'}
            onChange={e => setDraft({ ...draft, fallbackAmountIls: e.target.value })}
          />
        </label>
        <label htmlFor="signup-plan-description" className="signup-plan-wide">
          {t('users.plan.description')}
          <input
            id="signup-plan-description"
            type="text"
            maxLength={DESCRIPTION_MAX}
            value={draft.description}
            disabled={busy}
            onChange={e => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
        <div className="signup-plan-footer">
          <span className="user-field-hint">
            {total !== null
              ? t('users.plan.total', { total: money(total, draft.currencyCode, locale), months: paymentsNumber })
              : t('users.plan.fallbackHint')}
          </span>
          <button type="submit" className="btn-primary" disabled={!valid || !dirty || busy}>
            {busy ? <Loader2 className="animate-spin" size={16} /> : t('users.plan.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
