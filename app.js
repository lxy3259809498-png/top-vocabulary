/* top — 背单词 web app
 * 视觉：米白 / 墨绿；学习调度沿用原版。
 * 交互：墨墨式（卡片翻面 + 三档自评 + 答错当日重排）
 * 调度：墨墨式阶段制（非 FSRS），见 schedule() 注释
 */
(function () {
  'use strict';

  var DATA = null;
  var CFG = { newPerDay: 20, reviewPerDay: 30, book: 'cet4', mode: 0, orders: {}, autoSpeak: 1 };
  var SIGN = { last: '', streak: 0, points: 0, total: 0, days: {} };
  var PROG = {};
  var queue = [];
  var idx = 0;
  var revealed = false;
  var sessionNew = 0;
  var sessionReview = 0;
  var sessionAgain = 0;          // 当日重排次数
  var todayDone = 0;
  var todayKey = '';
  var VOICE = { ok: false };
  var ORDER_CACHE = {};          // book + ':' + order -> 索引数组
  var pendingCheck = null;
  var speakTimer = null;
  var SEED = '';                 // 本设备私有的单词顺序种子（每人各不相同）

  var $ = function (id) { return document.getElementById(id); };

  /* =========================================================
   *  墨墨式阶段调度
   *  ---------------------------------------------------------
   *  墨墨的可观察行为：
   *   1. 新词间隔很短（当天/次日）
   *   2. 答对 → 阶段+1，间隔按阶段递增
   *   3. 答错 → 阶段回退，且**当天重新出现**
   *   4. 模糊 → 阶段不变
   *  墨墨原算法闭源，这里复刻的是上述行为，不是内部实现。
   * ========================================================= */
  var STAGE_DAYS = [0, 1, 2, 4, 7, 15, 30, 60, 120, 240];

  function daysForStage(stage) {
    if (stage <= 0) return 0;
    if (stage >= STAGE_DAYS.length) return STAGE_DAYS[STAGE_DAYS.length - 1];
    return STAGE_DAYS[stage];
  }

  /**
   * 记录一次作答
   * grade: 0=忘记 1=模糊 2=认识
   * 返回 { stage, days, requeue }
   */
  function schedule(wid, grade) {
    var p = PROG[wid] || { stage: 0, due: 0, seen: 0, right: 0, wrong: 0, last: 0 };
    var now = Date.now();
    p.seen++;

    var requeue = false;

    if (grade === 2) {
      // 认识
      p.stage = Math.min(9, (p.stage || 0) + 1);
      p.right++;
    } else if (grade === 1) {
      // 模糊：阶段不变，但当天要再看一次
      requeue = true;
      p.stage = p.stage || 0;
    } else {
      // 忘记：阶段回退两级，当天重排
      p.stage = Math.max(0, (p.stage || 0) - 2);
      p.wrong++;
      requeue = true;
    }

    var days = daysForStage(p.stage);
    p.due = now + days * 86400000;
    p.last = now;
    PROG[wid] = p;
    saveProg();

    return { stage: p.stage, days: days, requeue: requeue };
  }

  /* ---------- 每台设备独有的顺序种子 ---------- */
  // 每人第一次打开时生成一个随机种子并存在本机，之后的乱序都从它派生，
  // 所以「我」的乱序和别人不同，但「我」自己刷新、换书回来都不变。
  function newSeed() {
    var bytes = null;
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
      }
    } catch (e) { bytes = null; }
    var out = '';
    if (bytes) {
      for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
    } else {
      for (var j = 0; j < 4; j++) out += ('0000000' + Math.floor(Math.random() * 0x100000000).toString(16)).slice(-8);
    }
    return out + Date.now().toString(36);
  }

  function loadSeed() {
    var saved = '';
    try { saved = localStorage.getItem('top.seed') || ''; } catch (e) { saved = ''; }
    if (!/^[0-9a-z]{16,}$/.test(saved)) {
      saved = newSeed();
      try { localStorage.setItem('top.seed', saved); }
      catch (e) { storageError(); }
    }
    SEED = saved;
  }

  /* ---------- storage ---------- */
  function loadCfg() {
    try {
      var o = JSON.parse(localStorage.getItem('top.cfg') || '{}');
      if (o.newPerDay) CFG.newPerDay = o.newPerDay;
      if (o.reviewPerDay) CFG.reviewPerDay = o.reviewPerDay;
      if (o.book) CFG.book = o.book;
      if (typeof o.mode === 'number') CFG.mode = o.mode;
      if (o.orders && typeof o.orders === 'object') CFG.orders = o.orders;
      if (typeof o.autoSpeak === 'number') CFG.autoSpeak = o.autoSpeak;
      // 兼容旧配置：全局 shuffle 迁移成默认值
      if (typeof o.shuffle === 'number') CFG.legacyShuffle = o.shuffle;
    } catch (e) {}
  }

  /** 取某本词书的顺序：0=正序 1=乱序（按书独立记忆，首次默认乱序） */
  function orderOfBook(bookKey) {
    var v = CFG.orders[bookKey];
    return (typeof v === 'number') ? v : 1;
  }

  function setOrderOfBook(bookKey, v) {
    CFG.orders[bookKey] = v;
    saveCfg();
    for (var k in ORDER_CACHE) {
      if (k.indexOf(bookKey + ':') === 0) delete ORDER_CACHE[k];
    }
  }
  function saveCfg() {
    try { localStorage.setItem('top.cfg', JSON.stringify(CFG)); } catch (e) {}
  }
  function loadProg() {
    try { PROG = JSON.parse(localStorage.getItem('top.prog') || '{}') || {}; } catch (e) { PROG = {}; }
  }
  var saveTimer = null;
  function saveProg() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      flushProg();
    }, 350);
  }
  function storageError() {
    notify('top:storage-error');
  }
  function flushProg() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try { localStorage.setItem('top.prog', JSON.stringify(PROG)); }
    catch (e) { storageError(); }
  }
  function notify(name) {
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent(name));
    }
  }
  function saveSession() {
    if (!DATA || idx >= queue.length) return;
    try {
      localStorage.setItem('top.session', JSON.stringify({
        day: dayKey(), book: CFG.book, mode: CFG.mode,
        queue: queue, idx: idx, sessionNew: sessionNew,
        sessionReview: sessionReview, sessionAgain: sessionAgain
      }));
    } catch (e) { storageError(); }
  }
  function resumableSession() {
    try {
      var s = JSON.parse(localStorage.getItem('top.session') || 'null');
      if (!s || s.day !== dayKey() || s.book !== CFG.book || s.mode !== CFG.mode ||
          !Array.isArray(s.queue) || !Number.isInteger(s.idx) || s.idx < 0 || s.idx >= s.queue.length) return null;
      var allowed = CFG.book === 'all' ? null : new Set(DATA.books[CFG.book] || []);
      if (!s.queue.every(function (item) {
        return item && Number.isInteger(item.wid) && item.wid >= 0 && item.wid < DATA.words.length &&
          (!allowed || allowed.has(item.wid)) && typeof item.isReview === 'boolean';
      })) return null;
      return s;
    } catch (e) { return null; }
  }
  function dayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function loadToday() {
    todayKey = dayKey();
    try {
      var o = JSON.parse(localStorage.getItem('top.today') || '{}');
      todayDone = (o.day === todayKey) ? (o.n || 0) : 0;
    } catch (e) { todayDone = 0; }
  }
  function saveToday() {
    try {
      localStorage.setItem('top.today', JSON.stringify({ day: todayKey, n: todayDone }));
      // 7 日历史
      var h = JSON.parse(localStorage.getItem('top.hist') || '{}');
      h[todayKey] = todayDone;
      localStorage.setItem('top.hist', JSON.stringify(h));
    } catch (e) {}
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem('top.hist') || '{}') || {}; } catch (e) { return {}; }
  }

  /* =========================================================
   *  签到 & 积分
   * ========================================================= */
  var SIGN_KEY = 'top.sign';
  var REWARDS = [5, 5, 10, 10, 15, 20, 30];   // 第 1-7 天基础积分
  var STREAK_BONUS = function (n) {
    // 连续越久，额外奖励越多（每 7 天一轮）
    var rounds = Math.floor((n - 1) / 7);
    return rounds * 10;
  };

  function loadSign() {
    try {
      var o = JSON.parse(localStorage.getItem(SIGN_KEY) || '{}');
      SIGN.last = o.last || '';
      SIGN.streak = o.streak || 0;
      SIGN.points = o.points || 0;
      SIGN.total = o.total || 0;
      SIGN.days = o.days || {};
    } catch (e) {}
  }
  function saveSign() {
    try { localStorage.setItem(SIGN_KEY, JSON.stringify(SIGN)); } catch (e) {}
  }

  function dateStr(offset) {
    var d = new Date(Date.now() + (offset || 0) * 86400000);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  /** 今天是否已签到 */
  function signedToday() {
    return SIGN.last === dateStr(0);
  }

  /** 昨天是否签过（决定连续是否延续） */
  function signedYesterday() {
    return SIGN.last === dateStr(-1);
  }

  /** 下次签到能拿多少分 */
  function nextReward() {
    var nextStreak = signedYesterday() ? (SIGN.streak + 1) : 1;
    var base = REWARDS[(nextStreak - 1) % 7];
    return { streak: nextStreak, points: base + STREAK_BONUS(nextStreak) };
  }

  function doSign() {
    if (signedToday()) return { ok: false, reason: 'already' };
    var r = nextReward();
    SIGN.streak = r.streak;
    SIGN.points += r.points;
    SIGN.total += r.points;
    SIGN.last = dateStr(0);
    SIGN.days[dateStr(0)] = { streak: r.streak, pts: r.points };
    saveSign();
    return { ok: true, streak: r.streak, points: r.points };
  }

  /* ---------- speech ---------- */
  function setVoiceLine(s) {
    var el = $('voiceLine');
    if (el) el.textContent = s;
  }
  function initVoice() {
    if (window.TOPAndroid) { setVoiceLine('优先使用系统英语语音'); return; }
    if (!('speechSynthesis' in window)) { setVoiceLine('无语音引擎，使用在线发音'); return; }
    var pick = function () {
      var vs = window.speechSynthesis.getVoices() || [];
      if (!vs.length) return;
      for (var i = 0; i < vs.length; i++) {
        if ((vs[i].lang || '').toLowerCase().indexOf('en-us') === 0) {
          VOICE.ok = true; setVoiceLine('语音就绪'); return;
        }
      }
      for (var j = 0; j < vs.length; j++) {
        if ((vs[j].lang || '').toLowerCase().indexOf('en') === 0) {
          VOICE.ok = true; setVoiceLine('语音就绪'); return;
        }
      }
      setVoiceLine('无英文语音，使用在线发音');
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    setTimeout(pick, 600);
  }
  function speak(word) {
    if (!word) return;
    if (window.TOPAndroid && typeof window.TOPAndroid.speak === 'function') {
      try {
        if (window.TOPAndroid.speak(word)) { setVoiceLine('系统英语语音'); return; }
        setVoiceLine('系统英语语音未就绪，使用在线发音');
      } catch (e) { setVoiceLine('系统英语语音不可用，使用在线发音'); }
    }
    if (VOICE.ok) {
      try {
        window.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(word);
        u.lang = 'en-US'; u.rate = 0.88;
        window.speechSynthesis.speak(u);
        return;
      } catch (e) {}
    }
    try {
      var a = new Audio('https://dict.youdao.com/dictvoice?audio=' +
        encodeURIComponent(word) + '&type=2');
      var p = a.play();
      if (p && p.catch) p.catch(function () { setVoiceLine('点一下页面再试发音'); });
    } catch (e) { setVoiceLine('发音失败'); }
  }

  /* ---------- 顺序 / 乱序 ---------- */
  // 用「本书名 + 本设备种子」作为洗牌输入：
  // 同一个人同一本书每次顺序一致，不同设备（不同人）顺序不同。
  function seededShuffle(arr, seedStr) {
    var seed = 2166136261;
    for (var i = 0; i < seedStr.length; i++) {
      seed ^= seedStr.charCodeAt(i);
      seed = (seed * 16777619) >>> 0;
    }
    var out = arr.slice();
    var rand = function () {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    };
    for (var j = out.length - 1; j > 0; j--) {
      var k = Math.floor(rand() * (j + 1));
      var t = out[j]; out[j] = out[k]; out[k] = t;
    }
    return out;
  }

  function orderOf(bookKey) {
    if (!DATA) return [];
    var raw = (bookKey === 'all')
      ? DATA.words.map(function (_, i) { return i; })
      : (DATA.books[bookKey] || []);
    var wantShuffle = orderOfBook(bookKey);
    if (!wantShuffle) return raw;
    var key = bookKey + ':1';
    if (!ORDER_CACHE[key]) {
      ORDER_CACHE[key] = seededShuffle(raw, 'top-' + bookKey + '-' + SEED);
    }
    return ORDER_CACHE[key];
  }

  /* ---------- queue ---------- */
  function buildQueue() {
    queue = [];
    if (!DATA) return;
    var now = Date.now();
    var ordered = orderOf(CFG.book);
    var reviews = [], news = [], i, wid, p;

    for (i = 0; i < ordered.length; i++) {
      wid = ordered[i];
      p = PROG[wid];
      if (p && p.seen > 0 && p.due <= now) reviews.push(wid);
      else if (!p) news.push(wid);
    }
    reviews.sort(function (a, b) { return PROG[a].due - PROG[b].due; });

    var rv = reviews.slice(0, CFG.reviewPerDay);
    var nw = news.slice(0, CFG.newPerDay);
    for (i = 0; i < rv.length; i++) queue.push({ wid: rv[i], isReview: true });
    for (i = 0; i < nw.length; i++) queue.push({ wid: nw[i], isReview: false });
    idx = 0;
  }

  function wordOf(wid) {
    var w = (DATA.words[wid] || ['', '', '', '']);
    return { sp: w[0], phon: w[1], mean: w[2], def: w[3] };
  }

  /* ---------- pages ---------- */
  function showPage(which) {
    if (which !== 'study') cancelPendingCheck();
    if (speakTimer !== null) clearTimeout(speakTimer);
    if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel();
    ['home', 'study', 'done'].forEach(function (p) {
      var el = $(p);
      if (el) el.classList.toggle('hidden', p !== which);
    });
    if (document.body && document.body.dataset) document.body.dataset.view = which;
    notify('top:view');
  }

  /* ---------- home ---------- */
  function renderHome() {
    if (!DATA) return;
    if (todayKey !== dayKey()) loadToday();
    var goal = CFG.newPerDay + CFG.reviewPerDay;
    var frac = goal > 0 ? Math.min(1, todayDone / goal) : 0;

    var C = 2 * Math.PI * 42;
    var arc = $('ringArc');
    arc.setAttribute('stroke-dasharray', C.toFixed(1));
    arc.setAttribute('stroke-dashoffset', (C * (1 - frac)).toFixed(1));
    $('ringPct').textContent = Math.round(frac * 100) + '%';
    $('doneNum').textContent = todayDone;
    $('goalNum').textContent = goal;
    $('taskBadge').textContent = todayDone >= goal ? '已完成' : '进行中';
    $('taskBadge').className = 'badge' + (todayDone >= goal ? ' ok' : '');

    var studied = 0, mastered = 0, due = 0, stages = [0, 0, 0, 0, 0], now = Date.now();
    for (var k in PROG) {
      var p = PROG[k];
      if (!p || !p.seen) continue;
      studied++;
      if ((p.stage || 0) >= 5) mastered++;
      if (p.due <= now) due++;
      var s = Math.min(4, Math.floor((p.stage || 0) / 2));
      stages[s]++;
    }
    $('mNew').textContent = todayDone;
    $('mDue').textContent = due;
    $('mMaster').textContent = mastered;

    // 掌握分布条
    var total = Math.max(1, studied);
    for (var i = 0; i < 5; i++) {
      var el = $('seg' + i);
      if (el) {
        var w = stages[i] / total * 100;
        el.style.width = w.toFixed(1) + '%';
        el.classList.toggle('on', w > 0);
      }
    }
    $('stageHint').textContent = studied ? ('已学 ' + studied + ' 词') : '还没有学习记录';

    // 7 日柱状
    var hist = loadHistory();
    var bars = $('bars');
    if (bars) {
      bars.innerHTML = '';
      var days = [];
      for (var d = 6; d >= 0; d--) {
        var dt = new Date(Date.now() - d * 86400000);
        var key = dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate();
        days.push({ key: key, v: hist[key] || 0, label: (dt.getMonth() + 1) + '/' + dt.getDate() });
      }
      var maxV = 1;
      days.forEach(function (x) { if (x.v > maxV) maxV = x.v; });
      days.forEach(function (x) {
        var col = document.createElement('div');
        col.className = 'bar-col';
        var h = Math.max(4, Math.round(x.v / maxV * 44));
        col.innerHTML = '<div class="bar-v">' + (x.v || '') + '</div>' +
          '<div class="bar-b" style="height:' + h + 'px"></div>' +
          '<div class="bar-l">' + x.label + '</div>';
        bars.appendChild(col);
      });
    }

    // chips
    var chips = $('chips');
    chips.innerHTML = '';
    var order = ['all', 'zk', 'gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'];
    order.forEach(function (key) {
      var el = document.createElement('div');
      el.className = 'chip' + (CFG.book === key ? ' on' : '');
      el.textContent = key === 'all' ? '全部' : (DATA.names[key] || key);
      el.onclick = function () { CFG.book = key; saveCfg(); renderHome(); };
      chips.appendChild(el);
    });
    var cnt = CFG.book === 'all' ? DATA.words.length : (DATA.books[CFG.book] || []).length;
    $('bookCount').textContent = cnt.toLocaleString() + ' 词';

    // tabs
    var tabs = document.querySelectorAll('.tabs .tab');
    for (var t = 0; t < tabs.length; t++) {
      (function (tab) {
        var m = parseInt(tab.getAttribute('data-mode'), 10);
        tab.classList.toggle('on', m === CFG.mode);
        tab.onclick = function () { CFG.mode = m; saveCfg(); renderHome(); };
      })(tabs[t]);
    }

    // 顺序开关（按当前词书独立记忆）
    var cur = orderOfBook(CFG.book);
    var orderBtns = document.querySelectorAll('#segOrder button');
    for (var ob = 0; ob < orderBtns.length; ob++) {
      (function (btn) {
        var v = parseInt(btn.getAttribute('data-order'), 10);
        btn.classList.toggle('on', cur === v);
        btn.onclick = function () {
          setOrderOfBook(CFG.book, v);
          renderHome();
        };
      })(orderBtns[ob]);
    }
    if ($('orderLab')) {
      var bk = CFG.book === 'all' ? '全部单词' : (DATA.names[CFG.book] || CFG.book);
      $('orderLab').innerHTML = '<b>' + bk + '</b> 的顺序';
    }

    // 自动发音开关
    var speakBtns = document.querySelectorAll('#segSpeak button');
    for (var sb = 0; sb < speakBtns.length; sb++) {
      (function (btn) {
        var v = parseInt(btn.getAttribute('data-speak'), 10);
        btn.classList.toggle('on', CFG.autoSpeak === v);
        btn.onclick = function () {
          CFG.autoSpeak = v;
          saveCfg();
          renderHome();
        };
      })(speakBtns[sb]);
    }

    if ($('planNew')) $('planNew').textContent = CFG.newPerDay;
    if ($('planRev')) $('planRev').textContent = CFG.reviewPerDay;
    notify('top:change');
  }

  /* ---------- study ---------- */
  function renderCard() {
    cancelPendingCheck();
    if (speakTimer !== null) clearTimeout(speakTimer);
    if (idx >= queue.length) { finish(); return; }
    var item = queue[idx];
    var w = wordOf(item.wid);
    revealed = false;

    var pct = (idx + 1) / queue.length;
    $('pbarFill').style.width = (pct * 100).toFixed(1) + '%';
    $('counter').textContent = (idx + 1) + ' / ' + queue.length;
    $('pctText').textContent = Math.round(pct * 100) + '%';
    $('modeLabel').textContent = CFG.mode === 0 ? '认词' : (CFG.mode === 1 ? '听写' : '拼写');

    var typeTxt = item.isAgain ? '再见' : (item.isReview ? '复习' : '新词');
    var typeEl = $('typeLabel');
    typeEl.textContent = typeTxt;
    typeEl.className = 'trail' + (item.isAgain ? ' again' : (item.isReview ? ' review' : ''));

    $('meaningEl').innerHTML = '';
    $('fbEl').textContent = '';
    $('inputEl').value = '';
    $('hintEl').style.display = 'block';
    $('btnSpeak').style.display = 'none';
    $('nextInfo').textContent = '';

    if (CFG.mode === 0) {
      $('wordEl').style.display = 'block';
      $('wordEl').textContent = w.sp;
      $('wordEl').className = 'word';
      void $('wordEl').offsetWidth;
      $('wordEl').className = 'word';
      $('phonEl').textContent = w.phon ? '/' + w.phon + '/' : '';
      $('phonEl').style.display = 'block';
      $('btnSpeak').style.display = 'flex';
      $('answerBox').classList.add('hidden');
      $('hintEl').textContent = '点击卡片查看释义';
      if (CFG.autoSpeak) speakTimer = setTimeout(function () { speak(w.sp); }, 180);
    } else if (CFG.mode === 1) {
      $('wordEl').style.display = 'none';
      $('phonEl').style.display = 'none';
      $('btnSpeak').style.display = 'flex';
      $('answerBox').classList.remove('hidden');
      $('hintEl').textContent = '听发音，拼出单词';
      speakTimer = setTimeout(function () { speak(w.sp); }, 120);
    } else {
      $('wordEl').style.display = 'none';
      $('phonEl').style.display = 'none';
      $('answerBox').classList.remove('hidden');
      $('hintEl').textContent = '看释义，拼出单词';
      var m = $('meaningEl');
      m.innerHTML = '';
      var dv = document.createElement('div');
      dv.textContent = w.mean;
      m.appendChild(dv);
      if (CFG.autoSpeak) speakTimer = setTimeout(function () { speak(w.sp); }, 180);
    }
    saveSession();
    notify('top:change');
  }

  function reveal() {
    if (CFG.mode !== 0 || revealed || idx >= queue.length) return;
    revealed = true;
    var w = wordOf(queue[idx].wid);
    var m = $('meaningEl');
    m.innerHTML = '';
    var d1 = document.createElement('div');
    d1.className = 'fadein';
    d1.textContent = w.mean;
    m.appendChild(d1);
    if (w.def) {
      var d2 = document.createElement('div');
      d2.className = 'def fadein';
      d2.textContent = w.def;
      m.appendChild(d2);
    }
    $('hintEl').style.display = 'none';
  }

  function cancelPendingCheck() {
    if (pendingCheck !== null) clearTimeout(pendingCheck);
    pendingCheck = null;
    ['btnCheck', 'inputEl', 'btnYes', 'btnNo', 'btnVague'].forEach(function (id) {
      if ($(id)) $(id).disabled = false;
    });
  }
  function checkSpelling() {
    if (idx >= queue.length || pendingCheck !== null) return;
    var w = wordOf(queue[idx].wid);
    var typed = ($('inputEl').value || '').trim();
    if (!typed) return;
    var ok = typed.toLowerCase() === w.sp.toLowerCase();
    var fb = $('fbEl');
    fb.textContent = ok ? '✓ 正确' : '✗ 正确答案：' + w.sp;
    fb.style.color = ok ? 'var(--green)' : 'var(--red)';

    var m = $('meaningEl');
    m.innerHTML = '';
    var dv = document.createElement('div');
    dv.textContent = w.mean;
    m.appendChild(dv);
    $('hintEl').style.display = 'none';

    var answerIndex = idx;
    var answerItem = queue[idx];
    ['btnCheck', 'inputEl', 'btnYes', 'btnNo', 'btnVague'].forEach(function (id) { $(id).disabled = true; });
    pendingCheck = setTimeout(function () {
      pendingCheck = null;
      if (idx === answerIndex && queue[idx] === answerItem) grade(ok ? 2 : 0);
    }, ok ? 550 : 1400);
  }

  function grade(g) {
    if (idx >= queue.length || pendingCheck !== null) return;
    if (CFG.mode === 0 && !revealed) { reveal(); return; }

    var item = queue[idx];
    var r = schedule(item.wid, g);

    if (item.isReview) sessionReview++; else sessionNew++;
    if (todayKey !== dayKey()) loadToday();
    todayDone++;
    saveToday();

    // 墨墨行为：答错/模糊 → 当天队尾重现
    if (r.requeue) {
      sessionAgain++;
      queue.push({ wid: item.wid, isReview: false, isAgain: true });
    }

    // 提示下次复习
    var info = $('nextInfo');
    if (info) {
      if (r.requeue) {
        info.textContent = '今天还会再见一次';
      } else {
        info.textContent = r.days <= 1 ? '明天复习' :
          (r.days >= 30 ? Math.round(r.days / 30) + ' 个月后复习' : r.days + ' 天后复习');
      }
    }

    idx++;
    renderCard();
    // 反馈留在下一张卡片下方，不改变进入下一词或重排的时机。
    if (info) info.textContent = r.requeue ? '刚才的词今天还会再见' :
      ('刚才的词：' + (r.days <= 1 ? '明天复习' : r.days + ' 天后复习'));
  }

  function startStudy() {
    cancelPendingCheck();
    var resume = resumableSession();
    if (resume) {
      queue = resume.queue; idx = resume.idx;
      sessionNew = resume.sessionNew || 0;
      sessionReview = resume.sessionReview || 0;
      sessionAgain = resume.sessionAgain || 0;
    } else {
      buildQueue();
      sessionNew = 0; sessionReview = 0; sessionAgain = 0;
    }
    if (!queue.length) { alert('今天没有要背的词了'); return; }
    showPage('study');
    renderCard();
  }

  function finish() {
    try { localStorage.removeItem('top.session'); } catch (e) {}
    flushProg();
    showPage('done');
    var studied = 0, mastered = 0;
    for (var k in PROG) {
      if (PROG[k] && PROG[k].seen) {
        studied++;
        if ((PROG[k].stage || 0) >= 5) mastered++;
      }
    }
    $('doneInfo').textContent =
      '本组 ' + queue.length + ' 个词次\n' +
      '新词 ' + sessionNew + ' · 复习 ' + sessionReview + (sessionAgain ? ' · 再见 ' + sessionAgain : '') + '\n' +
      '累计学习 ' + studied + ' 词 · 已掌握 ' + mastered + ' 词';
  }

  /* ---------- drawer ---------- */
  function openDrawer() {
    renderDrawer();
    $('drawerMask').classList.add('on');
    $('drawer').classList.add('on');
    $('drawer').setAttribute('aria-hidden', 'false');
    if ($('closeDrawer')) $('closeDrawer').focus();
  }
  function closeDrawer() {
    $('drawerMask').classList.remove('on');
    $('drawer').classList.remove('on');
    $('drawer').setAttribute('aria-hidden', 'true');
  }

  function renderDrawer() {
    $('drPoints').textContent = SIGN.points;
    $('drStreak').textContent = SIGN.streak;
    $('drTotal').textContent = SIGN.total;

    var doneToday = signedToday();
    var contYesterday = signedYesterday();

    // 计算当前这一轮（7 天一个循环）已签到的天数
    // 规则：今天已签 -> streak 就是已签数；昨天签过今天没签 -> streak 已签；
    //       昨天没签（断签）-> 今天从第 1 天重新开始
    var signedCount;        // 本轮已签天数
    var todayIndex = -1;    // 今天对应第几天（1..7），-1 表示今天不能签
    if (doneToday) {
      signedCount = ((SIGN.streak - 1) % 7) + 1;
      todayIndex = signedCount;
    } else if (contYesterday) {
      signedCount = ((SIGN.streak - 1) % 7) + 1;
      todayIndex = signedCount + 1;   // 下一个位置
      if (todayIndex > 7) todayIndex = 1;
    } else {
      signedCount = 0;
      todayIndex = 1;
    }

    var host = $('drDays');
    host.innerHTML = '';
    for (var i = 1; i <= 7; i++) {
      var el = document.createElement('div');
      el.className = 'drs-day';
      if (i <= signedCount) el.classList.add('done');
      if (i === todayIndex && !doneToday) el.classList.add('today');
      if (i === todayIndex && doneToday) el.classList.add('today');

      var base = REWARDS[(i - 1) % 7];
      el.innerHTML = '<div class="d-num">' + i + '</div>' +
                     '<div class="d-pts">+' + base + '</div>';
      host.appendChild(el);
    }

    var btn = $('btnSign');
    if (doneToday) {
      btn.textContent = SIGN.lastJustSigned ? '✓ 签到成功' : '今日已签到';
      btn.disabled = true;
      if (SIGN.lastJustSigned) {
        $('drSignHint').textContent = '+' + (SIGN.days[dateStr(0)] || {}).pts + ' 积分';
      } else {
        $('drSignHint').textContent = '明天再来';
      }
    } else {
      var r = nextReward();
      btn.textContent = '签到领 ' + r.points + ' 积分';
      btn.disabled = false;
      $('drSignHint').textContent = contYesterday
        ? ('已连续 ' + SIGN.streak + ' 天')
        : (SIGN.streak > 0 ? '连续已断，重新开始' : '');
    }
  }

  function handleSign() {
    var r = doSign();
    if (!r.ok) return;
    SIGN.lastJustSigned = true;
    renderDrawer();
    renderHome();
    SIGN.lastJustSigned = false;
  }

  /* ---------- settings ---------- */
  function openSettings() {
    var dlg = $('settingsDlg');
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.id = 'settingsDlg';
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-label', '学习计划');
      dlg.innerHTML =
        '<div class="sheet">' +
          '<div class="sh-title">学习计划</div>' +
          '<div class="row-label">每日新词</div><div class="opts" id="optNew"></div>' +
          '<div class="row-label">每日复习</div><div class="opts" id="optRev"></div>' +
          '<button class="btn-main" id="settingsClose" style="height:46px;font-size:15px">完成</button>' +
        '</div>';
      document.body.appendChild(dlg);
      dlg.addEventListener('click', function (e) { if (e.target === dlg) closeSettings(); });
    }

    var mk = function (host, vals, key, labelFn) {
      host.innerHTML = '';
      vals.forEach(function (v) {
        var b = document.createElement('button');
        b.className = 'opt' + (CFG[key] === v ? ' on' : '');
        b.textContent = labelFn ? labelFn(v) : v;
        b.onclick = function () {
          CFG[key] = v;
          saveCfg();
          openSettings();
          renderHome();
        };
        host.appendChild(b);
      });
    };

    mk($('optNew'), [10, 20, 30, 50, 80], 'newPerDay');
    mk($('optRev'), [10, 20, 30, 50, 100], 'reviewPerDay');

    $('settingsClose').onclick = closeSettings;
    dlg.style.display = 'flex';
    $('settingsClose').focus();
  }
  function closeSettings() {
    var dlg = $('settingsDlg');
    if (dlg) dlg.style.display = 'none';
    renderHome();
  }

  /* ---------- bind ---------- */
  function bind() {
    $('btnStart').onclick = startStudy;
    $('btnClose').onclick = function () { showPage('home'); renderHome(); };
    $('btnVague').onclick = function () { grade(1); };
    $('btnNo').onclick = function () { grade(0); };
    $('btnYes').onclick = function () { grade(2); };
    $('btnCheck').onclick = checkSpelling;
    $('btnSpeak').onclick = function (e) {
      e.stopPropagation();
      if (idx < queue.length) speak(wordOf(queue[idx].wid).sp);
    };
    $('cardArea').onclick = function (e) {
      var t = e.target;
      if (t && (t.id === 'btnSpeak' || t.tagName === 'INPUT')) return;
      reveal();
    };
    $('btnSettings').onclick = openSettings;
    if ($('btnPlan')) $('btnPlan').onclick = openSettings;

    // 抽屉
    if ($('btnDrawer')) $('btnDrawer').onclick = openDrawer;
    if ($('drawerMask')) $('drawerMask').onclick = closeDrawer;
    if ($('btnSign')) $('btnSign').onclick = handleSign;
    if ($('drSettings')) $('drSettings').onclick = function () { closeDrawer(); openSettings(); };
    if ($('drAbout')) $('drAbout').onclick = function () {
      alert('TOP 背单词\n\n保留原有墨墨式阶段复习：认识进阶、模糊保持、不认识回退，模糊和错词当天重现。\n\n词库来自 ECDICT（MIT）。本项目不是墨墨官方产品。\n学习记录保存在当前设备，请定期在设置中备份。在线发音需要网络或系统英文语音。');
    };
    if ($('drReset')) $('drReset').onclick = function () {
      if (confirm('确定清空全部学习记录？积分和签到也会保留，仅清空单词进度。')) {
        PROG = {};
        saveProg();
        try { localStorage.removeItem('top.session'); } catch (e) {}
        ORDER_CACHE = {};
        closeDrawer();
        renderHome();
      }
    };
    $('btnAgain').onclick = startStudy;
    $('btnHome').onclick = function () { showPage('home'); renderHome(); };
    $('inputEl').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); checkSpelling(); }
    });
    document.addEventListener('touchstart', function once() {
      document.removeEventListener('touchstart', once);
      try {
        var a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
        a.volume = 0; a.play().catch(function () {});
      } catch (e) {}
    }, { passive: true });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeDrawer();
        closeSettings();
        if (document.body.dataset.view === 'study') $('btnClose').click();
        return;
      }
      if (document.body.dataset.view !== 'study' || e.repeat || e.ctrlKey || e.metaKey || e.altKey ||
          /INPUT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
      if (e.code === 'Space' && CFG.mode === 0) { e.preventDefault(); reveal(); }
      var shortcut = { '1': 'btnNo', '2': 'btnVague', '3': 'btnYes' }[e.key];
      if (shortcut && CFG.mode === 0) { e.preventDefault(); $(shortcut).click(); }
      if (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'r') { e.preventDefault(); $('btnSpeak').click(); }
    });
    window.addEventListener('pagehide', function () { flushProg(); });
  }

  // 新界面只通过此入口读取数据或触发原有操作，不接管学习调度。
  window.TOP = {
    state: function () {
      if (todayKey !== dayKey()) loadToday();
      return { data: DATA, cfg: CFG, progress: PROG, history: loadHistory(), sign: SIGN, stageDays: STAGE_DAYS.slice(),
        todayDone: todayDone, currentWordId: queue[idx] ? queue[idx].wid : null,
        resumable: DATA ? !!resumableSession() : false };
    },
    selectBook: function (key) {
      if (!DATA || (key !== 'all' && !Object.prototype.hasOwnProperty.call(DATA.books, key))) return;
      CFG.book = key; saveCfg(); renderHome();
    },
    start: startStudy,
    speak: speak,
    plan: openSettings,
    sign: openDrawer,
    closeDrawer: closeDrawer,
    about: function () { $('drAbout').click(); },
    refresh: renderHome,
    flush: flushProg,
    reloadAfterRestore: function () {
      cancelPendingCheck();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      PROG = JSON.parse(localStorage.getItem('top.prog') || '{}');
      window.location.reload();
    }
  };

  /* ---------- boot ---------- */
  var started = Date.now();

  function boot() {
    loadSeed();
    loadCfg();
    loadProg();
    loadToday();
    loadSign();
    bind();
    initVoice();

    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/words.json', true);
    xhr.onload = function () {
      try {
        if (xhr.status !== 200) throw new Error('词库请求失败');
        DATA = JSON.parse(xhr.responseText);
        if (!Array.isArray(DATA.words) || !DATA.books || !DATA.names) throw new Error('词库格式错误');
      } catch (e) {
        $('splash').innerHTML =
          '<div style="font-size:14px;color:#d9534f;text-align:center;padding:24px">词库加载失败</div>';
        return;
      }
      setTimeout(function () {
        var sp = $('splash');
        sp.classList.add('out');
        setTimeout(function () {
          sp.style.display = 'none';
          showPage('library');
          renderHome();
        }, 220);
      }, Math.max(0, 450 - (Date.now() - started)));
    };
    xhr.onerror = function () {
      $('splash').innerHTML =
        '<div style="font-size:14px;color:#d9534f;text-align:center;padding:24px">词库加载失败</div>';
    };
    xhr.send();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
