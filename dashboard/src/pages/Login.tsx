import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { API_BASE_URL } from '../services/api';
import './Login.css';

/** How the user signed in; the app keeps it beside the key so logout knows whether to end a password session. */
export type LoginMethod = 'apiKey' | 'password';

interface LoginProps {
  onLogin: (apiKey: string, role?: string, engineType?: string, scoped?: boolean, method?: LoginMethod) => void;
}

/** The sign-in answer the two methods share: a key to store, and what the gateway said about it. */
interface SignedIn {
  key: string;
  role?: string;
  engineType?: string;
  scoped: boolean;
}

export function Login({ onLogin }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [apiKey, setApiKey] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  // Whether the gateway has a dashboard user to sign in; null until it has answered. The email form is
  // the default only on an install that can use it, so a fresh install still lands on the key form.
  const [passwordAvailable, setPasswordAvailable] = useState<boolean | null>(null);
  const [chosen, setChosen] = useState<LoginMethod | null>(null);
  const method: LoginMethod = chosen ?? (passwordAvailable ? 'password' : 'apiKey');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE_URL}/auth/login-options`)
      .then(async res => {
        if (!res.ok) return;
        const data: { password?: unknown } = await res.json().catch(() => ({}));
        if (!cancelled) setPasswordAvailable(data.password === true);
      })
      .catch(() => {
        // A gateway that cannot be reached is reported when the user submits, not here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const switchMethod = (next: LoginMethod) => {
    setChosen(next);
    setError('');
    setShowSecret(false);
  };

  // A 5xx, or a body that is not the gateway's JSON (a proxy error page while it restarts), says
  // nothing about the credential; a refusal keeps the gateway's reason (expired, revoked, rate limited).
  const refusalMessage = async (response: Response, fallback: string): Promise<string> => {
    if (response.status === 429) return t('login.tooManyAttempts');
    const errorData: { message?: unknown } = await response.json().catch(() => ({}));
    const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
    return reason || fallback;
  };

  const signInWithKey = async (): Promise<SignedIn | string> => {
    // The stored key is matched against key prefixes elsewhere, so a pasted space must not reach it.
    const key = apiKey.trim();
    const response = await fetch(`${API_BASE_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    });
    if (!response.ok) {
      return refusalMessage(response, t(response.status === 401 ? 'login.invalidKey' : 'login.connectionError'));
    }
    // The validate body already carries the key's role — hand it up so the app can set it
    // directly instead of re-validating the same key a second time.
    const data: { role?: string; engineType?: string; scoped?: unknown } = await response.json().catch(() => ({}));
    return {
      key,
      role: data.role,
      engineType: typeof data.engineType === 'string' ? data.engineType : undefined,
      scoped: data.scoped === true,
    };
  };

  const signInWithPassword = async (): Promise<SignedIn | string> => {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    if (!response.ok) {
      // The gateway answers every refusal with one message, so the dashboard shows its own.
      if (response.status === 401) return t('login.invalidCredentials');
      return refusalMessage(response, t('login.connectionError'));
    }
    const data: { apiKey?: unknown; role?: string; engineType?: string; scoped?: unknown } = await response
      .json()
      .catch(() => ({}));
    if (typeof data.apiKey !== 'string' || !data.apiKey) return t('login.connectionError');
    return {
      key: data.apiKey,
      role: data.role,
      engineType: typeof data.engineType === 'string' ? data.engineType : undefined,
      scoped: data.scoped === true,
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (method === 'apiKey' && !apiKey.trim()) {
      setError(t('login.apiKeyRequired'));
      return;
    }
    if (method === 'password' && !email.trim()) {
      setError(t('login.emailRequired'));
      return;
    }
    if (method === 'password' && !password) {
      setError(t('login.passwordRequired'));
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const result = method === 'password' ? await signInWithPassword() : await signInWithKey();
      if (typeof result === 'string') {
        setError(result);
      } else {
        onLogin(result.key, result.role, result.engineType, result.scoped, method);
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  const secretToggle = (shown: string, hidden: string) => (
    <button
      type="button"
      className="toggle-visibility"
      onClick={() => setShowSecret(!showSecret)}
      aria-label={showSecret ? hidden : shown}
    >
      {showSecret ? <EyeOff size={20} /> : <Eye size={20} />}
    </button>
  );

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/scalorus-wa-logo.svg" alt="Scalorus WA" className="logo-icon" />
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              // ISO date (YYYYMMDD) so the format is stable across locales/regions instead of the
              // locale-dependent toLocaleDateString() which renders differently per browser region.
              date: new Date(__BUILD_TIME__).toISOString().slice(0, 10).replace(/-/g, ''),
            })}
          </span>
        </div>

        <div className="login-language">
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {method === 'password' ? (
            <>
              <div className="input-group">
                <label htmlFor="email">{t('login.email')}</label>
                <div className="input-wrapper">
                  <input
                    id="email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder={t('login.emailPlaceholder')}
                    className={error ? 'error' : ''}
                  />
                </div>
              </div>
              <div className="input-group">
                <label htmlFor="password">{t('common.password')}</label>
                <div className="input-wrapper">
                  <input
                    id="password"
                    type={showSecret ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('login.passwordPlaceholder')}
                    className={error ? 'error' : ''}
                  />
                  {secretToggle(t('common.showPassword'), t('common.hidePassword'))}
                </div>
                {error && <span className="error-message">{error}</span>}
              </div>
            </>
          ) : (
            <div className="input-group">
              <label htmlFor="apiKey">{t('login.apiKey')}</label>
              <div className="input-wrapper">
                <input
                  id="apiKey"
                  type={showSecret ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={t('login.apiKeyPlaceholder')}
                  className={error ? 'error' : ''}
                />
                {secretToggle(t('common.showApiKey'), t('common.hideApiKey'))}
              </div>
              {error && <span className="error-message">{error}</span>}
            </div>
          )}

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {method === 'password'
              ? isLoading
                ? t('login.signingIn')
                : t('login.signIn')
              : isLoading
                ? t('login.connecting')
                : t('login.connect')}
          </button>

          {method === 'password' ? (
            <button type="button" className="login-switch" onClick={() => switchMethod('apiKey')}>
              {t('login.useApiKey')}
            </button>
          ) : (
            passwordAvailable && (
              <button type="button" className="login-switch" onClick={() => switchMethod('password')}>
                {t('login.usePassword')}
              </button>
            )
          )}
        </form>

        <p className="login-help">
          {t('login.help')}{' '}
          <a href="https://wa.scalorus.com" target="_blank" rel="noopener noreferrer">
            {t('login.viewDocs')}
          </a>
        </p>
      </div>{' '}
    </div>
  );
}
