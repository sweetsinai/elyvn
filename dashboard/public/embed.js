/**
 * ELYVN Embed — paste this on any website to capture leads.
 *
 * Usage:
 *   <form id="elyvn-form">
 *     <input name="name" placeholder="Name" required>
 *     <input name="phone" placeholder="Phone" required>
 *     <textarea name="message" placeholder="How can we help?"></textarea>
 *     <button type="submit">Send</button>
 *   </form>
 *   <script src="https://joyful-trust-production.up.railway.app/embed.js"
 *           data-client-id="YOUR_CLIENT_ID"></script>
 */
(function () {
  var script = document.currentScript;
  var clientId = script && script.getAttribute('data-client-id');
  var baseUrl = script && script.src.replace('/embed.js', '') || 'https://joyful-trust-production.up.railway.app';
  var form = document.getElementById('elyvn-form');

  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {};
    var inputs = form.querySelectorAll('input, textarea, select');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].name) data[inputs[i].name] = inputs[i].value;
    }
    if (clientId) data.client_id = clientId;

    fetch(baseUrl + '/webhooks/form' + (clientId ? '/' + clientId : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(function () {});

    var btn = form.querySelector('button[type="submit"]');
    if (btn) {
      btn.textContent = 'Sent!';
      btn.disabled = true;
      setTimeout(function () { btn.textContent = 'Send'; btn.disabled = false; }, 3000);
    }

    form.reset();
  });
})();
