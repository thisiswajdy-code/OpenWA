// Shows the sign-up plan the gateway is configured with (GET /api/auth/register/plan) in place of
// the prices written into the HTML, which stay as the fallback when the gateway cannot be reached.
// Elements: [data-plan-amount] gets the monthly amount; [data-plan-template] gets its template with
// {amount}, {months} and {total} filled in.
(function () {
  var lang = document.documentElement.lang || 'en';
  function money(amount, currency) {
    try {
      return new Intl.NumberFormat(lang === 'he' ? 'he-IL' : 'en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch (e) {
      return amount + ' ' + currency;
    }
  }
  fetch('/api/auth/register/plan')
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .then(function (plan) {
      if (!plan || typeof plan.amount !== 'number') return;
      var values = {
        amount: money(plan.amount, plan.currencyCode),
        months: String(plan.paymentsNumber),
        total: money(plan.total, plan.currencyCode),
      };
      document.querySelectorAll('[data-plan-amount]').forEach(function (el) {
        el.textContent = values.amount;
      });
      document.querySelectorAll('[data-plan-template]').forEach(function (el) {
        el.textContent = el.getAttribute('data-plan-template').replace(/\{(amount|months|total)\}/g, function (_, k) {
          return values[k];
        });
      });
      window.scalorusPlan = plan;
    })
    .catch(function () {
      // The HTML keeps its written prices.
    });
})();
