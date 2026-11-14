(() => {
  const $ = selector => document.querySelector(selector);
  const manager = $('#managerPanel');
  const locked = $('#lockedPanel');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const message = $('#message');
  const clientUrl = `${location.origin}/v1`;
  $('#clientUrl').textContent = clientUrl;
  $('#codeUrl').textContent = clientUrl;
  const params = new URLSearchParams(location.hash.slice(1));
  const adminToken = params.get('manage') || '';
  let keys = [];
  let busy = false;

  function status(connected) {
    statusDot.classList.toggle('good', connected);
    statusText.textContent = connected ? 'Connected' : 'Private';
  }
  function say(text, kind = '') { message.textContent = text; message.className = `message ${kind}`; }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${adminToken}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, cache: 'no-store', credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status})`);
    return payload;
  }
  function renderKeys() {
    $('#keyCount').textContent = `${keys.length} key${keys.length === 1 ? '' : 's'}`;
    const root = $('#keys');
    if (!keys.length) { root.innerHTML = '<div class="empty">No keys yet</div>'; return; }
    root.innerHTML = keys.map((key, index) => `<div class="key-row" data-id="${key.id}"><div><div class="key-name">Key ${index + 1}</div><div class="key-meta">${key.configured ? 'Encrypted' : 'Not configured'}</div></div><div class="key-actions"><span class="key-status ${key.status === 'cooldown' ? 'cooldown' : ''}">${key.status === 'cooldown' ? 'Cooldown' : 'Ready'}</span><button class="remove" type="button" data-remove="${key.id}">Remove</button></div></div>`).join('');
  }
  async function load() {
    try {
      const data = await api('/admin/settings');
      $('#baseUrl').value = data.baseUrl;
      keys = data.keys || [];
      renderKeys();
      manager.hidden = false;
      locked.hidden = true;
      status(true);
    } catch (error) {
      manager.hidden = true;
      locked.hidden = false;
      status(false);
      if (adminToken) $('#lockMessage').textContent = error.message;
    }
  }
  $('#saveBase').addEventListener('click', async () => {
    if (busy) return;
    busy = true; $('#saveBase').disabled = true; say('Saving…');
    try { const result = await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ baseUrl: $('#baseUrl').value.trim() }) }); $('#baseUrl').value = result.baseUrl; say('Saved.', 'success'); }
    catch (error) { say(error.message, 'error'); }
    finally { busy = false; $('#saveBase').disabled = false; }
  });
  $('#addKey').addEventListener('click', async () => {
    if (busy) return;
    const field = $('#newKey'); const apiKey = field.value.trim();
    if (!apiKey) { say('Enter an API key.', 'error'); return; }
    busy = true; $('#addKey').disabled = true; say('Adding key…');
    try { await api('/admin/keys', { method: 'POST', body: JSON.stringify({ apiKey }) }); field.value = ''; await load(); say('Key added.', 'success'); }
    catch (error) { say(error.message, 'error'); }
    finally { busy = false; $('#addKey').disabled = false; }
  });
  $('#keys').addEventListener('click', async event => {
    const button = event.target.closest('[data-remove]'); if (!button || busy) return;
    busy = true; button.disabled = true; say('Removing…');
    try { await api(`/admin/keys/${encodeURIComponent(button.dataset.remove)}`, { method: 'DELETE' }); await load(); say('Key removed.', 'success'); }
    catch (error) { say(error.message, 'error'); }
    finally { busy = false; }
  });
  $('#copyUrl').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(clientUrl); $('#copyUrl').textContent = 'Copied'; setTimeout(() => { $('#copyUrl').textContent = 'Copy'; }, 1300); }
    catch { $('#copyUrl').textContent = 'Select URL'; }
  });
  if (!adminToken) { locked.hidden = false; status(false); }
  else load();
})();
