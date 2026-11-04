// Sign-up flow for the Scalorus WA site: choose an account, create the dashboard user, then save a
// card on the payment page the gateway created for it. External because the gateway's CSP allows
// only same-origin scripts. Strings come from the page (data-* attributes), so one script serves
// both languages.
(function () {
  var API = '/api/auth/register';
  var STORE = 'scalorus_signup';
  var POLL_MS = 5000;
  var page = document.getElementById('signup');
  var lang = document.documentElement.lang || 'en';
  var text = function (key) {
    return page.getAttribute('data-' + key) || '';
  };

  var steps = ['account', 'register', 'pay'];
  function show(step) {
    steps.forEach(function (name, i) {
      document.getElementById('step-' + name).classList.toggle('active', name === step);
      var marker = document.querySelector('.su-steps [data-step="' + name + '"]');
      if (marker) marker.classList.toggle('active', steps.indexOf(step) >= i);
    });
    window.scrollTo({ top: 0 });
  }

  // Step 1: choose an account.
  var chosen = null;
  var accounts = document.querySelectorAll('.su-account[role="radio"]');
  accounts.forEach(function (card) {
    card.addEventListener('click', function () {
      accounts.forEach(function (c) {
        c.setAttribute('aria-checked', String(c === card));
      });
      chosen = card.getAttribute('data-account');
      document.getElementById('account-next').disabled = false;
    });
  });
  document.getElementById('account-next').addEventListener('click', function () {
    if (chosen === 'custom') {
      window.location.href = 'mailto:hello@scalorus.ai?subject=Scalorus%20WA';
      return;
    }
    if (chosen) show('register');
  });
  document.getElementById('register-back').addEventListener('click', function () {
    show('account');
  });

  // Step 2: create the user. The gateway answers with the payment link for the chosen account.
  var form = document.getElementById('register-form');
  var error = document.getElementById('register-error');
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    error.textContent = '';
    var button = form.querySelector('button[type="submit"]');
    var body = {
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      password: form.elements.password.value,
      locale: lang,
    };
    if (!body.name) delete body.name;
    if (body.password.length < 8) {
      error.textContent = text('err-password');
      return;
    }
    button.disabled = true;
    try {
      var res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        error.textContent =
          res.status === 409
            ? text('err-exists')
            : res.status === 429
              ? text('err-rate')
              : res.status === 503
                ? text('err-disabled')
                : res.status === 400 && typeof data.message === 'string'
                  ? data.message
                  : Array.isArray(data.message)
                    ? data.message.join(' ')
                    : text('err-generic');
        return;
      }
      sessionStorage.setItem(STORE, JSON.stringify(data));
      startPayment(data);
    } catch (e) {
      error.textContent = text('err-generic');
    } finally {
      button.disabled = false;
    }
  });

  // Step 3: the payment page in an iframe, polled until the card is saved and the user is active.
  var pollTimer = null;
  function money(amount, currency) {
    try {
      return new Intl.NumberFormat(lang === 'he' ? 'he-IL' : 'en-US', { style: 'currency', currency: currency }).format(
        amount,
      );
    } catch (e) {
      return amount + ' ' + currency;
    }
  }
  function startPayment(signup) {
    show('pay');
    var frame = document.getElementById('pay-frame');
    if (frame.src !== signup.paymentLink) frame.src = signup.paymentLink;
    document.getElementById('pay-open').href = signup.paymentLink;
    document.getElementById('pay-email').textContent = signup.email;
    document.getElementById('pay-amount').textContent =
      money(signup.amount, signup.currencyCode) + ' × ' + signup.paymentsNumber;
    document.getElementById('pay-total').textContent = money(signup.amount * signup.paymentsNumber, signup.currencyCode);
    applyStatus(signup.status, signup.active);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      poll(signup.id);
    }, POLL_MS);
  }
  async function poll(id) {
    try {
      var res = await fetch(API + '/' + encodeURIComponent(id));
      if (!res.ok) return;
      var data = await res.json();
      applyStatus(data.status, data.active);
      if (data.active) clearInterval(pollTimer);
    } catch (e) {
      // Offline for a moment: the next tick asks again.
    }
  }
  function applyStatus(status, active) {
    var line = document.getElementById('pay-status');
    var label = document.getElementById('pay-status-text');
    var done = document.getElementById('pay-done');
    var pending = document.getElementById('pay-pending');
    if (active) {
      line.classList.add('done');
      label.textContent = text('status-active');
      done.hidden = false;
      pending.hidden = true;
      sessionStorage.removeItem(STORE);
      return;
    }
    label.textContent = status === 'cancelled' ? text('status-cancelled') : text('status-pending');
  }

  // A reload during payment lands back on the payment step.
  var saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
  } catch (e) {
    saved = null;
  }
  if (saved && saved.id && saved.paymentLink) {
    startPayment(saved);
  } else {
    show('account');
  }
})();
