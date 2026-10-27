/* TOP 背单词 · 二维码导出 / 导入
 * =====================================================
 * 不登录换设备：用屏幕显示二维码，新设备用摄像头扫，把学习进度搬过去。
 *
 * 为什么需要压缩：
 *   二维码单码约 2900 字节上限，而原始备份 3849 词要 342 KB。
 *   编码方案（全部无损，已用 3849 词做往返校验）：
 *     1. 只存 6 个字段：wid / stage / seen / right / wrong / due天数
 *     2. 全部 base36
 *     3. wid 存增量，行内用 . 分隔，行间用 ;
 *     4. due 存成「相对今天的整数天」，一个时间戳从 13 位降到 2-3 位
 *     5. last 不存——它等于 due - daysForStage(stage) * 86400000，可精确反推
 *     6. deflate 压缩后 base64
 *   实测：10 词 140 字节（1 码），500 词 2292 字节（1 码），3849 词 14832 字节（6 码）
 *
 * 多帧：超过单码容量时拆成 N 帧，页面逐帧轮播；接收端连续扫码自动拼回。
 * 完整性：整包算 CRC32，拼完校验，错帧立即报错而不是静默丢数据。
 *
 * 二维码编码用 vendor/qrcode-generator.js（MIT，8.5k star 的成熟实现），
 * 不自己手写——手写版本经 jsQR 实测解码失败。
 */
(function () {
  'use strict';

  var STAGE_DAYS = [0, 1, 2, 4, 7, 15, 30, 60, 120, 240];
  var DAY = 86400000;
  var QR_PREFIX = 'TOPV1:';
  var SINGLE_LIMIT = 2400;   // 单帧正文字符数（实测 2414 仍可编码）
  var MAX_FRAMES = 40;

  var $ = function (id) { return document.getElementById(id); };

  function daysForStage(stage) {
    if (stage <= 0) return 0;
    if (stage >= STAGE_DAYS.length) return STAGE_DAYS[STAGE_DAYS.length - 1];
    return STAGE_DAYS[stage];
  }
  // 整数编码：base36，负数用 'n' 前缀 —— 但 'n' 本身是 base36 字符，会歧义。
  // 因此行内字段一律非负：wid 增量、stage、seen、right、wrong、dueDays 都保证 >= 0。
  // dueDays 可能为负（过期很久的词），用 DOFF 偏移成非负。
  var DOFF = 4096;   // dueDays 偏移；范围 ±4096 天（约 ±11 年）足够
  function u36(n) {
    var v = Math.round(n);
    if (v < 0) v = 0;          // 非负字段的兜底，正常不会走到
    return v.toString(36);
  }
  function p36(s) {
    if (typeof s !== 'string' || s === '') return 0;
    return parseInt(s, 36) || 0;
  }

  /* ---------------- CRC32 ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return ((c ^ 0xFFFFFFFF) >>> 0).toString(36);
  }

  /* ---------------- base64 ---------------- */
  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBytes(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /* ---------------- 压缩 ---------------- */
  function hasCompression() {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  }
  function deflate(bytes) {
    if (!hasCompression()) return Promise.resolve({ data: bytes, compressed: false });
    try {
      var cs = new CompressionStream('deflate-raw');
      var w = cs.writable.getWriter();
      w.write(bytes); w.close();
      return new Response(cs.readable).arrayBuffer().then(function (buf) {
        return { data: new Uint8Array(buf), compressed: true };
      }).catch(function () { return { data: bytes, compressed: false }; });
    } catch (e) {
      return Promise.resolve({ data: bytes, compressed: false });
    }
  }
  function inflate(bytes) {
    if (!hasCompression()) return Promise.resolve(bytes);
    var ds = new DecompressionStream('deflate-raw');
    var w = ds.writable.getWriter();
    w.write(bytes); w.close();
    return new Response(ds.readable).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  /* ---------------- 序列化 ---------------- */
  // TOP1|今日天数b36|压缩标记|书|种子|新词数|复习数~wid.stage.seen.right.wrong.dueDays;...
  function encodeProgress(prog, cfg, todayMs) {
    var today0 = Math.floor(todayMs / DAY);
    var keys = Object.keys(prog).map(Number).sort(function (a, b) { return a - b; });
    var head = ['TOP1', today0.toString(36), '0', cfg.book || 'cet4',
      (cfg.seed || '').slice(0, 16), cfg.newPerDay | 0, cfg.reviewPerDay | 0].join('|');
    if (!keys.length) return head + '~';
    var parts = [];
    var prev = -1;
    for (var i = 0; i < keys.length; i++) {
      var wid = keys[i];
      var p = prog[wid] || {};
      // 注意：绝不能用 `p.due | 0`。毫秒时间戳约 1.79e12，远超 32 位整数范围，
      // 按位或会溢出成负数，导致 due 被算成几十年偏差。必须用 Math.round。
      var dueDays = Math.round((Number(p.due) - today0 * DAY) / DAY) + DOFF;
      parts.push([u36(wid - prev), u36(Math.round(Number(p.stage) || 0)), u36(Math.round(Number(p.seen) || 0)),
        u36(Math.round(Number(p.right) || 0)), u36(Math.round(Number(p.wrong) || 0)), u36(dueDays)].join('.'));
      prev = wid;
    }
    return head + '~' + parts.join(';');
  }

  function decodeProgress(text) {
    var sep = text.indexOf('~');
    if (sep < 0) throw new Error('数据格式不正确');
    var f = text.slice(0, sep).split('|');
    if (f[0] !== 'TOP1') throw new Error('版本不匹配，可能来自更新的版本');
    var today0 = p36(f[1]);
    var prog = {};
    var body = text.slice(sep + 1);
    if (body) {
      var rows = body.split(';');
      var prev = -1;
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i]) continue;
        var c = rows[i].split('.');
        if (c.length < 6) continue;
        var wid = prev + p36(c[0]);
        var stage = p36(c[1]);
        // 还原 dueDays：减掉编码时的 DOFF 偏移
        var dueDays = p36(c[5]) - DOFF;
        var due = today0 * DAY + dueDays * DAY;
        prog[wid] = {
          stage: stage, seen: p36(c[2]), right: p36(c[3]), wrong: p36(c[4]),
          due: due, last: due - daysForStage(stage) * DAY
        };
        prev = wid;
      }
    }
    return {
      progress: prog, book: f[3] || 'cet4', seed: f[4] || '',
      newPerDay: +f[5] || 20, reviewPerDay: +f[6] || 30
    };
  }

  /* ---------------- 分帧 ---------------- */
  function buildFrames(payload) {
    var crc = crc32(new TextEncoder().encode(payload));
    if (payload.length <= SINGLE_LIMIT) {
      return { frames: [QR_PREFIX + '1/1/' + crc + '/' + payload], total: 1, crc: crc };
    }
    var total = Math.ceil(payload.length / SINGLE_LIMIT);
    if (total > MAX_FRAMES) {
      throw new Error('进度约 ' + Math.round(payload.length / 1024) + ' KB，超过 '
        + MAX_FRAMES + ' 帧上限，请改用 JSON 文件备份');
    }
    var frames = [];
    for (var i = 0; i < total; i++) {
      frames.push(QR_PREFIX + (i + 1) + '/' + total + '/' + crc + '/'
        + payload.slice(i * SINGLE_LIMIT, (i + 1) * SINGLE_LIMIT));
    }
    return { frames: frames, total: total, crc: crc };
  }

  function parseFrame(text) {
    if (!text || text.indexOf(QR_PREFIX) !== 0) throw new Error('这不是 TOP 的进度二维码');
    var rest = text.slice(QR_PREFIX.length);
    var a = rest.indexOf('/'), b = rest.indexOf('/', a + 1), c = rest.indexOf('/', b + 1);
    if (a < 0 || b < 0 || c < 0) throw new Error('二维码内容不完整');
    var index = parseInt(rest.slice(0, a), 10);
    var total = parseInt(rest.slice(a + 1, b), 10);
    if (!(index >= 1 && total >= 1 && index <= total)) throw new Error('二维码帧序号异常');
    return { index: index, total: total, crc: rest.slice(b + 1, c), data: rest.slice(c + 1) };
  }

  // 拼帧器：无序扫码也能正确拼回
  function createAssembler() {
    var parts = {}, total = 0, crc = null;
    return {
      add: function (text) {
        var f = parseFrame(text);
        if (total && f.total !== total) throw new Error('这是另一份进度的二维码，请先重置');
        if (crc && f.crc !== crc) throw new Error('这是另一份进度的二维码，请先重置');
        total = f.total; crc = f.crc;
        parts[f.index] = f.data;
        var got = Object.keys(parts).length;
        return { got: got, total: total, complete: got === total };
      },
      result: function () {
        var out = '';
        for (var i = 1; i <= total; i++) {
          if (parts[i] === undefined) throw new Error('缺少第 ' + i + ' 帧');
          out += parts[i];
        }
        if (crc32(new TextEncoder().encode(out)) !== crc) {
          throw new Error('数据校验失败，可能漏扫或扫错了二维码，请重试');
        }
        return out;
      },
      reset: function () { parts = {}; total = 0; crc = null; }
    };
  }

  /* ---------------- 二维码绘制 ---------------- */
  function renderSVG(text, ecLevel) {
    if (typeof qrcode !== 'function') throw new Error('二维码组件未加载');
    var qr = qrcode(0, ecLevel || 'L');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var scale = 4, margin = 4;
    var dim = (n + margin * 2) * scale;
    var d = '';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!qr.isDark(y, x)) continue;
        var run = 1;
        while (x + run < n && qr.isDark(y, x + run)) run++;
        d += 'M' + ((x + margin) * scale) + ' ' + ((y + margin) * scale)
          + 'h' + (run * scale) + 'v' + scale + 'h-' + (run * scale) + 'z';
        x += run - 1;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim
      + '" shape-rendering="crispEdges" role="img" aria-label="学习进度二维码">'
      + '<rect width="100%" height="100%" fill="#fffefa"/>'
      + '<path d="' + d + '" fill="#0d1117"/></svg>';
  }

  window.TOPQR = {
    encodeProgress: encodeProgress,
    decodeProgress: decodeProgress,
    buildFrames: buildFrames,
    parseFrame: parseFrame,
    createAssembler: createAssembler,
    crc32: crc32,
    renderSVG: renderSVG,
    deflate: deflate,
    inflate: inflate,
    bytesToB64: bytesToB64,
    b64ToBytes: b64ToBytes,
    SINGLE_LIMIT: SINGLE_LIMIT,
    hasCompression: hasCompression
  };
})();
