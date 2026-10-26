/* TOP 背单词 · 账号与同步（前端）
 * ---------------------------------
 * 设计原则：
 *  1. 不登录也能用，全部功能照旧；登录只是多了「跨设备同步」。
 *  2. 本地 localStorage 永远是主数据，云端是备份+合并，断网不影响背词。
 *  3. 合并按单词的 last 时间取大者，手机和电脑都背过的词不会互相回滚。
 *  4. 登录后使用账号种子，保证同一账号所有设备顺序一致。
 */
(function () {
  'use strict';

  // 后端地址解析优先级：
  //   1. window.TOP_API_BASE（页面里显式指定）
  //   2. <meta name="top-api" content="...">
  //   3. 同源（后端同时托管前端时最省事，也不受 CORS / Private Network 限制）
  //   4. 页面在 8123 等静态端口时，才回落到本机 API 的默认端口 8787
  var API = (function () {
    if (typeof window.TOP_API_BASE === 'string' && window.TOP_API_BASE) {
      return window.TOP_API_BASE.replace(/\/$/, '');
    }
    var meta = document.querySelector('meta[name="top-api"]');
    if (meta && meta.content) return meta.content.replace(/\/$/, '');
    var h = location.hostname;
    var isLocal = h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '';
    // 常见“静态预览端口”，此时才需要跨端口找 API
    var isStaticPreview = isLocal && ['8123', '8124', '8000', '8080', '3000'].indexOf(location.port) >= 0;
    if (isStaticPreview) return 'http://' + (h || '127.0.0.1') + ':8787';
    return '';          // 同源：/api/xxx
  })();
  var TOKEN_KEY = 'top.auth';
  var LAST_SYNC_KEY = 'top.syncAt';

  var auth = null;          // { token, user }
  var syncing = false;
  var syncTimer = null;
  var lastError = '';

  var $ = function (id) { return document.getElementById(id); };
  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }

  /* ---------------- 本地存储 ---------------- */
  function readAuth() {
    try {
      var raw = localStorage.getItem(TOKEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeAuth(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  /* ---------------- HTTP ---------------- */
  function request(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (auth && auth.token) headers.Authorization = 'Bearer ' + auth.token;
    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }).catch(function (err) {
      // 浏览器对 CORS / 连接失败只给 "Failed to fetch"，这里翻译成可行动的提示
      var e = new Error('连不上同步服务器（' + API + '）。请确认后端已启动，且服务端 TOP_ORIGIN 允许当前网址 ' + location.origin);
      e.status = 0;
      e.cause = err;
      throw e;
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var err = new Error(json.error || ('请求失败（' + res.status + '）'));
          err.status = res.status;
          err.code = json.code;
          // 404 且没有结构化 error 字段 → 站点根本没有 API，只是静态托管
          if (res.status === 404 && !json.error) {
            err.status = 0;
            err.code = 'NOT_AN_API';
            err.message = '当前网址没有同步服务';
          }
          throw err;
        }
        // 静态托管服务器常把未知路径回成 200 + index.html，这里检测「拿到的是不是真 API 响应」
        if (!json || typeof json !== 'object' || ('ok' in json === false && 'error' in json === false
            && 'token' in json === false && 'user' in json === false && 'seed' in json === false
            && 'progress' in json === false && 'settings' in json === false)) {
          var e2 = new Error('服务器没有返回 API 数据，可能只是静态托管');
          e2.status = 0;
          e2.code = 'NOT_AN_API';
          throw e2;
        }
        return json;
      });
    });
  }

  /* ---------------- 进度序列化 ---------------- */
  // 本地 PROG: { "0": {stage,seen,right,wrong,due,last}, ... }  →  数组
  function localProgressArray() {
    var api = window.TOP;
    if (!api || typeof api.state !== 'function') return [];
    var prog = api.state().progress || {};
    var out = [];
    for (var wid in prog) {
      if (!Object.prototype.hasOwnProperty.call(prog, wid)) continue;
      var p = prog[wid];
      if (!p) continue;
      out.push({
        wid: String(wid),
        stage: p.stage | 0, seen: p.seen | 0, right: p.right | 0, wrong: p.wrong | 0,
        due: p.due | 0, last: p.last | 0
      });
    }
    return out;
  }

  // 服务器进度合并进本地，按 last 取大者
  function mergeIntoLocal(remoteList) {
    if (!Array.isArray(remoteList) || !remoteList.length) return 0;
    var api = window.TOP;
    if (!api || typeof api.state !== 'function') return 0;
    var prog = api.state().progress;
    var changed = 0;
    for (var i = 0; i < remoteList.length; i++) {
      var r = remoteList[i];
      var wid = String(r.wid);
      if (!/^\d+$/.test(wid)) continue;
      var mine = prog[wid];
      if (mine && (mine.last | 0) >= (r.last | 0)) continue;
      prog[wid] = {
        stage: r.stage | 0, seen: r.seen | 0, right: r.right | 0,
        wrong: r.wrong | 0, due: r.due | 0, last: r.last | 0
      };
      changed++;
    }
    if (changed && typeof api.flush === 'function') api.flush();
    return changed;
  }

  /* ---------------- 设置序列化 ---------------- */
  function localSettings() {
    var api = window.TOP;
    if (!api || typeof api.state !== 'function') return null;
    var cfg = api.state().cfg || {};
    return {
      newPerDay: cfg.newPerDay, reviewPerDay: cfg.reviewPerDay, book: cfg.book,
      mode: cfg.mode, orders: cfg.orders || {}, autoSpeak: cfg.autoSpeak
    };
  }
  function applyRemoteSettings(remote) {
    if (!remote || typeof remote !== 'object') return false;
    try {
      var raw = localStorage.getItem('top.cfg');
      var cfg = raw ? JSON.parse(raw) : {};
      // 只覆盖云端有定义的字段，避免把本地新增字段抹掉
      ['newPerDay', 'reviewPerDay', 'book', 'mode', 'orders', 'autoSpeak'].forEach(function (k) {
        if (remote[k] !== undefined && remote[k] !== null) cfg[k] = remote[k];
      });
      localStorage.setItem('top.cfg', JSON.stringify(cfg));
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- 种子 ---------------- */
  // 登录后统一用服务器种子，这样同一账号在任何设备上顺序一致。
  function adoptSeed(remoteSeed) {
    if (typeof remoteSeed !== 'string' || !/^[0-9a-z]{16,}$/.test(remoteSeed)) return false;
    var current = null;
    try { current = localStorage.getItem('top.seed'); } catch (e) {}
    if (current === remoteSeed) return false;
    try { localStorage.setItem('top.seed', remoteSeed); } catch (e) { return false; }
    return true;
  }

  /* ---------------- 同步 ---------------- */
  function sync(options) {
    if (!auth || !auth.token) return Promise.resolve(null);
    if (syncing) return Promise.resolve(null);
    options = options || {};
    syncing = true;
    // 只有用户主动点「立即同步」才把「正在同步…」写进状态栏；
    // 后台静默同步不能覆盖「已登录 · 时间」，否则会一直停在过程中的文案。
    if (!options.silent) setStatus('正在同步…');
    var before = localProgressArray();

    return request('/api/sync', {
      method: 'POST',
      body: {
        progress: before,
        settings: localSettings()
      }
    }).then(function (data) {
      var pulled = mergeIntoLocal(data.progress);
      var seedChanged = adoptSeed(data.seed);
      var settingsChanged = (pulled === 0) && applyRemoteSettings(data.settings);

      try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch (e) {}

      if (pulled > 0 || seedChanged) {
        // 顺序或进度变了：让 app.js 重读 localStorage 并失效顺序缓存
        if (typeof window.TOP.reloadFromStorage === 'function') window.TOP.reloadFromStorage();
        else if (typeof window.TOP.refresh === 'function') window.TOP.refresh();
        if (settingsChanged && typeof window.TOP.refresh === 'function') window.TOP.refresh();
        toast(pulled > 0 ? ('已同步 ' + pulled + ' 个词的进度') : '已同步学习顺序');
        renderOrderLabel();
        window.dispatchEvent(new CustomEvent('top:change'));
      }
      if (pulled > 0 || seedChanged || !options.silent) {
        setStatus('已同步 · ' + timeLabel());
      }
      return data;
    }).catch(function (err) {
      if (err.status === 401) {
        logoutLocal('登录已过期，请重新登录');
        return null;
      }
      lastError = err.message || '同步失败';
      setStatus('同步失败：' + lastError, true);
      return null;
    }).then(function (r) {
      syncing = false;
      renderAll();
      return r;
    });
  }

  function scheduleSync(delay) {
    if (!auth) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { sync({ silent: true }); }, delay || 2500);
  }

  function timeLabel() {
    var t = 0;
    try { t = Number(localStorage.getItem(LAST_SYNC_KEY) || 0); } catch (e) {}
    if (!t) return '尚未同步';
    var d = new Date(t);
    var now = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  /* ---------------- UI ---------------- */
  function setStatus(text, isError) {
    var el = $('accountStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function renderAll() {
    var signed = !!(auth && auth.user);
    var signedBox = $('accountSigned');
    var guestBox = $('accountGuest');
    if (signedBox) signedBox.classList.toggle('hidden', !signed);
    if (guestBox) guestBox.classList.toggle('hidden', signed);

    // 面板右上角的状态标签
    var chip = $('accountChip');
    if (chip) chip.textContent = signed ? '已登录' : '未登录';

    if (!signed) return;

    var name = $('accountName');
    var mail = $('accountEmail');
    if (name) name.textContent = auth.user.name || '学习者';
    if (mail) mail.textContent = auth.user.email || '';
    var av = $('accountAvatar');
    if (av) av.textContent = (auth.user.name || 'T').slice(0, 1).toUpperCase();
    var st = $('accountSince');
    if (st && auth.user.createdAt) {
      var d = new Date(auth.user.createdAt);
      st.textContent = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月加入';
    }
  }

  function renderOrderLabel() {
    // 提示用户：登录后顺序由账号决定
    var el = $('orderLab');
    if (!el) return;
    var book = '当前词书';
    try {
      var api = window.TOP;
      if (api && api.state) book = api.state().cfg.book || book;
    } catch (e) {}
    el.innerHTML = '<b>' + book + '</b> 的顺序';
  }

  function openAuthDialog(mode) {
    var dlg = $('authDialog');
    if (!dlg) return;
    switchTab(mode || 'login');
    $('authFormStatus').textContent = '';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  function closeAuthDialog() {
    var dlg = $('authDialog');
    if (!dlg) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }
  function switchTab(mode) {
    var isRegister = mode === 'register';
    $('authTitle').textContent = isRegister ? '创建一个账号' : '登录账号';
    $('authSubtitle').textContent = isRegister
      ? '登录后，换设备也能接着背。'
      : '登录后，学习进度自动同步到你所有设备。';
    // 昵称只在注册时显示；用独立 id 控制，不依赖 DOM 层级
    var nameField = $('authNameField');
    if (nameField) nameField.classList.toggle('hidden', !isRegister);
    $('authSubmit').textContent = isRegister ? '注册并登录' : '登录';
    $('authMode').value = isRegister ? 'register' : 'login';
    var sw = $('authSwitch');
    sw.textContent = isRegister ? '已有账号？去登录' : '还没有账号？去注册';
    sw.dataset.next = isRegister ? 'login' : 'register';
    $('authPassword').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
  }

  function submitAuth(event) {
    event.preventDefault();
    var mode = $('authMode').value;
    var email = $('authEmail').value.trim();
    var password = $('authPassword').value;
    var name = $('authName').value.trim();
    var statusEl = $('authFormStatus');
    var btn = $('authSubmit');

    if (!email || !password) { statusEl.textContent = '请填写邮箱和密码'; return; }
    if (mode === 'register' && password.length < 8) { statusEl.textContent = '密码至少 8 位'; return; }

    btn.disabled = true;
    statusEl.textContent = mode === 'register' ? '正在创建账号…' : '正在登录…';

    request(mode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: mode === 'register' ? { email: email, password: password, name: name } : { email: email, password: password }
    }).then(function (data) {
      auth = { token: data.token, user: data.user };
      writeAuth(auth);
      statusEl.textContent = '成功，正在同步学习进度…';
      return sync({ silent: true }).then(function () {
        closeAuthDialog();
        toast(mode === 'register' ? '账号已创建，学习进度开始同步' : '登录成功');
        $('authPassword').value = '';
        renderAll();
        // 登录/注册成功后统一显示「已登录 · 时间」，不要停留在过程中的「正在同步」
        setStatus('已登录 · ' + timeLabel());
      });
    }).catch(function (err) {
      statusEl.textContent = err.message || '操作失败';
    }).then(function () {
      btn.disabled = false;
    });
  }

  function logoutLocal(reason) {
    auth = null;
    writeAuth(null);
    renderAll();
    setStatus(reason || '已退出登录，学习记录仍保存在本机');
  }

  function doLogout() {
    if (!auth) return;
    var token = auth.token;
    request('/api/logout', { method: 'POST' }).catch(function () {}).then(function () {
      logoutLocal('已退出登录，学习记录仍保存在本机');
      toast('已退出登录');
    });
  }

  function doManualSync() {
    if (!auth) { openAuthDialog('login'); return; }
    sync({}).then(function (r) {
      if (r) toast('同步完成');
    });
  }

  function doChangePassword() {
    var cur = $('pwdCurrent').value;
    var next = $('pwdNext').value;
    var msg = $('pwdStatus');
    if (!cur || !next) { msg.textContent = '请填写两个密码'; return; }
    if (next.length < 8) { msg.textContent = '新密码至少 8 位'; return; }
    request('/api/password', { method: 'POST', body: { current: cur, next: next } }).then(function () {
      msg.textContent = '密码已修改，其他设备已退出登录';
      $('pwdCurrent').value = ''; $('pwdNext').value = '';
      toast('密码已修改');
    }).catch(function (err) {
      msg.textContent = err.message || '修改失败';
    });
  }

  function doDeleteAccount() {
    if (!auth) return;
    var ok = window.confirm('注销账号会永久删除云端的学习进度和设置。\n本机记录不会被删除，仍可继续离线使用。\n\n确定注销吗？');
    if (!ok) return;
    request('/api/account', { method: 'DELETE' }).then(function () {
      logoutLocal('账号已注销，本机记录保留');
      toast('账号已注销');
      try { localStorage.removeItem('top.seed'); } catch (e) {}
    }).catch(function (err) {
      setStatus('注销失败：' + (err.message || ''), true);
    });
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    var d = document;
    var on = function (id, ev, fn) {
      var el = $(id);
      if (el) el.addEventListener(ev, fn);
    };

    on('accountLogin', 'click', function () { openAuthDialog('login'); });
    on('accountRegister', 'click', function () { openAuthDialog('register'); });
    on('accountLogout', 'click', doLogout);
    on('accountSyncNow', 'click', doManualSync);
    on('authClose', 'click', closeAuthDialog);
    on('authSwitch', 'click', function () { switchTab(this.dataset.next); });
    on('authForm', 'submit', submitAuth);
    on('pwdChange', 'click', doChangePassword);
    on('accountDelete', 'click', doDeleteAccount);

    var dlg = $('authDialog');
    if (dlg) {
      dlg.addEventListener('click', function (e) { if (e.target === dlg) closeAuthDialog(); });
    }

    // 学习时每答一题都会触发 top:change，延迟合并成一次同步
    window.addEventListener('top:change', function () { scheduleSync(2500); });
    // 页面隐藏/关闭前尽力保存一次（sendBeacon 不能带 Authorization 头，走 query token）
    window.addEventListener('pagehide', function () {
      if (!auth || !auth.token) return;
      try {
        var data = JSON.stringify({ progress: localProgressArray(), settings: localSettings() });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(API + '/api/sync?token=' + encodeURIComponent(auth.token),
            new Blob([data], { type: 'application/json' }));
        }
      } catch (e) {}
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && auth) sync({ silent: true });
    });

    // 每 5 分钟自动同步一次
    setInterval(function () { if (auth) sync({ silent: true }); }, 5 * 60 * 1000);
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    auth = readAuth();
    if (auth && auth.user) {
      // 验证 token 是否还有效，并拉一次远端
      request('/api/me').then(function (data) {
        auth.user = data.user;
        writeAuth(auth);
        renderAll();
        return sync({ silent: true });
      }).catch(function (err) {
        if (err.status === 401) logoutLocal('登录已过期，请重新登录');
        else if (err.status === 0) markBackendMissing();
      });
    } else {
      // 未登录时探一次后端，决定要不要提示「本版没有同步服务」
      request('/api/health').then(function () {
        backendOk = true;
      }).catch(function (err) {
        if (err.status === 0) markBackendMissing();
      });
    }
    bind();
    renderAll();
    setStatus(auth && auth.user ? ('已登录 · ' + timeLabel()) : '未登录时，学习记录只保存在本机。');
  }

  // 后端不可达时把账号区标成「本版不含同步服务」，别让用户以为是自己填错了
  function markBackendMissing() {
    backendOk = false;
    var guest = $('accountGuest');
    if (guest && !backendOk) {
      var note = $('accountOfflineNote');
      if (!note) {
        note = document.createElement('p');
        note.id = 'accountOfflineNote';
        note.className = 'setting-help account-offline';
        guest.appendChild(note);
      }
      note.textContent = '当前网址没有连接同步服务器，本页面只能离线背词，记录保存在本机。想用账号同步，请自行部署 server/server.js（见 docs/账号系统.md）。';
    }
    ['accountLogin', 'accountRegister'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = true;
    });
    setStatus('同步服务不可用，学习记录只保存在本机。');
  }
  var backendOk = true;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 供调试/其他模块调用
  window.TOPAccount = {
    sync: function () { return sync({}); },
    current: function () { return auth; },
    open: openAuthDialog
  };
})();
