import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, RefreshCw } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useCurrentUserQuery } from '../hooks/queries';
import { useRole } from '../hooks/useRole';
import './PendingApproval.css';

/** How often the locked dashboard asks whether the admin has approved the account. */
export const PENDING_POLL_MS = 10_000;

/**
 * What a paid sign-up sees until an admin approves it: the dashboard chrome, and this lock in place
 * of every page. The gateway refuses the login key everywhere but `GET /auth/me`, validate and
 * logout, so there is nothing else to draw; the page polls `me` and unlocks itself on approval,
 * without a second sign-in (the gateway re-reads the user on every request).
 */
export function PendingApproval() {
  const { t } = useTranslation();
  const { setPendingApproval } = useRole();
  useDocumentTitle(t('pending.title'));
  const { data, error, isFetching, refetch } = useCurrentUserQuery(PENDING_POLL_MS);

  useEffect(() => {
    if (data && !data.pendingApproval) setPendingApproval(false);
  }, [data, setPendingApproval]);

  return (
    <div className="pending-page">
      <section className="pending-card" role="status" aria-live="polite">
        <div className="pending-icon">
          <Lock size={28} />
        </div>
        <h1>{t('pending.title')}</h1>
        <p>{t('pending.body')}</p>
        {data && <p className="pending-account">{t('pending.signedInAs', { email: data.email })}</p>}
        {error && <p className="pending-error">{t('pending.loadFailed')}</p>}
        <button type="button" className="btn-secondary" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
          {t('pending.check')}
        </button>
      </section>
    </div>
  );
}
