window.auth.host(host => document.getElementById('host').textContent = host);
document.getElementById('auth').onsubmit = event => {
  event.preventDefault();
  window.auth.submit(document.getElementById('username').value, document.getElementById('password').value);
  document.getElementById('password').value = '';
};
document.getElementById('cancel').onclick = () => window.auth.cancel();
