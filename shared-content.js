/* global indexedDB */
(() => {
  'use strict';
  const API = '/.netlify/functions/site-';
  const clone = value => structuredClone(value);
  const imageKeys = new Set(['src', 'image', 'flyer']);
  let adapter, baseline, legacy, recovery, revision = null, session = {}, initialized = false;
  let dirty = false, busy = false, blocked = false, timer, editNumber = 0, backupWarning = '';
  const replacements = new Map();
  const element = id => document.getElementById(id);
  const status = text => { if (element('shared-save-status')) element('shared-save-status').textContent = text; };

  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ppd-shared-content', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('backups');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function backup(value) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('backups', value ? 'readwrite' : 'readonly');
        const store = transaction.objectStore('backups');
        const request = value ? store.put(value, 'draft') : store.get('draft');
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }
  function captureLegacy() {
    const data = {};
    for (const [name, key] of Object.entries({ memberData: 'ppdMemberData', liveData: 'ppdLiveData', albums: 'ppdAlbums' })) {
      try {
        const saved = localStorage.getItem(key);
        if (saved) data[name] = JSON.parse(saved);
      } catch { backupWarning = '以前の保存データの一部を読み込めません。元データは削除していません。'; }
    }
    return Object.keys(data).length ? data : null;
  }
  async function request(kind, options = {}) {
    const url = API + kind + (kind === 'content' && !options.method && session.authenticated ? '?editor=' + Date.now() : '');
    let response;
    try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(55000), ...options }); }
    catch { throw new Error('通信に失敗しました。接続を確認して再保存してください。'); }
    let value;
    try { value = await response.json(); } catch { throw new Error('サーバーに接続できません。'); }
    if (!response.ok) throw Object.assign(new Error(value.error || '保存に失敗しました。'), { status: response.status });
    return value;
  }
  const post = (kind, value) => request(kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  function enableEditor() {
    const enabled = session.authenticated && initialized;
    element('admin-tab-panels').disabled = !enabled;
    element('shared-import-button').disabled = !session.authenticated || busy;
    element('shared-import-file').disabled = !session.authenticated || busy;
    element('shared-retry-button').disabled = !enabled || blocked || busy;
  }
  function setData(data) {
    adapter.set(clone(data));
    adapter.refresh();
  }
  function download(value, filename) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function exportBackup() {
    download({ format: 'ppd-backup-v1', exportedAt: new Date().toISOString(), revision,
      data: adapter?.get(), baseline, legacy: legacy || captureLegacy(), recovery },
    'ppd-backup-' + new Date().toISOString().slice(0, 10) + '.json');
  }
  function listKey(value) { return JSON.stringify(value); }
  function merge(base, extra, overwrite = false) {
    const result = clone(base);
    for (const name of ['memberData', 'liveData', 'albums']) {
      for (const [id, incoming] of Object.entries(extra?.[name] || {})) {
        if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('バックアップ内のデータIDが不正です。');
        if (!Object.hasOwn(result[name], id)) { result[name][id] = clone(incoming); continue; }
        const existing = result[name][id];
        const merged = overwrite ? { ...existing, ...incoming } : { ...incoming, ...existing };
        for (const key of ['photos', 'activities', 'equipment']) {
          if (!Array.isArray(existing[key]) && !Array.isArray(incoming[key])) continue;
          const items = clone(existing[key] || []);
          const itemKey = item => key === 'photos' ? item.src : listKey(item);
          const indices = new Map(items.map((item, index) => [itemKey(item), index]));
          for (const item of incoming[key] || []) {
            const identity = itemKey(item);
            if (!indices.has(identity)) { indices.set(identity, items.length); items.push(clone(item)); }
            else if (overwrite && key === 'photos') items[indices.get(identity)] = { ...items[indices.get(identity)], ...clone(item) };
          }
          merged[key] = items;
          if (key === 'photos' && overwrite && incoming.photos?.[incoming.coverIndex]) {
            merged.coverIndex = indices.get(incoming.photos[incoming.coverIndex].src);
          }
        }
        result[name][id] = merged;
      }
    }
    return result;
  }
  async function imageSource(src) {
    if (!src || src.startsWith(API + 'media?key=')) return src;
    if (replacements.has(src)) return replacements.get(src);
    if (!src.startsWith('data:image/') && !/^assets\/[\w./-]+$/.test(src)) throw new Error('引き継げない画像URLがあります。バックアップを書き出してください。');
    const response = await fetch(src);
    if (!response.ok) throw new Error('既存の写真を読み込めません: ' + src.slice(0, 100));
    const blob = await response.blob();
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const result = await post('media', { base64 });
    replacements.set(src, result.src);
    return result.src;
  }
  async function normalize(data) {
    const result = clone(data);
    let count = 0;
    async function walk(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (imageKeys.has(key) && typeof item === 'string' && item && !item.startsWith(API + 'media?key=')) {
          status('写真を保存中 (' + (++count) + ')');
          value[key] = await imageSource(item);
        } else if (typeof item === 'object') await walk(item);
      }
    }
    await walk(result);
    return result;
  }
  function applyReplacements(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (imageKeys.has(key) && replacements.has(item)) value[key] = replacements.get(item);
      else if (typeof item === 'object') applyReplacements(item);
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (busy || !dirty || blocked || !session.authenticated || !initialized) return;
    busy = true;
    enableEditor();
    const number = editNumber;
    const draft = clone(adapter.get());
    try {
      status('保存中');
      const normalized = await normalize(draft);
      const saved = await post('content', { data: normalized, expectedRevision: revision });
      revision = saved.revision;
      applyReplacements(adapter.get());
      if (number === editNumber) {
        dirty = false;
        await backup({ data: normalized, revision, pending: false }).catch(() => { backupWarning = '端末のバックアップ保存に失敗しました。'; });
        status((session.storage === 'local' ? 'ローカル保存済み' : 'Googleドライブに保存済み') + (backupWarning ? ' / ' + backupWarning : ''));
      } else status('変更を保存中');
    } catch (error) {
      if (error.status === 409) blocked = true;
      status(error.message + ' / 未保存の下書きがあります。');
    } finally {
      busy = false;
      enableEditor();
      if (dirty && number !== editNumber && !blocked) timer = setTimeout(flush, 800);
    }
  }
  function stage() {
    if (!session.authenticated || !initialized) throw new Error('ログインと初回の引き継ぎを完了してください。');
    dirty = true;
    editNumber++;
    const data = clone(adapter.get());
    backup({ data, revision, pending: true }).catch(() => {
      backupWarning = '端末に下書きを残せません。バックアップを書き出してください。';
      status(backupWarning);
    });
    if (!blocked) {
      status('未保存の変更があります');
      clearTimeout(timer);
      timer = setTimeout(flush, 800);
    }
  }
  async function importExisting(extra = null) {
    if (busy || !session.authenticated) return;
    if (dirty) { status('先に未保存の変更を保存するか、バックアップを書き出してください。'); return; }
    if (!await window.showConfirm('現在の公開データを残して、既存の写真・ライブ情報を追加で引き継ぎますか？', '既存データの引き継ぎ')) return;
    busy = true;
    enableEditor();
    try {
      // Keep an untouched export before normalizing image URLs or publishing anything.
      exportBackup();
      const remote = await request('content');
      let combined = clone(baseline);
      if (legacy) combined = merge(combined, legacy, true);
      if (recovery?.pending) combined = merge(combined, recovery.data, true);
      if (extra) combined = merge(combined, extra, true);
      const normalized = await normalize(combined);
      const next = remote.content ? merge(remote.content.data, normalized) : normalized;
      const saved = await post('content', { data: next, expectedRevision: remote.content?.revision || null });
      revision = saved.revision;
      initialized = true;
      blocked = false;
      setData(next);
      await backup({ data: next, revision, pending: false }).catch(() => { backupWarning = '端末のバックアップ保存に失敗しました。'; });
      status(session.storage === 'local' ? 'ローカルへの引き継ぎ完了' : 'Googleドライブへの引き継ぎ完了');
    } catch (error) { status(error.message + ' / 元データは削除していません。'); }
    finally { busy = false; enableEditor(); }
  }
  async function importFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('バックアップファイルが大きすぎます。');
      const value = JSON.parse(await file.text());
      if (value.format !== 'ppd-backup-v1') throw new Error('PPDのバックアップファイルを選んでください。');
      let combined = value.data || value.baseline;
      if (!combined?.memberData || !combined?.liveData || !combined?.albums) throw new Error('バックアップの形式が不正です。');
      if (value.legacy) combined = merge(combined, value.legacy, true);
      if (value.recovery?.pending) combined = merge(combined, value.recovery.data, true);
      await importExisting(combined);
    } catch (error) { status(error.message); }
    event.target.value = '';
  }
  async function openLogin() {
    try {
      session = await request('session');
      if (session.authenticated) {
        if (!dirty && !busy) {
          const latest = await request('content');
          if (latest.content) {
            revision = latest.content.revision;
            initialized = true;
            setData(latest.content.data);
          }
        }
        element('admin-panel-modal').classList.remove('hidden');
        enableEditor();
      } else {
        element('admin-login-message').textContent = !session.configured ? 'Googleドライブの接続設定が必要です。' :
          session.storage === 'local' ? 'ローカル確認用: local-preview-only' : '';
        element('admin-login-modal').classList.remove('hidden');
      }
    } catch (error) {
      element('admin-login-message').textContent = error.message;
      element('admin-login-modal').classList.remove('hidden');
    }
    document.body.style.overflow = 'hidden';
  }
  async function login(event) {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await post('session', { password: element('admin-password').value });
      session = await request('session');
      element('admin-password').value = '';
      element('admin-login-modal').classList.add('hidden');
      await openLogin();
    } catch (error) { element('admin-login-message').textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function logout() {
    if (dirty || busy) { status('保存完了後にログアウトしてください。下書きの書き出しもできます。'); return; }
    try {
      await request('session', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      session.authenticated = false;
      element('admin-panel-modal').classList.add('hidden');
      document.body.style.overflow = 'auto';
      enableEditor();
    } catch (error) { status(error.message); }
  }
  async function start(callbacks) {
    adapter = callbacks;
    baseline = clone(adapter.get());
    legacy = captureLegacy();
    enableEditor();
    try { recovery = await backup(); } catch { /* Export remains available if IndexedDB is disabled. */ }
    try {
      session = await request('session');
      const result = session.configured ? await request('content') : { content: null };
      if (result.content) {
        revision = result.content.revision;
        initialized = true;
        setData(result.content.data);
        status(recovery?.pending ? '未保存の下書きがあります。「既存データを引き継ぐ」で取り込めます。' : '保存先: ' + (session.storage === 'local' ? 'ローカル' : 'Googleドライブ'));
      } else status(session.configured ? '初回の引き継ぎが必要です' : 'Googleドライブ未接続');
    } catch (error) { status(error.message); }
    enableEditor();
  }
  addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
  addEventListener('online', () => { if (dirty && !blocked) flush(); });
  window.PPDStorage = { start, stage, openLogin, login, logout, importExisting, importFile, exportBackup, retry: flush };
})();
