// FAQ accordion on the homepage. External because the gateway's CSP allows only same-origin scripts.
document.querySelectorAll('[data-faq]').forEach(function (b) {
  b.addEventListener('click', function () {
    var p = b.nextElementSibling;
    var o = p.classList.toggle('open');
    b.querySelector('svg').style.transform = o ? 'rotate(45deg)' : '';
  });
});
