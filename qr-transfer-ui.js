/* TOP 背单词 · 二维码导出/导入界面
 * 依赖 qr-transfer.js（编码、分帧、CRC）和 vendor/qrcode-generator.js（绘制）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var frames = [];
  var frameIndex = 0;
  var frameTimer = null;
  var scannerStream = null;
  var scanTimer = null;
  var assembler = null;

  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('on'); }, 2800);
  }

  /* ---------------- 生成 ---------------- */
  function currentSnapshot() {
    var api = window.TOP;
    if (!api || typeof api.state !== 'function') throw new Error('应用还没准备好');
    var st = api.state();
    var cfg = st.cfg || {};
    var seed = '';
    try { seed = localStorage.getItem('top.seed') || ''; } catch (e) {}
    return {
      progress: st.progress || {},
      cfg: {
        book: cfg.book || 'cet4',
        seed: seed,
        newPerDay: cfg.newPerDay || 20,
        reviewPerDay: cfg.reviewPerDay || 30
      }
    };
  }

  function exportQR() {
    var box = $('qrExportBox');
    var info = $('qrExportInfo');
    stopPlayback();
    try {
      if (typeof window.TOPQR !== 'object') throw new Error('二维码组件未加载，请刷新页面');
      var snap = currentSnapshot();
      if (!Object.keys(snap.progress).length) {
        throw new Error('还没有学习记录。先背几个词再来导出。');
      }
      var text = window.TOPQR.encodeProgress(snap.progress, snap.cfg, Date.now());
      var bytes = new TextEncoder().encode(text);

      window.TOPQR.deflate(bytes).then(function (packed) {
        var payload = window.TOPQR.bytesToB64(packed.data);
        var built = window.TOPQR.buildFrames(payload);
        frames = built.frames;
        frameIndex = 0;

        box.innerHTML = '';
        box.classList.remove('hidden');
        renderFrame();

        var words = Object.keys(snap.progress).length;
        var kb = (payload.length / 1024).toFixed(1);
        info.innerHTML = '共 <b>' + words + '</b> 个词的学习记录，压缩后 ' + kb + ' KB，'
          + (built.total === 1
            ? '一个二维码即可。<b>用新设备直接扫这个码。</b>'
            : '分 <b>' + built.total + '</b> 帧，屏幕会自动轮播。<b>新设备连续扫完所有帧</b>即可，顺序不限。');
        if (built.total > 1) {
          startPlayback();
        }
      }).catch(function (err) {
        info.textContent = '生成失败：' + (err.message || err);
      });
    } catch (err) {
      box.classList.add('hidden');
      info.textContent = err.message || String(err);
    }
  }

  function renderFrame() {
    var box = $('qrExportBox');
    if (!frames.length) return;
    var svg = window.TOPQR.renderSVG(frames[frameIndex], 'L');
    var counter = frames.length > 1
      ? '<div class="qr-frame-count">第 ' + (frameIndex + 1) + ' / ' + frames.length + ' 帧</div>'
      : '';
    box.innerHTML = '<div class="qr-canvas-wrap">' + svg + counter + '</div>';
  }

  function startPlayback() {
    stopPlayback();
    frameTimer = setInterval(function () {
      frameIndex = (frameIndex + 1) % frames.length;
      renderFrame();
    }, 1200);
  }
  function stopPlayback() {
    if (frameTimer) clearInterval(frameTimer);
    frameTimer = null;
  }

  function downloadQR() {
    if (!frames.length) { toast('请先生成二维码'); return; }
    try {
      // 单帧导出 PNG；多帧导出每帧一个文件
      frames.forEach(function (f, i) {
        var svg = window.TOPQR.renderSVG(f, 'L');
        var blob = new Blob([svg], { type: 'image/svg+xml' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'TOP-学习进度' + (frames.length > 1 ? '-第' + (i + 1) + '帧' : '') + '.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      });
      toast(frames.length > 1 ? '已保存 ' + frames.length + ' 个 SVG 文件' : '二维码已保存');
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  }

  /* ---------------- 扫描导入 ---------------- */
  function openScanner() {
    var dlg = $('qrScanDialog');
    var video = $('qrVideo');
    var status = $('qrScanStatus');
    var bar = $('qrScanProgress');

    assembler = window.TOPQR.createAssembler();
    status.textContent = '正在打开摄像头…';
    bar.textContent = '';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = '这个浏览器不支持摄像头。请改用 JSON 备份文件导入，或换 Chrome / Safari。';
      return;
    }
    if (typeof window.BarcodeDetector !== 'function') {
      status.textContent = '这个浏览器不支持网页内扫码（缺少 BarcodeDetector）。'
        + '请用手机自带的相机或扫一扫功能扫描旧设备屏幕上的二维码，'
        + '或改用 JSON 备份文件导入。';
      return;
    }

    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }).then(function (stream) {
      scannerStream = stream;
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      return video.play();
    }).then(function () {
      status.textContent = '把摄像头对准旧设备屏幕上的二维码';
      startScanLoop(video);
    }).catch(function (err) {
      var msg = '无法打开摄像头';
      if (err && err.name === 'NotAllowedError') msg = '摄像头权限被拒绝，请在浏览器地址栏允许后重试';
      else if (err && err.name === 'NotFoundError') msg = '没有找到摄像头';
      else if (err && err.name === 'NotReadableError') msg = '摄像头被其他程序占用';
      status.textContent = msg + '。也可以改用 JSON 备份文件导入。';
    });
  }

  function startScanLoop(video) {
    var detector;
    try {
      detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (e) {
      $('qrScanStatus').textContent = '扫码组件初始化失败，请改用 JSON 备份导入。';
      return;
    }
    var status = $('qrScanStatus');
    var bar = $('qrScanProgress');
    var busy = false;

    scanTimer = setInterval(function () {
      if (busy || !video.videoWidth) return;
      busy = true;
      detector.detect(video).then(function (codes) {
        busy = false;
        if (!codes || !codes.length) return;
        for (var i = 0; i < codes.length; i++) {
          var raw = codes[i].rawValue;
          if (!raw) continue;
          // 混入非本系统的二维码时静默跳过，不报错
          if (raw.indexOf('TOPV1:') !== 0) continue;
          try {
            var r = assembler.add(raw);
            bar.textContent = r.total > 1
              ? '已扫描 ' + r.got + ' / ' + r.total + ' 帧'
              : '';
            if (r.complete) {
              applyScanned();
              return;
            }
            status.textContent = r.total > 1
              ? '继续扫，还剩 ' + (r.total - r.got) + ' 帧'
              : '已识别，正在导入…';
          } catch (e) {
            status.textContent = e.message || '识别失败';
            assembler.reset();
            bar.textContent = '';
          }
          break;
        }
      }).catch(function () { busy = false; });
    }, 350);
  }

  function applyScanned() {
    var status = $('qrScanStatus');
    status.textContent = '正在校验并写入…';
    clearInterval(scanTimer);
    scanTimer = null;

    try {
      var payload = assembler.result();
      var bytes = window.TOPQR.b64ToBytes(payload);
      window.TOPQR.inflate(bytes).then(function (raw) {
        var text = new TextDecoder().decode(raw);
        var data = window.TOPQR.decodeProgress(text);
        var count = Object.keys(data.progress).length;
        if (!count) throw new Error('这份二维码里没有学习记录');
        var ok = window.confirm(
          '准备导入 ' + count + ' 个词的学习记录。\n'
          + '这会替换当前设备已有的学习进度，确定吗？\n\n'
          + '（建议先导出当前记录，以防误操作）'
        );
        if (!ok) {
          status.textContent = '已取消，当前记录没有变化';
          return;
        }
        writeImported(data);
        closeScanner();
        status.textContent = '';
        toast('已导入 ' + count + ' 个词的学习记录');
      }).catch(function (err) {
        status.textContent = '导入失败：' + (err.message || err);
      });
    } catch (e) {
      status.textContent = e.message || '导入失败';
    }
  }

  function writeImported(data) {
    // 与 JSON 恢复保持一致：写 localStorage，然后让 app.js 重读并重算队列
    try {
      localStorage.setItem('top.prog', JSON.stringify(data.progress));
      var raw = localStorage.getItem('top.cfg');
      var cfg = raw ? JSON.parse(raw) : {};
      cfg.book = data.book || cfg.book || 'cet4';
      cfg.newPerDay = data.newPerDay;
      cfg.reviewPerDay = data.reviewPerDay;
      if (!cfg.orders || typeof cfg.orders !== 'object') cfg.orders = {};
      localStorage.setItem('top.cfg', JSON.stringify(cfg));
      if (data.seed) localStorage.setItem('top.seed', data.seed);
      // 续学队列属于旧进度，导入后作废，避免位置错乱
      localStorage.removeItem('top.session');
    } catch (e) {
      toast('写入失败：' + (e.message || e) + '。可能是浏览器存储空间不足');
      throw e;
    }
    if (window.TOP && typeof window.TOP.reloadFromStorage === 'function') {
      window.TOP.reloadFromStorage();
    } else if (window.TOP && typeof window.TOP.refresh === 'function') {
      window.TOP.refresh();
    }
  }

  function closeScanner() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    if (scannerStream) {
      scannerStream.getTracks().forEach(function (t) { t.stop(); });
      scannerStream = null;
    }
    var video = $('qrVideo');
    if (video) video.srcObject = null;
    var dlg = $('qrScanDialog');
    if (dlg) {
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
    }
  }

  /* ---------------- 绑定 ---------------- */
  function init() {
    var on = function (id, ev, fn) {
      var el = $(id);
      if (el) el.addEventListener(ev, fn);
    };
    on('qrExportBtn', 'click', exportQR);
    on('qrDownloadBtn', 'click', downloadQR);
    on('qrImportBtn', 'click', openScanner);
    on('qrScanClose', 'click', closeScanner);
    var dlg = $('qrScanDialog');
    if (dlg) {
      dlg.addEventListener('close', closeScanner);
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); closeScanner(); });
    }
    // 生成二维码时不该继续轮播耗电
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') stopPlayback();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.TOPQrUI = { export: exportQR, import: openScanner };
})();
