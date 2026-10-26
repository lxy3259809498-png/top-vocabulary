/* 只读取原有阶段与到期记录；示意线条不参与学习评分或复习调度。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var horizon = 30;
  var selectedDay = null;
  var PLOT = { left: 48, right: 786, top: 30, bottom: 254 };

  function reviewSchedule(intervals, days) {
    var result = [], elapsed = 0, stage = 1;
    if (!Array.isArray(intervals) || intervals.length < 2) return result;
    while (result.length < 1000) {
      var gap = intervals[Math.min(stage, intervals.length - 1)];
      if (!Number.isFinite(gap) || gap <= 0 || elapsed + gap > days) break;
      elapsed += gap;
      result.push({ day: elapsed, gap: gap, number: result.length + 1 });
      stage++;
    }
    return result;
  }
  function retention(elapsed, repetitions) {
    // 仅为示意图选用的平滑衰减与强化参数，不是个人记忆率的拟合结果。
    return 100 * Math.exp(-Math.sqrt(Math.max(0, elapsed) / (3 * Math.pow(2.5, repetitions))));
  }
  function curveSamples(days, reviews) {
    var times = new Set([0, days]);
    for (var step = 0; step <= 240; step++) times.add(days * step / 240);
    reviews.forEach(function (review) { times.add(review.day); });
    var result = [], lastReview = 0, repetitions = 0, nextReview = 0;
    Array.from(times).sort(function (a, b) { return a - b; }).forEach(function (day) {
      result.push({ day: day, value: retention(day - lastReview, repetitions) });
      if (reviews[nextReview] && day === reviews[nextReview].day) {
        lastReview = day; repetitions++; nextReview++;
        result.push({ day: day, value: 100 });
      }
    });
    return result;
  }
  function pathFor(samples, days) {
    return samples.map(function (point, index) {
      var x = PLOT.left + point.day / days * (PLOT.right - PLOT.left);
      var y = PLOT.bottom - point.value / 100 * (PLOT.bottom - PLOT.top);
      return (index ? 'L' : 'M') + x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' ');
  }
  function dueForecast(state, now) {
    var start = new Date(now);
    start.setHours(0, 0, 0, 0);
    var boundaries = [];
    for (var day = 0; day <= 7; day++) {
      var date = new Date(start); date.setDate(date.getDate() + day);
      boundaries.push(date.getTime());
    }
    var counts = [0, 0, 0, 0, 0, 0, 0], overdue = 0, scheduled = 0;
    if (!state.data) return { counts: counts, overdue: overdue, scheduled: scheduled, boundaries: boundaries };
    var ids = state.cfg.book === 'all' ? Object.keys(state.progress).map(Number) : (state.data.books[state.cfg.book] || []);
    ids.forEach(function (id) {
      var progress = state.progress[id];
      if (!progress || !progress.seen || !Number.isFinite(progress.due)) return;
      if (progress.due <= now) { overdue++; return; }
      for (var index = 0; index < 7; index++) {
        if (progress.due >= boundaries[index] && progress.due < boundaries[index + 1]) {
          counts[index]++; scheduled++; break;
        }
      }
    });
    return { counts: counts, overdue: overdue, scheduled: scheduled, boundaries: boundaries };
  }
  function renderCurve(state) {
    var width = Math.max(280, $('memoryCurvePlot').clientWidth || 820);
    PLOT.right = width - 16;
    PLOT.bottom = width < 540 ? 218 : 254;
    var reviews = reviewSchedule(state.stageDays, horizon);
    var withoutReview = pathFor(curveSamples(horizon, []), horizon);
    var withReview = pathFor(curveSamples(horizon, reviews), horizon);
    var grid = [0, 25, 50, 75, 100].map(function (value) {
      var y = PLOT.bottom - value / 100 * (PLOT.bottom - PLOT.top);
      return '<line class="curve-gridline" x1="48" x2="' + PLOT.right + '" y1="' + y + '" y2="' + y + '"/>' +
        '<text class="curve-tick" x="36" y="' + (y + 4) + '" text-anchor="end">' + value + '</text>';
    }).join('');
    var ticks = (horizon === 30 ? [0, 7, 14, 21, 30] : [0, 15, 30, 45, 60]).map(function (day) {
      var x = PLOT.left + day / horizon * (PLOT.right - PLOT.left);
      return '<text class="curve-tick" x="' + x + '" y="' + (PLOT.bottom + 24) + '" text-anchor="' + (day === 0 ? 'start' : day === horizon ? 'end' : 'middle') + '">' + day + ' 天</text>';
    }).join('');
    var markers = reviews.map(function (review) {
      var x = PLOT.left + review.day / horizon * (PLOT.right - PLOT.left);
      return '<circle class="curve-review-node' + (selectedDay === review.day ? ' selected' : '') + '" cx="' + x + '" cy="30" r="4.5" data-review-day="' + review.day + '"/>';
    }).join('');
    var guide = selectedDay !== null ? '<line class="curve-guide" x1="' + (PLOT.left + selectedDay / horizon * (PLOT.right - PLOT.left)) +
      '" x2="' + (PLOT.left + selectedDay / horizon * (PLOT.right - PLOT.left)) + '" y1="30" y2="' + PLOT.bottom + '"/>' : '';
    $('memoryCurvePlot').innerHTML = '<svg viewBox="0 0 ' + width + ' ' + (PLOT.bottom + 46) + '" role="img" aria-labelledby="memoryCurveTitle memoryCurveDescription">' +
      '<title id="memoryCurveTitle">艾宾浩斯遗忘规律与间隔复习示意</title>' +
      '<desc id="memoryCurveDescription">虚线表示未经复习时逐渐遗忘，实线表示按原有间隔复习后恢复并逐渐稳定。复习节点为学习后第' + reviews.map(function (r) { return r.day; }).join('、') + '天。数值不是个人实际记忆率。</desc>' +
      '<text class="curve-axis-label" x="48" y="14">相对记忆保持（示意）</text>' + grid +
      '<path class="curve-area" d="' + withReview + ' L' + PLOT.right + ',' + PLOT.bottom + ' L48,' + PLOT.bottom + ' Z"/>' +
      '<path class="curve-line curve-line-unreviewed" d="' + withoutReview + '"/>' + guide +
      '<path class="curve-line curve-line-reviewed" d="' + withReview + '"/>' + markers + ticks + '</svg>';
    $('curveReviewNodes').innerHTML = reviews.map(function (review) {
      return '<button type="button" class="curve-node-button' + (selectedDay === review.day ? ' selected' : '') +
        '" data-review-day="' + review.day + '" aria-pressed="' + (selectedDay === review.day) + '"><span>第 ' + review.day + ' 天</span><small>间隔 ' + review.gap + ' 天</small></button>';
    }).join('');
    document.querySelectorAll('[data-curve-range]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.curveRange) === horizon));
    });
    var selected = reviews.find(function (review) { return review.day === selectedDay; });
    $('curveSelection').textContent = selected ? '第 ' + selected.day + ' 天，第 ' + selected.number + ' 次复习；距离上次 ' + selected.gap + ' 天。' : '点选下方节点，查看原有计划中的复习间隔。';
  }
  function renderForecast(state) {
    var forecast = dueForecast(state, Date.now());
    var maxCount = Math.max.apply(Math, [1].concat(forecast.counts));
    var bookName = state.cfg.book === 'all' ? '全部单词' : ((state.data && state.data.names[state.cfg.book]) || '当前词书');
    $('forecastBook').textContent = bookName;
    $('forecastOverdue').textContent = forecast.overdue;
    $('forecastScheduled').textContent = forecast.scheduled;
    $('reviewForecast').innerHTML = forecast.counts.map(function (count, index) {
      var date = new Date(forecast.boundaries[index]);
      var label = index === 0 ? '今天' : (index === 1 ? '明天' : (date.getMonth() + 1) + '/' + date.getDate());
      return '<div class="forecast-day" aria-label="' + label + '尚未到期、已排定复习' + count + '词"><span class="forecast-number">' + count + '</span>' +
        '<div class="forecast-track"><i style="height:' + (count ? Math.max(5, count / maxCount * 100) : 0) + '%"></i></div><span class="forecast-label">' + label + '</span></div>';
    }).join('');
    $('forecastEmpty').classList.toggle('hidden', forecast.overdue > 0 || forecast.scheduled > 0);
    $('forecastEmpty').textContent = '接下来七天暂无已排定的复习。学习后，这里会按你的作答更新。';
  }
  function render() {
    if (!$('memoryCurvePlot') || !window.TOP) return;
    var state = window.TOP.state();
    renderCurve(state);
    renderForecast(state);
  }
  function selectReview(event) {
    var button = event.target.closest('[data-review-day]');
    if (!button) return;
    selectedDay = Number(button.dataset.reviewDay);
    render();
    // 更新后仍把键盘焦点放回用户选择的按钮。
    var selected = $('curveReviewNodes').querySelector('[data-review-day="' + selectedDay + '"]');
    if (selected && event.target.closest('button')) selected.focus();
  }
  function init() {
    if (!$('memoryCurvePlot')) return;
    document.querySelectorAll('[data-curve-range]').forEach(function (button) {
      button.addEventListener('click', function () {
        horizon = Number(button.dataset.curveRange);
        if (selectedDay > horizon) selectedDay = null;
        render();
      });
    });
    $('curveReviewNodes').addEventListener('click', selectReview);
    $('memoryCurvePlot').addEventListener('click', selectReview);
    window.addEventListener('top:change', function () { if (document.body.dataset.view === 'stats') render(); });
    window.addEventListener('top:view', function () { if (document.body.dataset.view === 'stats') render(); });
    window.addEventListener('resize', function () { if (document.body.dataset.view === 'stats') render(); });
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
