/* 页面与辅助功能；所有学习操作仍由 app.js 的原有阶段调度处理。 */
(function () {
  'use strict';
  var api = window.TOP;
  var $ = function (id) { return document.getElementById(id); };
  var view = 'library';
  var libraryTab = 'all';
  var filter = 'all';
  var wordContext = 'mistakes';
  var wordBook = null;
  var wordLimit = 50;
  var toastTimer;
  var searchTimer;
  var detailWord = null;
  var favorites = new Set();
  var BOOKS = [
    { key: 'cet4', title: 'CET-4', name: '大学英语四级', group: 'cet', tag: '大学英语', color: '#b7c9a0', deep: '#8fa77a', cover: '4' },
    { key: 'cet6', title: 'CET-6', name: '大学英语六级', group: 'cet', tag: '进阶备考', color: '#d7cfb3', deep: '#b8af90', cover: '6' },
    { key: 'ielts', title: 'IELTS', name: '雅思英语', group: 'ielts', tag: '留学语言', color: '#b9caca', deep: '#92adab', cover: 'I' },
    { key: 'toefl', title: 'TOEFL', name: '托福英语', group: 'toefl', tag: '留学语言', color: '#c3c8db', deep: '#a1a9c5', cover: 'T' },
    { key: 'ky', title: '考研英语', name: '为下一段旅程蓄力', group: 'other', tag: '升学备考', color: '#d7c2b3', deep: '#bda28d', cover: '研' },
    { key: 'gre', title: 'GRE', name: '探索词汇的更多可能', group: 'other', tag: '留学进阶', color: '#bdc7af', deep: '#9eaf8a', cover: 'G' },
    { key: 'gk', title: '高考英语', name: '巩固基础，继续向前', group: 'other', tag: '基础词汇', color: '#d5ccba', deep: '#b9ad96', cover: '高' },
    { key: 'zk', title: '中考英语', name: '从基础词汇开始', group: 'other', tag: '基础词汇', color: '#c7d6ba', deep: '#a4bb92', cover: '初' },
    { key: 'all', title: '全部单词', name: '把更大的世界装进词库', group: 'other', tag: '综合词库', color: '#bbc9bd', deep: '#8da48f', cover: 'A' }
  ];
  var BACKUP_KEYS = ['top.cfg', 'top.prog', 'top.today', 'top.hist', 'top.sign', 'top.favorites', 'top.session', 'top.seed'];
  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name) { return '<svg class="icon" aria-hidden="true"><use href="#icon-' + name + '"></use></svg>'; }
  function text(id, value) { if ($(id)) $(id).textContent = value; }
  function toast(message) {
    if (!$('toast')) return;
    $('toast').textContent = message;
    $('toast').classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').classList.remove('on'); }, 3200);
  }
  function bookInfo(key) { return BOOKS.find(function (b) { return b.key === key; }) || BOOKS[0]; }
  function bookIds(key, data) {
    return key === 'all' ? data.words.map(function (_, i) { return i; }) : (data.books[key] || []);
  }
  function loadFavorites() {
    try {
      var values = JSON.parse(localStorage.getItem('top.favorites') || '[]');
      favorites = new Set(Array.isArray(values) ? values.filter(function (id) { return Number.isInteger(id) && id >= 0; }) : []);
    } catch (e) { favorites = new Set(); }
  }
  function updateSummary(state) {
    var current = bookInfo(state.cfg.book);
    var mode = ['认词', '听写', '拼写'][state.cfg.mode];
    var goal = state.cfg.newPerDay + state.cfg.reviewPerDay;
    var values = {
      'data-current-book': current.title,
      'data-current-mode': mode,
      'data-today-count': state.todayDone,
      'data-goal-count': goal,
      'data-favorite-count': favorites.size,
      'data-streak': state.sign.last === localDay() || state.sign.last === localDay(-1) ? state.sign.streak : 0,
      'data-total-studied': Object.keys(state.progress).filter(function (id) { return state.progress[id].seen > 0; }).length,
      'data-mistake-count': Object.keys(state.progress).filter(function (id) { return state.progress[id].wrong > 0; }).length
    };
    Object.keys(values).forEach(function (attr) {
      document.querySelectorAll('[' + attr + ']').forEach(function (el) { el.textContent = values[attr]; });
    });
    document.querySelectorAll('[data-day-progress]').forEach(function (el) {
      el.style.width = Math.min(100, state.todayDone / Math.max(1, goal) * 100) + '%';
    });
    text('libraryBookName', current.title);
    text('libraryModeName', mode);
    var startLabel = state.resumable ? '继续学习' : '开始学习';
    ['libraryStart', 'btnStart'].forEach(function (id) {
      if (!$(id)) return;
      $(id).innerHTML = escapeHTML(startLabel) + icon('arrow');
    });
    if ($('starStudyWord') && state.currentWordId !== null) {
      var saved = favorites.has(state.currentWordId);
      $('starStudyWord').setAttribute('aria-pressed', String(saved));
      $('starStudyWord').setAttribute('aria-label', saved ? '取消收藏当前单词' : '收藏当前单词');
    }
  }
  function cover(book) {
    return '<svg class="book-art" aria-hidden="true" viewBox="0 0 75 100">' +
      '<rect x="7" y="5" width="61" height="88" rx="3" fill="' + book.color + '"/>' +
      '<path d="M13 5v88" stroke="' + book.deep + '"/>' +
      '<text x="39" y="28" fill="#fafbf1" font-family="Georgia,serif" font-size="11" text-anchor="middle">' + escapeHTML(book.title.length > 7 ? 'WORDS' : book.title) + '</text>' +
      '<text x="39" y="66" fill="#fafbf1" font-family="Georgia,serif" font-size="36" text-anchor="middle">' + book.cover + '</text>' +
      '<path d="M20 79h36M20 84h24" stroke="#f6f8ec" opacity=".6" stroke-width="1.5"/></svg>';
  }
  function renderBooks(state) {
    var query = $('bookSearch').value.trim().toLowerCase();
    var visible = BOOKS.filter(function (book) {
      if (filter !== 'all' && book.group !== filter) return false;
      if (query && (book.title + book.name + book.tag).toLowerCase().indexOf(query) === -1) return false;
      if (libraryTab === 'mine' && book.key !== state.cfg.book &&
          !bookIds(book.key, state.data).some(function (id) { return state.progress[id] && state.progress[id].seen; })) return false;
      return true;
    });
    text('libraryCount', visible.length);
    $('libraryEmpty').classList.toggle('hidden', visible.length > 0);
    $('bookGrid').innerHTML = visible.map(function (book) {
      var selected = state.cfg.book === book.key;
      var ids = bookIds(book.key, state.data);
      var studied = ids.filter(function (id) { return state.progress[id] && state.progress[id].seen; }).length;
      return '<button type="button" class="book-card' + (selected ? ' current-book' : '') + '" data-book="' + book.key + '" aria-pressed="' + selected + '" aria-label="选择' + escapeHTML(book.title) + '词书">' +
        '<span class="book-tag">' + (selected ? icon('check') + '当前词书' : book.tag) + '</span>' +
        '<span class="book-name">' + escapeHTML(book.title) + '</span>' +
        '<span class="book-subtitle">' + escapeHTML(book.name) + '</span>' +
        '<span class="book-count"><strong>' + ids.length.toLocaleString() + '</strong> 词</span>' + cover(book) +
        '<span class="book-footer"><span>' + (studied ? '已学 ' + studied + ' 词' : (selected ? '已学 0 词 · 现在出发' : '尚未开始')) + '</span>' + icon('arrow') + '</span></button>';
    }).join('');
    document.querySelectorAll('[data-library]').forEach(function (button) {
      button.classList.toggle('selected', button.dataset.library === libraryTab);
      button.setAttribute('aria-pressed', String(button.dataset.library === libraryTab));
    });
    document.querySelectorAll('[data-filter]').forEach(function (button) {
      button.classList.toggle('current', button.dataset.filter === filter);
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    });
  }
  function navigate(next) {
    if (!api.state().data) return;
    var allowed = ['home', 'library', 'mistakes', 'favorites', 'words', 'stats', 'settings', 'study', 'done'];
    if (allowed.indexOf(next) < 0) next = 'library';
    view = next;
    document.body.dataset.view = next;
    var targets = { libraryView: 'library', home: 'home', statsView: 'stats', settingsView: 'settings' };
    Object.keys(targets).forEach(function (id) { $(id).classList.toggle('hidden', next !== targets[id]); });
    $('wordsView').classList.toggle('hidden', ['mistakes', 'favorites', 'words'].indexOf(next) < 0);
    $('study').classList.toggle('hidden', next !== 'study');
    $('done').classList.toggle('hidden', next !== 'done');
    if (next === 'mistakes' || next === 'favorites') {
      wordContext = next; wordLimit = 50; $('wordSearch').value = '';
    }
    document.querySelectorAll('[data-view]').forEach(function (button) {
      if (button === document.body) return;
      var current = button.dataset.view === next || (next === 'words' && button.dataset.view === 'library');
      button.classList.toggle('active', current);
      if (current) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    var labels = { home: '今日学习', library: '词库', mistakes: '错词本', favorites: '我的收藏', words: '单词表', stats: '学习统计', settings: '学习设置' };
    text('viewTitle', labels[next] || '专注学习');
    refresh();
    if (next !== 'study' && next !== 'done') window.scrollTo(0, 0);
  }
  function renderWords(state) {
    var ids;
    if (wordContext === 'book') ids = bookIds(wordBook, state.data);
    else if (wordContext === 'favorites') ids = Array.from(favorites).filter(function (id) { return !!state.data.words[id]; });
    else ids = Object.keys(state.progress).filter(function (id) { return state.progress[id].wrong > 0 && state.data.words[id]; }).map(Number)
      .sort(function (a, b) { return state.progress[b].last - state.progress[a].last; });
    var query = $('wordSearch').value.trim().toLowerCase();
    ids = ids.filter(function (id) {
      var word = state.data.words[id];
      return !query || (word[0] + ' ' + word[2]).toLowerCase().indexOf(query) >= 0;
    });
    var title = wordContext === 'book' ? bookInfo(wordBook).title + ' · 单词表' : (wordContext === 'favorites' ? '喜欢的词，留在这里。' : '再见一面，就更熟悉一点。');
    text('wordListTitle', title);
    text('wordListCount', ids.length.toLocaleString() + ' 个单词');
    if ($('wordListSubtitle')) $('wordListSubtitle').textContent = wordContext === 'mistakes' ? '收录学习中曾答错的单词，复习仍按原来的计划安排。' :
      (wordContext === 'favorites' ? '随手收藏，慢慢积累属于你的词汇。' : '浏览释义、播放发音，也可以收藏想多看一眼的词。');
    $('wordListEmpty').classList.toggle('hidden', ids.length > 0);
    if (!ids.length) $('wordListEmpty').innerHTML = '<img src="assets/mascot.svg" width="126" height="136" alt="" aria-hidden="true"><h3>' +
      (query ? '暂时没有找到这个词' : (wordContext === 'favorites' ? '收藏夹在等你的第一个单词' : '这里还没有单词')) +
      '</h3><p>' + (query ? '换个拼写或中文释义试试。' : (wordContext === 'favorites' ? '学习时点一下星星，就能把单词留在这里。' : '按照自己的节奏开始学习吧。')) + '</p>';
    $('wordList').innerHTML = ids.slice(0, wordLimit).map(function (id) {
      var word = state.data.words[id];
      var saved = favorites.has(id);
      return '<div class="word-row"><button type="button" class="word-row-main" data-word="' + id + '" data-action="detail"><span class="word-spelling">' + escapeHTML(word[0]) +
        '</span><span class="word-meaning">' + escapeHTML(word[2]) + '</span></button><div class="word-row-actions">' +
        '<button type="button" class="icon-button" data-word="' + id + '" data-action="speak" aria-label="播放' + escapeHTML(word[0]) + '的发音">' + icon('volume') + '</button>' +
        '<button type="button" class="icon-button" data-word="' + id + '" data-action="star" aria-pressed="' + saved + '" aria-label="' + (saved ? '取消收藏' : '收藏') + escapeHTML(word[0]) + '">' + icon('star') + '</button></div></div>';
    }).join('');
    $('wordMore').classList.toggle('hidden', ids.length <= wordLimit);
    $('wordMore').textContent = '再显示 ' + Math.min(50, Math.max(0, ids.length - wordLimit)) + ' 个单词';
  }
  function toggleFavorite(id) {
    var next = new Set(favorites);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem('top.favorites', JSON.stringify(Array.from(next))); }
    catch (e) { toast('收藏没有保存成功，请先导出学习记录，再检查浏览器存储空间。'); return; }
    favorites = next;
    toast(next.has(id) ? '已收藏这个单词' : '已取消收藏');
    refresh();
    if ($('wordDialog').open && detailWord !== null) showWord(detailWord);
  }
  function showWord(id) {
    var state = api.state();
    var word = state.data.words[id];
    if (!word) return;
    detailWord = id;
    var progress = state.progress[id];
    var status = !progress ? '未学习' : (progress.stage >= 5 ? '已掌握' : '学习中');
    var nextReview = progress ? (progress.due <= Date.now() ? '已到复习时间' : '下次复习：' + new Date(progress.due).toLocaleDateString('zh-CN')) : '从学习计划中开始认识这个词';
    $('wordDetailContent').innerHTML = '<div class="detail-label">' + status + '</div><h2 class="detail-word" id="wordDialogTitle">' + escapeHTML(word[0]) + '</h2>' +
      '<div class="detail-phon">' + (word[1] ? '/' + escapeHTML(word[1]) + '/' : '') + '</div>' +
      '<div class="detail-meaning">' + escapeHTML(word[2]) + '</div>' +
      (word[3] ? '<div class="detail-definition">' + escapeHTML(word[3]) + '</div>' : '') +
      '<p class="detail-review">' + nextReview + '</p><div class="detail-actions">' +
      '<button type="button" class="secondary-button" data-word="' + id + '" data-action="speak">' + icon('volume') + '播放发音</button>' +
      '<button type="button" class="secondary-button" data-word="' + id + '" data-action="star" aria-pressed="' + favorites.has(id) + '">' + icon('star') + (favorites.has(id) ? '已收藏' : '收藏单词') + '</button></div>';
    if (!$('wordDialog').open) $('wordDialog').showModal();
  }
  function refresh() {
    var state = api.state();
    if (!state.data) return;
    updateSummary(state);
    if (view === 'library') renderBooks(state);
    if (['words', 'mistakes', 'favorites'].indexOf(view) >= 0) renderWords(state);
  }
  function localDay(offset) {
    var date = new Date();
    date.setDate(date.getDate() + (offset || 0));
    return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
  }
  function exportBackup() {
    api.flush();
    var state = api.state();
    var data = {
      'top.cfg': state.cfg, 'top.prog': state.progress, 'top.hist': state.history,
      'top.sign': state.sign, 'top.favorites': Array.from(favorites),
      'top.today': { day: localDay(), n: state.todayDone }
    };
    // 顺序种子跟着备份走，换设备恢复后仍是自己那套独一无二的乱序。
    try {
      var seed = localStorage.getItem('top.seed');
      if (seed) data['top.seed'] = seed;
    } catch (e) { /* 读不到种子时只导出长期记录。 */ }
    try {
      var session = localStorage.getItem('top.session');
      if (session) data['top.session'] = JSON.parse(session);
    } catch (e) { /* 无可用续学记录时只导出长期记录。 */ }
    var contents = JSON.stringify({ format: 'top-backup', version: 1, exportedAt: new Date().toISOString(), data: data }, null, 2);
    var filename = 'TOP-学习备份-' + localDay() + '.json';
    if (window.TOPAndroid && typeof window.TOPAndroid.saveBackup === 'function') {
      text('backupStatus', '请选择备份文件的保存位置…');
      try { window.TOPAndroid.saveBackup(contents, filename); }
      catch (e) { text('backupStatus', '未能打开保存窗口，请重试。'); }
      return;
    }
    var url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
    var link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    text('backupStatus', '备份已导出，请保存好下载的 JSON 文件。');
  }
  function validateBackup(payload, data) {
    var object = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
    var count = function (v) { return Number.isSafeInteger(v) && v >= 0; };
    var dateKey = function (v) {
      if (typeof v !== 'string' || !/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return false;
      var parts = v.split('-').map(Number);
      var date = new Date(parts[0], parts[1] - 1, parts[2]);
      return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2];
    };
    var validBook = function (key) { return key === 'all' || Object.prototype.hasOwnProperty.call(data.books, key); };
    var validWord = function (id) { return Number.isInteger(id) && id >= 0 && id < data.words.length; };
    if (!object(payload) || payload.format !== 'top-backup' || payload.version !== 1 || !object(payload.data)) throw new Error('这不是 TOP 导出的有效备份文件。');
    var saved = payload.data;
    if (Object.keys(saved).some(function (key) { return BACKUP_KEYS.indexOf(key) < 0; })) throw new Error('备份包含不支持的数据项。');
    var cfg = saved['top.cfg'];
    if (!object(cfg) || !validBook(cfg.book) || [0, 1, 2].indexOf(cfg.mode) < 0 ||
        [10, 20, 30, 50, 80].indexOf(cfg.newPerDay) < 0 || [10, 20, 30, 50, 100].indexOf(cfg.reviewPerDay) < 0 ||
        [0, 1].indexOf(cfg.autoSpeak) < 0 || !object(cfg.orders) ||
        Object.keys(cfg.orders).some(function (key) { return !validBook(key) || [0, 1].indexOf(cfg.orders[key]) < 0; })) throw new Error('备份中的学习设置无效。');
    var prog = saved['top.prog'];
    if (!object(prog) || Object.keys(prog).some(function (id) {
      var p = prog[id];
      return !/^\d+$/.test(id) || String(Number(id)) !== id || !validWord(Number(id)) || !object(p) || !Number.isInteger(p.stage) || p.stage < 0 || p.stage > 9 ||
        !['seen', 'right', 'wrong', 'due', 'last'].every(function (key) { return count(p[key]); }) || p.due > 8640000000000000 || p.last > 8640000000000000;
    })) throw new Error('备份中的单词进度无效。');
    var today = saved['top.today'];
    if (!object(today) || !dateKey(today.day) || !count(today.n)) throw new Error('备份中的今日记录无效。');
    var history = saved['top.hist'];
    if (!object(history) || Object.keys(history).some(function (key) { return !dateKey(key) || !count(history[key]); })) throw new Error('备份中的学习历史无效。');
    var sign = saved['top.sign'];
    if (!object(sign) || (sign.last !== '' && !dateKey(sign.last)) || !['streak', 'points', 'total'].every(function (key) { return count(sign[key]); }) || !object(sign.days) ||
        Object.keys(sign.days).some(function (key) { return !dateKey(key) || !object(sign.days[key]) || !count(sign.days[key].streak) || !count(sign.days[key].pts); })) throw new Error('备份中的签到记录无效。');
    if (!Array.isArray(saved['top.favorites']) || !saved['top.favorites'].every(validWord)) throw new Error('备份中的收藏记录无效。');
    var seed = saved['top.seed'];
    if (seed !== undefined && (typeof seed !== 'string' || !/^[0-9a-z]{16,}$/.test(seed))) throw new Error('备份中的顺序种子无效。');
    var session = saved['top.session'];
    var sessionWords = session && validBook(session.book) && session.book !== 'all' ? new Set(data.books[session.book]) : null;
    if (session !== undefined && (!object(session) || !dateKey(session.day) || !validBook(session.book) || [0, 1, 2].indexOf(session.mode) < 0 ||
        !Array.isArray(session.queue) || session.queue.length > 100000 || !count(session.idx) || session.idx >= session.queue.length ||
        !['sessionNew', 'sessionReview', 'sessionAgain'].every(function (key) { return count(session[key]); }) ||
        !session.queue.every(function (item) { return object(item) && validWord(item.wid) && (!sessionWords || sessionWords.has(item.wid)) && typeof item.isReview === 'boolean' && (item.isAgain === undefined || typeof item.isAgain === 'boolean'); }))) throw new Error('备份中的续学记录无效。');
    return saved;
  }
  async function importBackup(file) {
    if (!file) return;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('文件过大，请选择 TOP 导出的 JSON 备份。');
      var saved = validateBackup(JSON.parse(await file.text()), api.state().data);
      if (!window.confirm('恢复备份将替换当前设备的学习记录、设置和收藏。建议先导出当前记录。确定恢复吗？')) return;
      api.flush();
      var old = {};
      BACKUP_KEYS.forEach(function (key) { old[key] = localStorage.getItem(key); });
      try {
        BACKUP_KEYS.forEach(function (key) {
          if (saved[key] === undefined) localStorage.removeItem(key);
          // top.seed 存的是裸字符串，其余键存 JSON。
          else if (key === 'top.seed') localStorage.setItem(key, saved[key]);
          else localStorage.setItem(key, JSON.stringify(saved[key]));
        });
      } catch (error) {
        BACKUP_KEYS.forEach(function (key) { localStorage.removeItem(key); });
        BACKUP_KEYS.forEach(function (key) {
          if (old[key] === null) localStorage.removeItem(key); else localStorage.setItem(key, old[key]);
        });
        throw new Error('浏览器未能保存备份，已尝试恢复原记录，请检查存储空间。');
      }
      // pagehide 的旧内存进度不能覆盖刚恢复的备份。
      api.reloadAfterRestore();
    } catch (error) { text('backupStatus', error instanceof SyntaxError ? '文件不是有效的 JSON，请选择完整的备份文件。' : error.message); }
    finally { $('importFile').value = ''; }
  }
  function init() {
    loadFavorites();
    document.querySelectorAll('button[data-view]').forEach(function (button) {
      button.addEventListener('click', function () { navigate(button.dataset.view); });
    });
    $('bookGrid').addEventListener('click', function (event) {
      var card = event.target.closest('[data-book]');
      if (!card) return;
      api.selectBook(card.dataset.book);
      toast('已选择《' + bookInfo(card.dataset.book).title + '》');
    });
    document.querySelectorAll('[data-filter]').forEach(function (button) {
      button.addEventListener('click', function () { filter = button.dataset.filter; refresh(); });
    });
    document.querySelectorAll('[data-library]').forEach(function (button) {
      button.addEventListener('click', function () { libraryTab = button.dataset.library; refresh(); });
    });
    $('bookSearch').addEventListener('input', refresh);
    $('libraryStart').addEventListener('click', function () { api.start(); });
    $('browseCurrentBook').addEventListener('click', function () {
      wordContext = 'book'; wordBook = api.state().cfg.book; wordLimit = 50;
      $('wordSearch').value = ''; navigate('words');
    });
    $('wordBack').addEventListener('click', function () { navigate('library'); });
    $('wordSearch').addEventListener('input', function () {
      clearTimeout(searchTimer); wordLimit = 50; searchTimer = setTimeout(refresh, 120);
    });
    $('wordMore').addEventListener('click', function () { wordLimit += 50; refresh(); });
    function wordAction(event) {
      var button = event.target.closest('[data-action][data-word]');
      if (!button) return;
      var id = Number(button.dataset.word);
      var word = api.state().data.words[id];
      if (!word) return;
      if (button.dataset.action === 'detail') showWord(id);
      if (button.dataset.action === 'speak') api.speak(word[0]);
      if (button.dataset.action === 'star') toggleFavorite(id);
    }
    $('wordList').addEventListener('click', wordAction);
    $('wordDetailContent').addEventListener('click', wordAction);
    $('closeWordDialog').addEventListener('click', function () { $('wordDialog').close(); });
    $('wordDialog').addEventListener('click', function (event) { if (event.target === $('wordDialog')) $('wordDialog').close(); });
    $('starStudyWord').addEventListener('click', function () {
      var id = api.state().currentWordId;
      if (id !== null) toggleFavorite(id);
    });
    $('cardArea').addEventListener('keydown', function (event) {
      if (event.target !== $('cardArea')) return;
      if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); event.stopPropagation(); $('cardArea').click(); }
    });
    $('openPlanSettings').addEventListener('click', function () { api.plan(); });
    $('aboutApp').addEventListener('click', function () { api.about(); });
    $('mobileSign').addEventListener('click', function () { api.sign(); });
    $('closeDrawer').addEventListener('click', function () { api.closeDrawer(); });
    $('exportData').addEventListener('click', exportBackup);
    window.addEventListener('top:backup-export', function (event) {
      var status = event.detail && event.detail.status;
      text('backupStatus', status === 'saved' ? '备份已保存，请保管好 JSON 文件。' :
        status === 'cancelled' ? '已取消导出，学习记录仍保存在本机。' : '备份未能保存，请重试或选择其他位置。');
    });
    $('importData').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () { importBackup($('importFile').files[0]); });
    window.addEventListener('top:change', refresh);
    window.addEventListener('top:view', function () { navigate(document.body.dataset.view); });
    window.addEventListener('top:storage-error', function () { toast('学习记录未能保存，请在设置中导出备份，并检查浏览器存储空间。'); });
    window.addEventListener('storage', function (event) { if (event.key === 'top.favorites') { loadFavorites(); refresh(); } });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && view !== 'study') api.refresh();
    });
    if (window.TOPAndroid || 'serviceWorker' in navigator) {
      var offlineNote = document.createElement('p');
      offlineNote.id = 'offlineStatus'; offlineNote.className = 'setting-help';
      $('backupStatus').after(offlineNote);
      if (window.TOPAndroid) {
        offlineNote.textContent = '软件内置界面与词库，可离线背词。离线发音需要系统已安装英语语音。';
      } else {
      offlineNote.textContent = '正在准备离线词库…';
      navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function () {
        text('offlineStatus', '界面与词库已可离线使用。备用在线发音仍需要网络。');
      }).catch(function () { text('offlineStatus', '离线缓存暂不可用，请保持联网使用。'); });
      }
    }
    if ($('installApp') && window.TOPAndroid) $('installApp').classList.add('hidden');
    if (api.state().data) navigate('library');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
