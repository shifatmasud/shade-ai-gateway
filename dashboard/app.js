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
  let clientApiKey = '';
  let busy = false;

  function status(connected) {
    statusDot.classList.toggle('good', connected);
    statusText.textContent = connected ? 'Connected' : 'Private';
  }
  function say(text, kind = '') { message.textContent = text; message.className = `message ${kind}`; }
  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function surfaceButton(label, tone = 'light', extraClass = '', attributes = '') {
    const text = escapeHTML(label);
    const kind = tone === 'dark' ? 'cta' : 'sound';
    const classes = `surface-button surface-button--${tone}${extraClass ? ` ${extraClass}` : ''}`;
    const copy = `<span class="surface-button__label ink-par"><span class="ir"><span class="ir-a">${text}</span><span class="ir-b" aria-hidden="true">${text}</span></span></span>`;
    return `<button type="button" class="${classes}" data-surface-button data-ink-kind="${kind}" ${attributes}>${copy}<span class="ink" aria-hidden="true">${copy}</span></button>`;
  }
  function setButtonLabel(button, label) {
    if (!button) return;
    button.querySelectorAll('.ir-a, .ir-b').forEach(node => { node.textContent = label; });
  }
  function applyClientKey(value) {
    clientApiKey = typeof value === 'string' && value.length >= 32 ? value : '';
    const field = $('#clientApiKey');
    const configured = Boolean(clientApiKey);
    field.value = clientApiKey;
    field.type = 'password';
    field.placeholder = configured ? '' : 'GATEWAY_API_KEY is not configured';
    $('#clientKeyStatus').textContent = configured ? 'CONFIGURED' : 'NOT CONFIGURED';
    $('#toggleClientKey').disabled = !configured;
    $('#copyClientKey').disabled = !configured;
    $('#toggleClientKey').setAttribute('aria-pressed', 'false');
    setButtonLabel($('#toggleClientKey'), 'Show');
    setButtonLabel($('#copyClientKey'), 'Copy key');
  }
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
    root.innerHTML = keys.map((key, index) => {
      const id = escapeHTML(key.id);
      const state = key.status === 'cooldown' ? 'Cooldown' : 'Ready';
      return `<div class="key-row" data-id="${id}"><div><div class="key-name">Key ${index + 1}</div><div class="key-meta">${key.configured ? 'Encrypted' : 'Not configured'}</div></div><div class="key-actions"><span class="key-status ${key.status === 'cooldown' ? 'cooldown' : ''}">${state}</span>${surfaceButton('Remove', 'light', ' surface-button--compact remove', `data-remove="${id}"`)}</div></div>`;
    }).join('');
  }
  async function load() {
    try {
      const data = await api('/admin/settings');
      $('#baseUrl').value = data.baseUrl;
      applyClientKey(data.clientApiKey);
      keys = data.keys || [];
      renderKeys();
      manager.hidden = false;
      locked.hidden = true;
      status(true);
    } catch (error) {
      applyClientKey('');
      manager.hidden = true;
      locked.hidden = false;
      status(false);
      if (adminToken) $('#lockMessage').textContent = error.message;
    }
  }

  $('#toggleClientKey').addEventListener('click', () => {
    if (!clientApiKey) return;
    const field = $('#clientApiKey');
    const revealed = field.type === 'password';
    field.type = revealed ? 'text' : 'password';
    $('#toggleClientKey').setAttribute('aria-pressed', String(revealed));
    setButtonLabel($('#toggleClientKey'), revealed ? 'Hide' : 'Show');
  });
  $('#copyClientKey').addEventListener('click', async () => {
    if (!clientApiKey) return;
    const button = $('#copyClientKey');
    try {
      await navigator.clipboard.writeText(clientApiKey);
      setButtonLabel(button, 'Copied');
      say('Shade client API key copied.', 'success');
      setTimeout(() => setButtonLabel(button, 'Copy key'), 1300);
    } catch {
      say('Clipboard access is unavailable. Reveal the key and copy it manually.', 'error');
    }
  });
  $('#saveBase').addEventListener('click', async () => {
    if (busy) return;
    busy = true; $('#saveBase').disabled = true; say('Saving…');
    try {
      const result = await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ baseUrl: $('#baseUrl').value.trim() }) });
      $('#baseUrl').value = result.baseUrl;
      say('Saved.', 'success');
    } catch (error) { say(error.message, 'error'); }
    finally { busy = false; $('#saveBase').disabled = false; }
  });
  $('#addKey').addEventListener('click', async () => {
    if (busy) return;
    const field = $('#newKey'); const apiKey = field.value.trim();
    if (!apiKey) { say('Enter an API key.', 'error'); return; }
    busy = true; $('#addKey').disabled = true; say('Adding key…');
    try {
      await api('/admin/keys', { method: 'POST', body: JSON.stringify({ apiKey }) });
      field.value = ''; await load(); say('Key added.', 'success');
    } catch (error) { say(error.message, 'error'); }
    finally { busy = false; $('#addKey').disabled = false; }
  });
  $('#keys').addEventListener('click', async event => {
    const button = event.target.closest('[data-remove]'); if (!button || busy) return;
    busy = true; button.disabled = true; say('Removing…');
    try {
      await api(`/admin/keys/${encodeURIComponent(button.dataset.remove)}`, { method: 'DELETE' });
      await load(); say('Key removed.', 'success');
    } catch (error) { say(error.message, 'error'); }
    finally { busy = false; }
  });
  $('#copyUrl').addEventListener('click', async () => {
    const button = $('#copyUrl');
    try {
      await navigator.clipboard.writeText(clientUrl);
      setButtonLabel(button, 'Copied');
      setTimeout(() => setButtonLabel(button, 'Copy'), 1300);
    } catch { setButtonLabel(button, 'Select URL'); }
  });
  if (!adminToken) { locked.hidden = false; status(false); }
  else load();
})();
