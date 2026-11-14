(() => {
  const root = document.querySelector('#providers');
  const count = document.querySelector('#count');
  const message = document.querySelector('#message');
  const connectionText = document.querySelector('#connectionText');
  const dot = document.querySelector('#dot');
  let providers = [];
  let adminSecret = '';
  let busy = false;
  let nextLocalId = 1;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }
  function setMessage(text, kind = '') {
    message.textContent = text;
    message.className = `message ${kind}`;
  }
  function setConnected(connected) {
    dot.className = `dot${connected ? ' good' : ''}`;
    connectionText.textContent = connected ? 'Connected securely' : 'Locked';
  }
  function promptForSecret() {
    let panel = document.querySelector('#unlockPanel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'unlockPanel';
      panel.style.cssText = 'margin:18px 0;padding:18px;border:1px solid #303644;border-radius:14px;background:#111318';
      panel.innerHTML = '<form id="unlockForm" style="display:grid;gap:10px;max-width:420px"><label for="adminPassword">ADMIN PASSWORD</label><input id="adminPassword" type="password" autocomplete="current-password" required placeholder="Enter admin password"><button class="btn primary" type="submit">Unlock manager</button></form>';
      message.insertAdjacentElement('afterend', panel);
      panel.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        const field = panel.querySelector('input');
        adminSecret = field.value;
        field.value = '';
        panel.hidden = true;
        await load();
      });
    }
    panel.hidden = false;
    panel.querySelector('input').focus();
    return false;
  }
  async function api(path, options = {}) {
    if (!adminSecret) {
      promptForSecret();
      throw new Error('Enter the admin password to unlock the manager.');
    }
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${adminSecret}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, cache: 'no-store', credentials: 'same-origin' });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      if (response.status === 401) {
        adminSecret = '';
        setConnected(false);
        promptForSecret();
      }
      throw new Error(payload?.error?.message || `Request failed (${response.status}).`);
    }
    setConnected(true);
    return payload;
  }
  function render() {
    count.textContent = `${providers.length} provider${providers.length === 1 ? '' : 's'}`;
    if (!providers.length) {
      root.innerHTML = '<div class="empty">No providers yet. Add one to connect your first AI service.</div>';
      return;
    }
    root.innerHTML = providers.map((provider, index) => {
      const id = escapeHtml(provider.localId);
      const status = provider.keyConfigured ? '<span class="key-state">Key saved</span>' : '';
      const keyPlaceholder = provider.keyConfigured ? 'Saved key — leave blank to keep it' : 'Paste provider API key';
      const saveLabel = provider.remoteId ? 'Save changes' : 'Save provider';
      return `<section class="provider" data-local-id="${id}">
        <div class="provider-head"><div><span class="provider-title">Provider ${index + 1}</span>${status}</div><button class="remove" type="button" data-action="remove">Remove</button></div>
        <div class="fields">
          <div class="field"><label for="name-${id}">PROVIDER NAME</label><input id="name-${id}" data-field="name" type="text" maxlength="80" autocomplete="off" placeholder="Google AI Studio" value="${escapeHtml(provider.name)}"></div>
          <div class="field"><label for="url-${id}">BASE URL</label><input id="url-${id}" data-field="baseUrl" type="url" maxlength="500" autocomplete="url" placeholder="https://api.example.com/v1" value="${escapeHtml(provider.baseUrl)}"></div>
          <div class="field full"><label for="key-${id}">API KEY</label><input id="key-${id}" data-field="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${keyPlaceholder}" value="${escapeHtml(provider.apiKey)}"></div>
        </div>
        <div class="row-actions"><span class="row-note">The page never receives a saved key.</span><button class="btn" type="button" data-action="save">${saveLabel}</button></div>
      </section>`;
    }).join('');
  }
  async function load() {
    try {
      const result = await api('/admin/providers');
      providers = (result.providers || []).map(provider => ({
        localId: `remote-${provider.id}`,
        remoteId: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: '',
        keyConfigured: Boolean(provider.keyConfigured)
      }));
      render();
      setMessage(providers.length ? 'Your saved provider list is ready.' : 'Add a provider to get started.');
    } catch (error) {
      setMessage(error.message, 'error');
      if (!adminSecret) setConnected(false);
    }
  }
  async function save(provider) {
    const key = provider.apiKey;
    if (!provider.name.trim() || !provider.baseUrl.trim() || (!provider.remoteId && !key.trim())) {
      setMessage('Fill in the provider name, base URL, and API key.', 'error');
      return;
    }
    busy = true;
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    setMessage('Saving securely…');
    try {
      const payload = { name: provider.name, baseUrl: provider.baseUrl, apiKey: key };
      const path = provider.remoteId ? `/admin/providers/${encodeURIComponent(provider.remoteId)}` : '/admin/providers';
      const result = await api(path, { method: provider.remoteId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      const returned = result.provider;
      provider.remoteId = returned.id;
      provider.localId = `remote-${returned.id}`;
      provider.name = returned.name;
      provider.baseUrl = returned.baseUrl;
      provider.apiKey = '';
      provider.keyConfigured = Boolean(returned.keyConfigured);
      render();
      setMessage('Saved. The provider key is encrypted on the server and was not returned to this page.', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      busy = false;
      document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  }
  root.addEventListener('input', event => {
    const card = event.target.closest('.provider');
    const field = event.target.dataset.field;
    if (!card || !field) return;
    const provider = providers.find(item => item.localId === card.dataset.localId);
    if (provider) provider[field] = event.target.value;
  });
  root.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || busy) return;
    const card = button.closest('.provider');
    const provider = providers.find(item => item.localId === card?.dataset.localId);
    if (!provider) return;
    if (button.dataset.action === 'save') return save(provider);
    if (button.dataset.action === 'remove') {
      if (!provider.remoteId) {
        providers = providers.filter(item => item !== provider);
        render();
        return;
      }
      if (!window.confirm(`Remove ${provider.name}? Its saved key will be deleted.`)) return;
      busy = true;
      button.disabled = true;
      try {
        await api(`/admin/providers/${encodeURIComponent(provider.remoteId)}`, { method: 'DELETE' });
        providers = providers.filter(item => item !== provider);
        render();
        setMessage('Provider and encrypted key removed.', 'success');
      } catch (error) {
        setMessage(error.message, 'error');
      } finally {
        busy = false;
        document.querySelectorAll('button').forEach(item => { item.disabled = false; });
      }
    }
  });
  document.querySelector('#add').addEventListener('click', () => {
    providers.push({ localId: `new-${nextLocalId++}`, remoteId: null, name: '', baseUrl: '', apiKey: '', keyConfigured: false });
    render();
    root.querySelector('.provider:last-child input')?.focus();
  });
  document.querySelector('#saveAll').addEventListener('click', async () => {
    for (const provider of [...providers]) {
      const card = root.querySelector(`[data-local-id="${CSS.escape(provider.localId)}"]`);
      if (!card) continue;
      const nameField = card.querySelector('[data-field="name"]');
      const urlField = card.querySelector('[data-field="baseUrl"]');
      const keyField = card.querySelector('[data-field="apiKey"]');
      provider.name = nameField.value;
      provider.baseUrl = urlField.value;
      provider.apiKey = keyField.value;
      if (!provider.remoteId || provider.apiKey || provider.name !== nameField.defaultValue || provider.baseUrl !== urlField.defaultValue) await save(provider);
    }
  });
  document.querySelector('#unlock').addEventListener('click', () => {
    adminSecret = '';
    promptForSecret();
  });
  load();
})();
