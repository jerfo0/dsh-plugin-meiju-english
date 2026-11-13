// dsh-plugin-meiju-english — client half (Web).
// 手写 loader bundle：无 JSX、无构建步骤。React 来自宿主冻结模块表，其余只用
// 原生元素 + 内联样式 + 宿主主题 token。
//
// 结构：
//   1. 辅助函数（fetch、格式化、字幕查找、词级对齐、localStorage 进度）
//   2. 样式表 S（全部使用 var(--dsh-*, fallback)，主色 #e4572e）
//   3. 小组件（Icon / Btn / Chip / ProgressBar / ProgressRing / StepCard …）
//   4. 学习流程组件（VideoStage / QuizPanel / ShadowPanel / ListenPanel）
//   5. 剧集详情 + 主面板 App
//   6. 插件导出
window.__ModuleLoader__.load({
  id: 'dsh-plugin-meiju-english',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    var API = '/api/meiju-english';
    var PANEL_ID = 'meiju-english';

    // =====================================================================
    // 1. 辅助函数
    // =====================================================================

    function msgOf(e) {
      if (e == null) return '未知错误';
      var m = typeof e === 'string' ? e : String(e.message || e);
      // 后端错误可能带 ffmpeg 长尾日志，横幅里只留前 600 字符
      return m.length > 600 ? m.slice(0, 600) + '…' : m;
    }

    // 所有 API 调用：先过 res.ok，再防御性解析 JSON，最后统一中文错误信息。
    function apiFetch(path, init) {
      return fetch(API + path, init || {}).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (e) {
            data = null;
          }
          if (!res.ok) {
            var m = (data && (data.error || data.message)) ||
              ('HTTP ' + res.status + (text ? ' · ' + String(text).slice(0, 180) : ''));
            throw new Error(m);
          }
          if (data && data.ok === false) {
            throw new Error(data.error || data.message || '接口返回失败');
          }
          return data || {};
        });
      }).catch(function (e) {
        var m = msgOf(e);
        if (/Failed to fetch|NetworkError|Load failed|network error|ERR_/i.test(m)) {
          m = '无法连接插件后端（请确认 DSH Web 与美剧英语插件正在运行）';
        }
        throw new Error(m);
      });
    }

    function apiGet(path) {
      return apiFetch(path, { method: 'GET' });
    }

    function apiPost(path, body) {
      return apiFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    }

    // 结构化请求：保留 HTTP 状态码与后端错误码（STT 的 409 / 503 / 502 需要区分处理）
    function apiRequest(path, method, body, signal) {
      var init = { method: method || 'GET' };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body || {});
      }
      if (signal) init.signal = signal;
      return fetch(API + path, init).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!res.ok || (data && data.ok === false)) {
            var message = (data && (data.error || data.message)) || ('HTTP ' + res.status);
            var err = new Error(message);
            err.status = res.status;
            err.code = data && data.code;
            err.data = data;
            throw err;
          }
          return data || {};
        });
      }, function (e) {
        var aborted = !!(e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message))));
        var err = new Error(aborted ? '请求已取消' : ('无法连接插件后端：' + msgOf(e)));
        err.status = 0;
        err.aborted = aborted;
        throw err;
      });
    }

    function mediaUrl(p) {
      if (!p) return '';
      // 按路径段编码：保留 / 原样，兼容后端两种 query 解析方式
      var parts = String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/');
      return API + '/media?p=' + parts.map(function (seg) { return encodeURIComponent(seg); }).join('/');
    }

    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function clamp(n, min, max) {
      n = Number(n);
      if (!isFinite(n)) n = min;
      return Math.min(max, Math.max(min, n));
    }

    function pctOf(part, total) {
      var t = Number(total) || 0;
      if (t <= 0) return 0;
      return clamp((Number(part) || 0) / t * 100, 0, 100);
    }

    function fmtTime(sec) {
      var s = Math.max(0, Math.floor(Number(sec) || 0));
      var hh = Math.floor(s / 3600);
      var mm = Math.floor((s % 3600) / 60);
      var ss = s % 60;
      function p2(n) { return (n < 10 ? '0' : '') + n; }
      return hh > 0 ? (hh + ':' + p2(mm) + ':' + p2(ss)) : (mm + ':' + p2(ss));
    }

    function fmtDurCn(sec) {
      var s = Math.max(0, Math.round(Number(sec) || 0));
      var m = Math.floor(s / 60);
      var r = s % 60;
      if (m >= 60) return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
      return m + ' 分 ' + (r < 10 ? '0' : '') + r + ' 秒';
    }

    function fmtBytes(n) {
      var v = Number(n) || 0;
      if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
      if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      if (v >= 1024) return Math.round(v / 1024) + ' KB';
      return Math.round(v) + ' B';
    }

    function fmtDate(iso) {
      if (!iso) return '';
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleString('zh-CN', { hour12: false });
      } catch (e) {
        return String(iso);
      }
    }

    function codeName(ep) {
      if (!ep) return 'S??E??';
      var s = Number(ep.season) || 1;
      var n = Number(ep.number) || 1;
      return 'S' + (s < 10 ? '0' : '') + s + 'E' + (n < 10 ? '0' : '') + n;
    }

    function normalizeLibrary(res) {
      var lib = res && res.library ? res.library : (res || {});
      return {
        show: (lib && lib.show) || {},
        settings: (lib && lib.settings) || {},
        episodes: Array.isArray(lib && lib.episodes) ? lib.episodes : [],
      };
    }

    // 生成任务的 stage（pipeline 输出英文）→ 中文阶段名
    var STAGE_ZH = {
      start: '准备中',
      init: '初始化',
      probe: '读取视频信息',
      ffprobe: '读取视频信息',
      ass: '解析字幕文件',
      headers: '解析字幕格式',
      parse: '解析字幕内容',
      cues: '整理字幕行',
      dialogue: '合并中英台词',
      segments: '生成逐句片段',
      clips: '切分逐句音频',
      audio: '生成完整音频',
      full: '生成完整音频',
      trim: '裁剪片头片尾',
      theme: '识别片头主题曲',
      bumper: '识别片头字幕组广告',
      fansub: '识别片头字幕组广告',
      credits: '识别片尾字幕',
      video: '制作视频代理',
      mp4: '制作视频代理',
      write: '写入物料文件',
      material: '写入物料文件',
      done: '完成',
    };

    function stageLabel(stage) {
      var key = String(stage || '').toLowerCase().trim();
      if (!key) return '';
      if (Object.prototype.hasOwnProperty.call(STAGE_ZH, key)) return STAGE_ZH[key];
      if (/probe|header/i.test(key)) return '读取视频/字幕信息';
      if (/bumper|fansub|head/i.test(key)) return '识别片头字幕组广告';
      if (/theme|opening/i.test(key)) return '剔除片头主题曲';
      if (/credit|roll|ending/i.test(key)) return '剔除片尾字幕';
      if (/seg|clip|cue/i.test(key)) return '生成逐句片段';
      if (/audio|mp3|trim|kept/i.test(key)) return '生成/裁剪完整音频';
      if (/video|mp4|proxy/i.test(key)) return '制作视频代理';
      if (/done|finish|complete/i.test(key)) return '完成';
      return String(stage);
    }

    function reasonZh(reason) {
      var r = String(reason || '').toLowerCase();
      if (/fansub|bumper|head|logo/.test(r)) return '片头字幕组广告 / 片头';
      if (/opening|theme|\bop\b/.test(r)) return '片头主题曲';
      if (/end|credit|rolling|ending/.test(r)) return '片尾字幕';
      if (/silence|blank/.test(r)) return '静音片段';
      return String(reason || '已去除的片段');
    }

    // 按时间二分查找当前字幕段（400+ 段也只能 log2 次比较）
    function findSegmentAt(segments, t) {
      if (!segments || !segments.length) return null;
      var lo = 0;
      var hi = segments.length - 1;
      var best = -1;
      var i;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        var st = Number(segments[mid] && segments[mid].start);
        if (!isFinite(st)) { lo = mid + 1; continue; }
        if (st - 0.15 <= t) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      if (best < 0) return null;
      var seg = segments[best];
      var end = Number(seg.end);
      if (isFinite(end) && t > end + 0.45) return null;
      return seg;
    }

    // v3 归一化：小写、去掉撇号与所有标点、压缩空格
    function tokenize(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/['\u2019\u0060\u00b4]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(function (w) { return !!w; });
    }

    // 把原句拆成「单词 / 标点」片段，hit=null 表示标点，true/false 表示是否读对。
    // 单词片段的数量与 tokenize() 返回的 token 数严格一致，保证高亮不会错位。
    function refWordParts(refText, hitFlags) {
      var parts = [];
      var re = /[A-Za-z0-9']+/g;
      var text = String(refText || '');
      var last = 0;
      var slot = 0;
      var m;
      while ((m = re.exec(text)) !== null) {
        var word = m[0];
        var pureApostrophe = /^'+$/.test(word);
        if (pureApostrophe) continue;
        if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: null });
        parts.push({ text: word, hit: !!(hitFlags && hitFlags[slot]) });
        last = m.index + word.length;
        slot += 1;
      }
      if (last < text.length) parts.push({ text: text.slice(last), hit: null });
      return parts;
    }

    // 词级 LCS 对齐：返回与 a 等长的布尔数组，true 表示该位置的原句单词被说到
    function lcsAlign(a, b) {
      var n = a.length;
      var m = b.length;
      var flags = [];
      var i;
      for (i = 0; i < n; i++) flags.push(false);
      if (!n || !m) return flags;
      var dp = [];
      for (i = 0; i <= n; i++) {
        var row = [];
        var j;
        for (j = 0; j <= m; j++) row.push(0);
        dp.push(row);
      }
      for (i = 1; i <= n; i++) {
        for (var jj = 1; jj <= m; jj++) {
          if (a[i - 1] === b[jj - 1]) dp[i][jj] = dp[i - 1][jj - 1] + 1;
          else dp[i][jj] = Math.max(dp[i - 1][jj], dp[i][jj - 1]);
        }
      }
      i = n;
      var k = m;
      while (i > 0 && k > 0) {
        if (a[i - 1] === b[k - 1]) {
          flags[i - 1] = true;
          i -= 1;
          k -= 1;
        } else if (dp[i - 1][k] >= dp[i][k - 1]) {
          i -= 1;
        } else {
          k -= 1;
        }
      }
      return flags;
    }

    // ---- 本机进度：localStorage key = meiju.progress.<episodeId> ----

    function progressKey(episodeId) {
      return 'meiju.progress.' + String(episodeId || '');
    }

    function emptyProgress() {
      return {
        watchedSubs: false,
        watchedNoSubs: false,
        quizPassed: false,
        shadowPassed: [],
        shadowPos: 0,
        listenOpened: false,
        updatedAt: 0,
      };
    }

    function loadProgress(episodeId) {
      var base = emptyProgress();
      try {
        var raw = window.localStorage.getItem(progressKey(episodeId));
        if (!raw) return base;
        var obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return base;
        return {
          watchedSubs: !!obj.watchedSubs,
          watchedNoSubs: !!obj.watchedNoSubs,
          quizPassed: !!obj.quizPassed,
          shadowPassed: Array.isArray(obj.shadowPassed)
            ? obj.shadowPassed.filter(function (n) { return typeof n === 'number' && isFinite(n); })
            : [],
          shadowPos: Number.isFinite(Number(obj.shadowPos)) ? Math.max(0, Math.floor(Number(obj.shadowPos))) : 0,
          listenOpened: !!obj.listenOpened,
          updatedAt: Number(obj.updatedAt) || 0,
        };
      } catch (e) {
        return base;
      }
    }

    function saveProgress(episodeId, progress) {
      var next = Object.assign({}, progress, { updatedAt: Date.now() });
      try {
        window.localStorage.setItem(progressKey(episodeId), JSON.stringify(next));
      } catch (e) {
        // 隐私模式 / 配额满：不阻塞界面，刷新后进度会丢
      }
      return next;
    }

    function clearProgress(episodeId) {
      try { window.localStorage.removeItem(progressKey(episodeId)); } catch (e) { /* ignore */ }
    }

    function stepList(hasMaterial, progress) {
      var p = progress || emptyProgress();
      return [
        { key: 'gen', label: '生成物料', done: !!hasMaterial },
        { key: 's1', label: '中英字幕观看', done: !!p.watchedSubs },
        { key: 's2', label: '无字幕观看', done: !!p.watchedNoSubs },
        { key: 'quiz', label: '测试', done: !!p.quizPassed },
        { key: 'shadow', label: '跟读', done: (p.shadowPassed || []).length > 0 },
        { key: 'listen', label: '磨耳朵', done: !!p.listenOpened },
      ];
    }

    // =====================================================================
    // 2. 样式
    // =====================================================================

    var ACCENT = '#e4572e';

    var C = {
      accent: ACCENT,
      accentSoft: 'rgba(228,87,46,0.13)',
      accentBorder: 'rgba(228,87,46,0.52)',
      ok: '#1a7f37',
      okSoft: 'rgba(26,127,55,0.13)',
      okBorder: 'rgba(26,127,55,0.5)',
      warn: '#9a6700',
      warnSoft: 'rgba(154,103,0,0.14)',
      warnBorder: 'rgba(154,103,0,0.5)',
      danger: '#b42318',
      dangerSoft: 'rgba(180,35,24,0.11)',
      dangerBorder: 'rgba(180,35,24,0.5)',
      surface: 'var(--dsh-surface, rgba(127,127,127,0.09))',
      surfaceStrong: 'var(--dsh-surface-raised, rgba(127,127,127,0.14))',
      border: 'var(--dsh-border, rgba(127,127,127,0.28))',
      borderSoft: 'var(--dsh-border-subtle, rgba(127,127,127,0.18))',
    };

    var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';
    var MONO = 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace';

    var S = {
      // ---------- 布局 ----------
      root: {
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        padding: '18px 22px 44px',
        fontSize: '13px',
        lineHeight: 1.5,
        fontFamily: FONT,
      },
      wide: {
        width: '100%',
        maxWidth: '1200px',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        flexWrap: 'wrap',
        paddingBottom: '2px',
      },
      brand: { display: 'flex', alignItems: 'center', gap: '11px', minWidth: 0 },
      brandIcon: {
        width: '38px',
        height: '38px',
        borderRadius: '11px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.accentSoft,
        color: C.accent,
        border: '1px solid ' + C.accentBorder,
        flex: '0 0 auto',
      },
      h1: { margin: 0, fontSize: '20px', fontWeight: 700, letterSpacing: '0.2px' },
      brandSub: { fontSize: '12px', opacity: 0.68, marginTop: '1px' },
      headerActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },

      // ---------- 通用容器 ----------
      card: {
        border: '1px solid ' + C.borderSoft,
        borderRadius: '13px',
        padding: '15px 17px',
        background: C.surface,
        boxSizing: 'border-box',
      },
      cardDash: {
        border: '1px dashed ' + C.border,
        borderRadius: '13px',
        padding: '15px 17px',
        background: 'transparent',
        boxSizing: 'border-box',
      },
      row: { display: 'flex', alignItems: 'center', gap: '9px' },
      rowWrap: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      col: { display: 'flex', flexDirection: 'column', gap: '10px' },
      grow: { flex: '1 1 auto', minWidth: 0 },
      sectionHead: { display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap', marginTop: '2px' },
      sectionTitle: { margin: 0, fontSize: '17px', fontWeight: 650 },
      sectionSub: { margin: '2px 0 0', fontSize: '12px', opacity: 0.66 },
      note: { margin: 0, fontSize: '12.5px', opacity: 0.75, lineHeight: 1.6 },
      noteSmall: { margin: 0, fontSize: '11.5px', opacity: 0.62, lineHeight: 1.55 },
      mono: { fontFamily: MONO, fontSize: '11.5px', wordBreak: 'break-all' },

      // ---------- 提示条 ----------
      bannerBase: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '9px',
        borderRadius: '11px',
        padding: '10px 13px',
        fontSize: '12.5px',
        lineHeight: 1.55,
        border: '1px solid transparent',
      },
      bannerError: { background: C.dangerSoft, borderColor: C.dangerBorder, color: C.danger },
      bannerOk: { background: C.okSoft, borderColor: C.okBorder, color: C.ok },
      warnBox: {
        background: C.warnSoft,
        border: '1px solid ' + C.warnBorder,
        borderRadius: '10px',
        padding: '10px 12px',
        fontSize: '12.5px',
        lineHeight: 1.6,
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      infoBox: {
        background: C.surface,
        border: '1px solid ' + C.borderSoft,
        borderRadius: '10px',
        padding: '10px 12px',
        fontSize: '12.5px',
        lineHeight: 1.6,
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },

      // ---------- 表单 ----------
      fieldRow: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 260px', minWidth: 0 },
      label: { fontSize: '11.5px', fontWeight: 600, opacity: 0.72 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 11px',
        borderRadius: '9px',
        border: '1px solid ' + C.border,
        background: C.surface,
        color: 'inherit',
        fontFamily: MONO,
        fontSize: '12px',
        lineHeight: 1.5,
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '9px 11px',
        borderRadius: '9px',
        border: '1px solid ' + C.border,
        background: C.surface,
        color: 'inherit',
        fontFamily: FONT,
        fontSize: '13px',
        lineHeight: 1.55,
        resize: 'vertical',
      },

      // ---------- 按钮 ----------
      btnBase: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        border: '1px solid ' + C.border,
        borderRadius: '10px',
        padding: '8px 14px',
        fontSize: '13px',
        fontFamily: FONT,
        lineHeight: 1.2,
        background: 'transparent',
        color: 'inherit',
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        transition: 'background .15s ease, border-color .15s ease, opacity .15s ease',
      },
      btnPrimary: {
        background: C.accent,
        borderColor: 'transparent',
        color: '#fff',
        fontWeight: 600,
      },
      btnSoft: { background: C.surfaceStrong },
      btnDanger: { background: C.dangerSoft, borderColor: C.dangerBorder, color: C.danger },
      btnGhost: { borderColor: 'transparent', background: 'transparent', opacity: 0.82 },
      btnSmall: { padding: '5px 10px', fontSize: '12px', borderRadius: '8px' },

      // ---------- 进度条 ----------
      bar: {
        height: '8px',
        borderRadius: '99px',
        background: 'rgba(127,127,127,0.22)',
        overflow: 'hidden',
        width: '100%',
      },

      // ---------- 剧集网格 ----------
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: '14px',
      },
      epCard: {
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '13px',
        border: '1px solid ' + C.borderSoft,
        background: C.surface,
        overflow: 'hidden',
        cursor: 'pointer',
        textAlign: 'left',
        padding: 0,
        color: 'inherit',
        fontFamily: FONT,
        transition: 'transform .15s ease, border-color .15s ease',
      },
      epPoster: {
        position: 'relative',
        width: '100%',
        aspectRatio: '2 / 3',
        maxHeight: '260px',
        background: 'rgba(127,127,127,0.18)',
        overflow: 'hidden',
        flex: '0 0 auto',
      },
      epPosterImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
      epFallback: {
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: '6px',
        color: 'rgba(255,255,255,0.86)',
        background: 'linear-gradient(140deg, rgba(228,87,46,0.55), rgba(30,30,40,0.75))',
      },
      epFallbackCode: { fontSize: '22px', fontWeight: 700, letterSpacing: '1px' },
      epBadge: {
        position: 'absolute',
        left: '9px',
        top: '9px',
        padding: '2px 8px',
        borderRadius: '7px',
        background: 'rgba(0,0,0,0.62)',
        color: '#fff',
        fontSize: '11.5px',
        fontWeight: 650,
        letterSpacing: '0.4px',
      },
      epBody: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '11px 12px 12px' },
      epTitleEn: {
        fontSize: '13.5px',
        fontWeight: 650,
        lineHeight: 1.4,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      epTitleZh: { fontSize: '12px', opacity: 0.78 },
      epSummary: {
        fontSize: '11.5px',
        opacity: 0.6,
        lineHeight: 1.55,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        minHeight: '2.4em',
      },
      epChips: { display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '1px' },
      epFoot: { display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '3px' },

      // ---------- 详情头 ----------
      crumbRow: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', flexWrap: 'wrap' },
      detailHead: { display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' },
      poster: {
        width: '92px',
        aspectRatio: '2 / 3',
        borderRadius: '11px',
        overflow: 'hidden',
        background: 'rgba(127,127,127,0.2)',
        flex: '0 0 auto',
        border: '1px solid ' + C.borderSoft,
      },
      detailTitle: { margin: 0, fontSize: '19px', fontWeight: 700, lineHeight: 1.3 },
      detailZh: { fontSize: '13.5px', opacity: 0.82, marginTop: '2px' },
      detailSummary: { margin: '7px 0 0', fontSize: '12.5px', opacity: 0.7, lineHeight: 1.65, maxWidth: '62ch' },
      chipRow: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '9px' },
      codeBadge: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '7px',
        background: C.accentSoft,
        color: C.accent,
        fontWeight: 700,
        fontSize: '11.5px',
        letterSpacing: '0.4px',
        border: '1px solid ' + C.accentBorder,
      },

      // ---------- 步骤卡 ----------
      stepCard: {
        border: '1px solid ' + C.borderSoft,
        borderRadius: '13px',
        background: C.surface,
        overflow: 'hidden',
      },
      stepHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '11px',
        padding: '13px 15px',
        cursor: 'pointer',
        userSelect: 'none',
      },
      stepNum: {
        width: '26px',
        height: '26px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12.5px',
        fontWeight: 700,
        background: 'rgba(127,127,127,0.18)',
        color: 'inherit',
        flex: '0 0 auto',
      },
      stepNumDone: {
        width: '26px',
        height: '26px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12.5px',
        fontWeight: 700,
        background: C.ok,
        color: '#fff',
        flex: '0 0 auto',
      },
      stepNumLocked: {
        width: '26px',
        height: '26px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12.5px',
        fontWeight: 700,
        background: 'rgba(127,127,127,0.12)',
        color: 'inherit',
        opacity: 0.55,
        flex: '0 0 auto',
      },
      stepTitleRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      stepTitle: { fontSize: '14.5px', fontWeight: 650, margin: 0 },
      stepSub: { fontSize: '11.5px', opacity: 0.62, marginTop: '2px', lineHeight: 1.5 },
      stepBody: {
        borderTop: '1px solid ' + C.borderSoft,
        padding: '14px 15px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },

      // ---------- 视频 ----------
      videoWrap: {
        position: 'relative',
        borderRadius: '12px',
        overflow: 'hidden',
        background: '#000',
        border: '1px solid ' + C.borderSoft,
      },
      video: { display: 'block', width: '100%', maxHeight: '58vh', background: '#000', cursor: 'pointer' },
      overlay: {
        position: 'absolute',
        left: '50%',
        bottom: '46px',
        transform: 'translateX(-50%)',
        maxWidth: '80%',
        width: 'max-content',
        textAlign: 'center',
        pointerEvents: 'none',
      },
      overlayInner: {
        background: 'rgba(0,0,0,0.55)',
        borderRadius: '10px',
        padding: '7px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      },
      overlayEn: { color: '#fff', fontSize: '21px', fontWeight: 600, letterSpacing: '0.2px', lineHeight: 1.35 },
      overlayZh: { color: 'rgba(255,255,255,0.92)', fontSize: '16px', lineHeight: 1.4 },
      controls: {
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        padding: '10px 12px',
        flexWrap: 'wrap',
      },
      ctrlBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        border: '1px solid ' + C.borderSoft,
        background: C.surface,
        color: 'inherit',
        borderRadius: '9px',
        padding: '6px 10px',
        fontSize: '12px',
        fontFamily: FONT,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      seek: {
        flex: '1 1 160px',
        minWidth: '120px',
        height: '5px',
        accentColor: ACCENT,
        cursor: 'pointer',
        margin: 0,
      },
      speedBtn: {
        border: '1px solid ' + C.borderSoft,
        background: 'transparent',
        color: 'inherit',
        borderRadius: '7px',
        padding: '3px 8px',
        fontSize: '11.5px',
        fontFamily: FONT,
        cursor: 'pointer',
      },
      speedBtnActive: {
        border: '1px solid ' + C.accentBorder,
        background: C.accentSoft,
        color: C.accent,
        fontWeight: 650,
        borderRadius: '7px',
        padding: '3px 8px',
        fontSize: '11.5px',
        fontFamily: FONT,
        cursor: 'pointer',
      },
      videoInfo: {
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        flexWrap: 'wrap',
        fontSize: '12px',
        opacity: 0.78,
        paddingLeft: '2px',
      },

      // ---------- 测试 ----------
      quizQ: {
        border: '1px solid ' + C.borderSoft,
        borderRadius: '12px',
        padding: '12px 14px',
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      quizQHead: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' },
      quizNum: {
        width: '22px',
        height: '22px',
        borderRadius: '7px',
        background: 'rgba(127,127,127,0.16)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '11.5px',
        fontWeight: 700,
        flex: '0 0 auto',
      },
      quizQText: { fontSize: '13.5px', fontWeight: 550, lineHeight: 1.65, marginTop: '4px' },
      option: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '9px',
        padding: '8px 11px',
        borderRadius: '9px',
        border: '1px solid ' + C.borderSoft,
        fontSize: '13px',
        lineHeight: 1.5,
        cursor: 'pointer',
      },
      optionCorrect: { borderColor: C.okBorder, background: C.okSoft },
      optionWrong: { borderColor: C.dangerBorder, background: C.dangerSoft },
      quizActions: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        paddingTop: '4px',
      },
      explanation: {
        marginTop: '6px',
        padding: '9px 11px',
        borderRadius: '9px',
        background: C.accentSoft,
        border: '1px solid ' + C.accentBorder,
        fontSize: '12.5px',
        lineHeight: 1.65,
      },
      scoreCard: {
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        flexWrap: 'wrap',
        padding: '13px 15px',
        borderRadius: '12px',
        border: '1px solid ' + C.borderSoft,
        background: C.surfaceStrong,
      },
      celebrate: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 16px',
        borderRadius: '12px',
        border: '1px solid ' + C.okBorder,
        background: C.okSoft,
      },
      celebrateTitle: { fontSize: '15px', fontWeight: 700, color: C.ok },

      // ---------- 跟读 ----------
      sentenceBox: {
        border: '1px solid ' + C.borderSoft,
        borderRadius: '12px',
        padding: '16px 18px',
        background: C.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      sentenceEn: { fontSize: '20px', fontWeight: 650, lineHeight: 1.45, letterSpacing: '0.2px' },
      sentenceZh: { fontSize: '14px', opacity: 0.74, lineHeight: 1.55 },
      levelTrack: {
        height: '6px',
        borderRadius: '99px',
        background: 'rgba(127,127,127,0.22)',
        overflow: 'hidden',
        flex: '1 1 100px',
        minWidth: '90px',
      },
      levelFill: { height: '100%', background: C.danger, borderRadius: '99px', transition: 'width .08s linear' },

      // ---------- 磨耳朵 ----------
      reasonList: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px', opacity: 0.78 },
      linkRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' },
      linkInput: {
        flex: '1 1 260px',
        minWidth: 0,
        padding: '8px 11px',
        borderRadius: '9px',
        border: '1px solid ' + C.border,
        background: C.surface,
        color: 'inherit',
        fontFamily: MONO,
        fontSize: '12px',
      },
      link: { color: C.accent, textDecoration: 'underline', wordBreak: 'break-all' },

      // ---------- 骨架屏 / 错误卡 ----------
      skeletonBlock: { borderRadius: '8px', background: 'rgba(127,127,127,0.16)' },
      errorCard: {
        border: '1px solid ' + C.dangerBorder,
        borderRadius: '13px',
        padding: '18px 20px',
        background: C.dangerSoft,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        margin: '20px auto',
        maxWidth: '720px',
        width: '100%',
        boxSizing: 'border-box',
      },
      errorTitle: { margin: 0, fontSize: '16px', fontWeight: 700, color: C.danger },
      footer: {
        marginTop: '6px',
        fontSize: '11.5px',
        opacity: 0.5,
        lineHeight: 1.6,
        textAlign: 'center',
      },
    };

    // =====================================================================
    // 3. 小组件
    // =====================================================================

    function Icon(props) {
      var p = props || {};
      var name = p.name || 'film';
      var size = p.size || 16;
      var common = {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: p.weight || 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: '0 0 auto', display: 'block' },
      };
      switch (name) {
        case 'play':
          return h('svg', common, h('path', { d: 'M6.5 4.2l9.2 5.8-9.2 5.8z', fill: 'currentColor', stroke: 'none' }));
        case 'pause':
          return h('svg', common,
            h('rect', { x: 5.4, y: 4.2, width: 3.2, height: 11.6, rx: 1, fill: 'currentColor', stroke: 'none' }),
            h('rect', { x: 11.4, y: 4.2, width: 3.2, height: 11.6, rx: 1, fill: 'currentColor', stroke: 'none' })
          );
        case 'stop':
          return h('svg', common, h('rect', { x: 5, y: 5, width: 10, height: 10, rx: 2, fill: 'currentColor', stroke: 'none' }));
        case 'back':
          return h('svg', common, h('path', { d: 'M12.2 4.5L6.7 10l5.5 5.5' }));
        case 'next':
          return h('svg', common, h('path', { d: 'M7.8 4.5L13.3 10l-5.5 5.5' }));
        case 'chevronDown':
          return h('svg', common, h('path', { d: 'M5.5 8l4.5 4.5L14.5 8' }));
        case 'check':
          return h('svg', common, h('path', { d: 'M4.5 10.4l3.6 3.6 7.4-8' }));
        case 'cross':
          return h('svg', common, h('path', { d: 'M5.6 5.6l8.8 8.8M14.4 5.6l-8.8 8.8' }));
        case 'lock':
          return h('svg', common,
            h('rect', { x: 4.6, y: 8.6, width: 10.8, height: 7.2, rx: 1.8 }),
            h('path', { d: 'M7.2 8.6V6.6a2.8 2.8 0 0 1 5.6 0v2' })
          );
        case 'mic':
          return h('svg', common,
            h('rect', { x: 7.6, y: 3.2, width: 4.8, height: 8, rx: 2.4 }),
            h('path', { d: 'M5 9.4a5 5 0 0 0 10 0M10 14.4v2.4' })
          );
        case 'sound':
          return h('svg', common,
            h('path', { d: 'M4 8.2h2.8L11 4.8v10.4l-4.2-3.4H4z' }),
            h('path', { d: 'M13.6 7.4a3.4 3.4 0 0 1 0 5.2M15.8 5.6a6 6 0 0 1 0 8.8' })
          );
        case 'sparkle':
          return h('svg', common, h('path', { d: 'M10 2.8l1.9 4.5 4.5 1.9-4.5 1.9L10 15.6 8.1 11.1 3.6 9.2l4.5-1.9z' }));
        case 'refresh':
          return h('svg', common,
            h('path', { d: 'M16 9.2A6 6 0 1 1 13.8 5' }),
            h('path', { d: 'M16.4 3.6v3.2h-3.2' })
          );
        case 'settings':
          return h('svg', common,
            h('path', { d: 'M3.4 6.2h13.2M3.4 10h13.2M3.4 13.8h13.2' }),
            h('circle', { cx: 7.6, cy: 6.2, r: 1.5, fill: 'var(--dsh-surface, #fff)' }),
            h('circle', { cx: 12.8, cy: 10, r: 1.5, fill: 'var(--dsh-surface, #fff)' }),
            h('circle', { cx: 8.8, cy: 13.8, r: 1.5, fill: 'var(--dsh-surface, #fff)' })
          );
        case 'scan':
          return h('svg', common,
            h('path', { d: 'M3.6 7.2V4.8a1.2 1.2 0 0 1 1.2-1.2h2.4M13.6 3.6h2.4a1.2 1.2 0 0 1 1.2 1.2v2.4M16.4 12.8v2.4a1.2 1.2 0 0 1-1.2 1.2h-2.4M7.2 16.4H4.8a1.2 1.2 0 0 1-1.2-1.2v-2.4' }),
            h('path', { d: 'M3.6 10h12.8' })
          );
        case 'fullscreen':
          return h('svg', common, h('path', { d: 'M3.6 7.4V4.6a1 1 0 0 1 1-1h2.8M16.4 7.4V4.6a1 1 0 0 0-1-1h-2.8M3.6 12.6v2.8a1 1 0 0 0 1 1h2.8M16.4 12.6v2.8a1 1 0 0 1-1 1h-2.8' }));
        case 'copy':
          return h('svg', common,
            h('rect', { x: 7.4, y: 7.4, width: 8.2, height: 8.2, rx: 1.6 }),
            h('path', { d: 'M12.6 7.4V5.8a1.6 1.6 0 0 0-1.6-1.6H5.8a1.6 1.6 0 0 0-1.6 1.6v5.2a1.6 1.6 0 0 0 1.6 1.6h1.6' })
          );
        case 'phone':
          return h('svg', common,
            h('rect', { x: 5.6, y: 2.8, width: 8.8, height: 14.4, rx: 2 }),
            h('path', { d: 'M8.8 14.4h2.4' })
          );
        case 'clock':
          return h('svg', common, h('circle', { cx: 10, cy: 10, r: 6.6 }), h('path', { d: 'M10 6.4V10l2.6 1.8' }));
        case 'shuffle':
          return h('svg', common,
            h('path', { d: 'M3.6 6.2h2.6l6.8 7.6h3.4M3.6 13.8h2.6l6.8-7.6h3.4' }),
            h('path', { d: 'M14.6 3.8l2.2 2.4-2.2 2.4M14.6 11.4l2.2 2.4-2.2 2.4' })
          );
        case 'film':
        default:
          return h('svg', common,
            h('rect', { x: 2.6, y: 4.4, width: 14.8, height: 11.2, rx: 2 }),
            h('path', { d: 'M2.6 8.4h14.8M7.2 4.4l1.6 4M12.4 4.4l1.6 4' })
          );
      }
    }

    function Btn(props) {
      var p = props || {};
      var focusState = React.useState(false);
      var focused = focusState[0];
      var setFocused = focusState[1];
      var variant = p.variant || 'default';
      var variants = {
        default: {},
        primary: S.btnPrimary,
        soft: S.btnSoft,
        danger: S.btnDanger,
        ghost: S.btnGhost,
      };
      var style = Object.assign({}, S.btnBase, variants[variant] || {}, p.small ? S.btnSmall : null);
      if (p.disabled) style.opacity = 0.48;
      if (p.disabled) style.cursor = 'not-allowed';
      if (focused) {
        style.outline = '2px solid ' + ACCENT;
        style.outlineOffset = '2px';
      }
      if (p.style) Object.assign(style, p.style);
      return h('button', {
        type: 'button',
        style: style,
        disabled: !!p.disabled,
        title: p.title || undefined,
        onClick: p.disabled ? undefined : p.onClick,
        onFocus: function () { setFocused(true); },
        onBlur: function () { setFocused(false); },
      },
        p.icon ? h(Icon, { name: p.icon, size: p.iconSize || 14 }) : null,
        p.children != null ? p.children : null
      );
    }

    function Chip(props) {
      var p = props || {};
      var tones = {
        neutral: { color: 'inherit', background: 'var(--dsh-surface, rgba(127,127,127,0.13))' },
        ok: { color: C.ok, background: C.okSoft },
        warn: { color: C.warn, background: C.warnSoft },
        danger: { color: C.danger, background: C.dangerSoft },
        accent: { color: C.accent, background: C.accentSoft },
      };
      var style = Object.assign({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '1px 8px',
        borderRadius: '99px',
        border: '1px solid transparent',
        fontSize: '11.5px',
        lineHeight: '19px',
        whiteSpace: 'nowrap',
        fontWeight: 500,
      }, tones[p.tone] || tones.neutral, p.style || {});
      return h('span', { style: style }, p.children);
    }

    function ProgressBar(props) {
      var p = props || {};
      var pct = clamp(p.pct, 0, 100);
      var wrap = Object.assign({}, S.bar, p.style || {});
      return h('div', { style: wrap },
        h('div', {
          style: {
            height: '100%',
            width: pct + '%',
            borderRadius: '99px',
            background: p.color || ACCENT,
            transition: 'width .35s ease',
          },
        })
      );
    }

    function ProgressRing(props) {
      var p = props || {};
      var size = p.size || 56;
      var stroke = p.stroke || 5;
      var pct = clamp(p.pct, 0, 100);
      var r = (size - stroke) / 2;
      var circumference = 2 * Math.PI * r;
      var offset = circumference * (1 - pct / 100);
      var centerText = p.center != null ? p.center : Math.round(pct) + '%';
      return h('div', { style: { position: 'relative', width: size + 'px', height: size + 'px', flex: '0 0 auto' } },
        h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, style: { transform: 'rotate(-90deg)', display: 'block' } },
          h('circle', { cx: size / 2, cy: size / 2, r: r, fill: 'none', stroke: 'rgba(127,127,127,0.24)', strokeWidth: stroke }),
          pct > 0 ? h('circle', {
            cx: size / 2,
            cy: size / 2,
            r: r,
            fill: 'none',
            stroke: p.color || ACCENT,
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeDasharray: circumference,
            strokeDashoffset: offset,
            style: { transition: 'stroke-dashoffset .45s ease' },
          }) : null
        ),
        h('div', {
          style: {
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size >= 56 ? '13px' : '11.5px',
            fontWeight: 700,
            letterSpacing: '0.2px',
          },
        }, centerText)
      );
    }

    function StepBars(props) {
      var steps = (props && props.steps) || [];
      return h('div', { style: { display: 'flex', gap: '4px', width: '100%' } },
        steps.map(function (s, i) {
          return h('div', {
            key: (s && s.key) || i,
            title: (s.done ? '已完成 · ' : '未完成 · ') + (s.label || ''),
            style: {
              flex: '1 1 0',
              height: '4px',
              borderRadius: '99px',
              background: s.done ? ACCENT : 'rgba(127,127,127,0.25)',
            },
          });
        })
      );
    }

    function EmptyState(props) {
      var p = props || {};
      return h('div', {
        style: {
          textAlign: 'center',
          padding: '24px 16px',
          border: '1px dashed ' + C.border,
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '6px',
        },
      },
        p.icon ? h('div', { style: { opacity: 0.6, display: 'flex' } }, h(Icon, { name: p.icon, size: 24 })) : null,
        h('div', { style: { fontWeight: 600, fontSize: '14px' } }, p.title || '暂无内容'),
        p.desc ? h('p', { style: { margin: 0, fontSize: '12.5px', opacity: 0.7, lineHeight: 1.6, maxWidth: '56ch' } }, p.desc) : null,
        p.children || null
      );
    }

    // 错误边界：任何渲染崩溃都显示中文错误卡，而不是让整个 slot 白屏
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.retry = this.retry.bind(this);
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      componentDidCatch(error, info) {
        try { console.warn('[meiju-english] render error:', error, info); } catch (e) { /* ignore */ }
      }
      retry() {
        this.setState({ error: null });
      }
      render() {
        if (!this.state.error) return this.props.children || null;
        var msg = msgOf(this.state.error);
        return h('div', { style: Object.assign({}, S.root, { justifyContent: 'center' }) },
          h('div', { style: S.errorCard },
            h('h2', { style: S.errorTitle }, '美剧英语面板出错了'),
            h('p', { style: { margin: 0, fontSize: '13px', lineHeight: 1.65 } },
              '界面遇到一个意外错误，学习进度保存在本机浏览器里，不会丢失。可以先点「重试」，或者刷新页面。'),
            h('div', { style: Object.assign({}, S.mono, { padding: '9px 11px', borderRadius: '9px', background: 'rgba(0,0,0,0.12)', fontSize: '11.5px' }) }, msg),
            h('div', { style: S.row },
              h(Btn, { variant: 'primary', icon: 'refresh', onClick: this.retry }, '重试'),
              h(Btn, { variant: 'ghost', onClick: function () { try { window.location.reload(); } catch (e) { /* ignore */ } } }, '刷新页面')
            )
          )
        );
      }
    }

    // =====================================================================
    // 4. 学习流程组件
    // =====================================================================

    // ---- 4.1 视频 + 字幕覆盖层（步骤 1 / 2 共用） ----
    function VideoStage(props) {
      var p = props || {};
      var segments = p.segments || [];
      var videoFile = p.videoFile;

      var modeState = React.useState('both');
      var mode = modeState[0];
      var setMode = modeState[1];
      var tState = React.useState(0);
      var t = tState[0];
      var setT = tState[1];
      var durState = React.useState(Number(p.duration) || 0);
      var duration = durState[0];
      var setDuration = durState[1];
      var playState = React.useState(false);
      var playing = playState[0];
      var setPlaying = playState[1];
      var speedState = React.useState(1);
      var speed = speedState[0];
      var setSpeed = speedState[1];
      var watchedState = React.useState(0);
      var watched = watchedState[0];
      var setWatched = watchedState[1];
      var hintState = React.useState('');
      var hint = hintState[0];
      var setHint = hintState[1];

      var videoRef = React.useRef(null);
      var wrapRef = React.useRef(null);
      var accRef = React.useRef(0);
      var lastTimeRef = React.useRef(0);
      var doneRef = React.useRef(!!p.done);
      var onDoneRef = React.useRef(p.onDone);
      var lastResetRef = React.useRef(p.resetToken);

      React.useEffect(function () { onDoneRef.current = p.onDone; }, [p.onDone]);
      React.useEffect(function () {
        if (p.done) doneRef.current = true;
      }, [p.done]);

      // 「重置本集进度」后重新开始计数
      React.useEffect(function () {
        if (lastResetRef.current === p.resetToken) return;
        lastResetRef.current = p.resetToken;
        doneRef.current = false;
        accRef.current = 0;
        lastTimeRef.current = 0;
        setWatched(0);
        setT(0);
        var v = videoRef.current;
        if (v) {
          try { v.currentTime = 0; } catch (e) { /* ignore */ }
          try { v.playbackRate = speed; } catch (e) { /* ignore */ }
        }
      }, [p.resetToken]);

      // 离开详情 / 折叠时暂停播放
      React.useEffect(function () {
        return function () {
          var v = videoRef.current;
          if (v) { try { v.pause(); } catch (e) { /* ignore */ } }
        };
      }, []);

      // 播放速度同步（切换视频源后也要重新设置）
      React.useEffect(function () {
        var v = videoRef.current;
        if (v) { try { v.playbackRate = speed; } catch (e) { /* ignore */ } }
      }, [speed]);

      // 累计真实观看时长达到 98% 才算完成
      React.useEffect(function () {
        if (doneRef.current) return;
        if (duration > 0 && watched / duration >= 0.98) {
          doneRef.current = true;
          if (onDoneRef.current) onDoneRef.current('ratio');
        }
      }, [watched, duration]);

      var ratio = duration > 0 ? clamp(watched / duration, 0, 1) : 0;
      var done = !!p.done || ratio >= 0.98;

      function togglePlay() {
        var v = videoRef.current;
        if (!v) return;
        if (v.paused) {
          var pr = v.play();
          if (pr && pr.catch) {
            pr.catch(function (e) {
              setHint('无法播放视频：' + msgOf(e) + '（请确认物料里的视频文件已生成）');
            });
          }
        } else {
          v.pause();
        }
      }

      function onTimeUpdate() {
        var v = videoRef.current;
        if (!v) return;
        var cur = Number(v.currentTime) || 0;
        var last = lastTimeRef.current;
        var delta = cur - last;
        if (delta > 0 && delta < 1.5) {
          var maxDur = Number(v.duration) || duration || 0;
          accRef.current = Math.min(maxDur, accRef.current + delta);
          setWatched(accRef.current);
        }
        lastTimeRef.current = cur;
        setT(cur);
      }

      function onLoadedMetadata() {
        var v = videoRef.current;
        if (!v) return;
        setDuration(Number(v.duration) || Number(p.duration) || 0);
        try { v.playbackRate = speed; } catch (e) { /* ignore */ }
      }

      function onEnded() {
        setPlaying(false);
        if (doneRef.current) return;
        doneRef.current = true;
        if (onDoneRef.current) onDoneRef.current('ended');
      }

      function seekBy(delta) {
        var v = videoRef.current;
        if (!v) return;
        var d = Number(v.duration) || duration || 0;
        v.currentTime = clamp((Number(v.currentTime) || 0) + delta, 0, Math.max(0, d));
      }

      function seekTo(val) {
        var v = videoRef.current;
        if (!v) return;
        var d = Number(v.duration) || duration || 0;
        v.currentTime = clamp(Number(val) || 0, 0, Math.max(0, d));
      }

      function applySpeed(s) {
        setSpeed(s);
        var v = videoRef.current;
        if (v) { try { v.playbackRate = s; } catch (e) { /* ignore */ } }
      }

      function toggleFullscreen() {
        var el = wrapRef.current;
        try {
          if (document.fullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen();
            return;
          }
          if (el && el.requestFullscreen) {
            var pr = el.requestFullscreen();
            if (pr && pr.catch) {
              pr.catch(function () { setHint('当前环境不允许全屏，可以把窗口放大观看'); });
            }
          } else {
            setHint('当前环境不支持全屏，可以把窗口放大观看');
          }
        } catch (e) {
          setHint('当前环境不支持全屏，可以把窗口放大观看');
        }
      }

      if (!videoFile) {
        return h(EmptyState, {
          icon: 'film',
          title: '缺少视频文件',
          desc: '物料里没有找到视频代理文件。请回到第 0 步重新生成本集物料。',
        });
      }

      var current = p.showSubtitles === false ? null : findSegmentAt(segments, t);

      var overlayLines = [];
      if (current) {
        if ((mode === 'both' || mode === 'en') && current.en) {
          overlayLines.push(h('div', { key: 'en', style: S.overlayEn }, String(current.en)));
        }
        if ((mode === 'both' || mode === 'zh') && current.zh) {
          overlayLines.push(h('div', { key: 'zh', style: S.overlayZh }, String(current.zh)));
        }
      }

      var overlay = overlayLines.length
        ? h('div', { style: S.overlay },
          h('div', { style: S.overlayInner }, overlayLines)
        )
        : null;

      var modeButtons = [
        { key: 'both', label: '双语' },
        { key: 'en', label: '显示英文' },
        { key: 'zh', label: '显示中文' },
      ].map(function (m) {
        var active = mode === m.key;
        return h('button', {
          key: m.key,
          type: 'button',
          style: active ? S.speedBtnActive : S.speedBtn,
          onClick: function () { setMode(m.key); },
        }, m.label);
      });

      var progressText = '观看进度 ' + Math.round(ratio * 100) + '% · 看到 98% 才算完成';

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('div', { ref: wrapRef, style: S.videoWrap },
          h('video', {
            ref: videoRef,
            src: mediaUrl(videoFile),
            style: S.video,
            playsInline: true,
            preload: 'metadata',
            onClick: togglePlay,
            onDoubleClick: toggleFullscreen,
            onTimeUpdate: onTimeUpdate,
            onLoadedMetadata: onLoadedMetadata,
            onPlay: function () { setPlaying(true); },
            onPause: function () { setPlaying(false); },
            onEnded: onEnded,
            onSeeked: function () {
              var v = videoRef.current;
              if (v) lastTimeRef.current = Number(v.currentTime) || 0;
            },
            onError: function () { setHint('视频加载失败，请确认物料里的视频文件仍然存在（可重新生成物料）。'); },
          }),
          overlay
        ),
        h('div', { style: S.controls },
          h('button', { type: 'button', style: S.ctrlBtn, onClick: togglePlay, title: playing ? '暂停' : '播放' },
            h(Icon, { name: playing ? 'pause' : 'play', size: 14 }),
            playing ? '暂停' : '播放'
          ),
          h('button', { type: 'button', style: S.ctrlBtn, onClick: function () { seekBy(-5); }, title: '后退 5 秒' }, '−5s'),
          h('button', { type: 'button', style: S.ctrlBtn, onClick: function () { seekBy(5); }, title: '前进 5 秒' }, '+5s'),
          h('span', { style: { fontSize: '11.5px', opacity: 0.75, whiteSpace: 'nowrap', fontFamily: MONO } },
            fmtTime(t) + ' / ' + fmtTime(duration)),
          h('input', {
            type: 'range',
            min: 0,
            max: Math.max(1, Math.round(duration || 1)),
            step: 0.2,
            value: clamp(t, 0, Math.max(1, duration || 1)),
            style: S.seek,
            onChange: function (e) { seekTo(e.target.value); },
            'aria-label': '播放进度',
          }),
          h('button', { type: 'button', style: S.ctrlBtn, onClick: toggleFullscreen, title: '全屏' },
            h(Icon, { name: 'fullscreen', size: 13 }),
            '全屏'
          )
        ),
        h('div', { style: S.videoInfo },
          h('div', { style: Object.assign({}, S.row, { gap: '5px' }) },
            [0.75, 1, 1.25].map(function (s) {
              return h('button', {
                key: s,
                type: 'button',
                style: speed === s ? S.speedBtnActive : S.speedBtn,
                onClick: function () { applySpeed(s); },
                title: '播放速度 ' + s + 'x',
              }, s + 'x');
            })
          ),
          p.showSubtitles === false
            ? h(Chip, { tone: 'neutral' }, '本步不显示字幕')
            : h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } },
              h('span', { style: { opacity: 0.7 } }, '字幕：'), modeButtons),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { opacity: 0.8 } }, progressText),
          done ? h(Chip, { tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '本步已完成') : null
        ),
        hint
          ? h('div', { style: Object.assign({}, S.bannerBase, S.bannerError) },
            h(Icon, { name: 'cross', size: 14 }),
            h('span', { style: { flex: '1 1 auto' } }, hint),
            h(Btn, { small: true, variant: 'ghost', onClick: function () { setHint(''); } }, '关闭'))
          : null,
        h('div', { style: S.noteSmall }, '双击画面可全屏；字幕按原片时间轴自动显示，暂停时会停在当前这句。')
      );
    }

    // ---- 4.2 测试（步骤 3，v2：一题一屏 / 纯选择 / 错题轮次） ----
    var QTYPE = {
      choice: '选择题',
      multi: '多选勾选',
      fill: '选词填空',
      grammar: '语法题',
      translate: '翻译题',
      listening: '听力题',
    };

    function shuffleArray(list) {
      var arr = Array.isArray(list) ? list.slice() : [];
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    }

    function quizTypeOf(q) {
      var t = q && q.type;
      return Object.prototype.hasOwnProperty.call(QTYPE, t) ? t : 'choice';
    }

    // v2 单选用 answer:index；多选用 answers:[indices]（同时兼容 answer 为数组的写法）
    function quizCorrectIndices(q) {
      var out = [];
      function push(v) {
        var n = Number(v);
        if (isFinite(n)) out.push(n);
      }
      if (!q) return out;
      if (Array.isArray(q.answers)) q.answers.forEach(push);
      else if (Array.isArray(q.answer)) q.answer.forEach(push);
      else if (q.answer != null) push(q.answer);
      return out;
    }

    function quizIsMulti(q) {
      return quizTypeOf(q) === 'multi' || quizCorrectIndices(q).length > 1;
    }

    function quizSelectionCorrect(q, selection) {
      var want = quizCorrectIndices(q).slice().sort(function (a, b) { return a - b; });
      if (!want.length) return false;
      if (quizIsMulti(q)) {
        if (!Array.isArray(selection)) return false;
        var got = selection.map(Number).filter(function (n) { return isFinite(n); })
          .sort(function (a, b) { return a - b; });
        if (got.length !== want.length) return false;
        for (var i = 0; i < want.length; i++) {
          if (got[i] !== want[i]) return false;
        }
        return true;
      }
      return selection != null && !Array.isArray(selection) && Number(selection) === want[0];
    }

    function quizAnswerText(q) {
      var options = Array.isArray(q && q.options) ? q.options : [];
      var idxs = quizCorrectIndices(q);
      if (!idxs.length) return '（题目缺少正确答案）';
      return idxs.map(function (i) {
        var opt = options[i];
        return String.fromCharCode(65 + i) + (opt != null ? '. ' + String(opt) : '');
      }).join('　');
    }

    // 只有「有选项 + 有答案下标」的题目才能进入 v2 选择题流程（旧版填空/翻译题会被跳过）
    function quizIsUsable(q) {
      if (!q || typeof q !== 'object') return false;
      var options = Array.isArray(q.options) ? q.options : [];
      return options.length >= 2 && quizCorrectIndices(q).length > 0;
    }

    function QuizPanel(props) {
      var p = props || {};
      var quiz = p.quiz || {};
      var questions = Array.isArray(quiz.questions) ? quiz.questions : [];
      var totalCount = questions.length;
      var usableCount = 0;
      var ui;
      for (ui = 0; ui < questions.length; ui++) {
        if (quizIsUsable(questions[ui])) usableCount += 1;
      }
      var skippedCount = totalCount - usableCount;
      var passScore = Number(quiz.passScore) > 0 ? Number(quiz.passScore) : 100;

      var roundState = React.useState(1);
      var round = roundState[0];
      var setRound = roundState[1];
      var phaseState = React.useState('question');
      var phase = phaseState[0];
      var setPhase = phaseState[1];
      var queueState = React.useState(function () { return buildQueue(); });
      var queue = queueState[0];
      var setQueue = queueState[1];
      var qIndexState = React.useState(0);
      var qIndex = qIndexState[0];
      var setQIndex = qIndexState[1];
      var selState = React.useState(null);
      var selection = selState[0];
      var setSelection = selState[1];
      // v3：选择必须绑定到「当前题目 id」，防止上一题的选中样式泄漏到下一题
      var selForState = React.useState('');
      var selectionFor = selForState[0];
      var setSelectionFor = selForState[1];
      var submittedState = React.useState(false);
      var submitted = submittedState[0];
      var setSubmitted = submittedState[1];
      var lastOkState = React.useState(false);
      var lastOk = lastOkState[0];
      var setLastOk = lastOkState[1];
      var consecutiveState = React.useState(0);
      var consecutiveWrong = consecutiveState[0];
      var setConsecutiveWrong = consecutiveState[1];
      var failedRoundsState = React.useState(0);
      var failedRounds = failedRoundsState[0];
      var setFailedRounds = failedRoundsState[1];
      var roundWrongState = React.useState([]);
      var roundWrong = roundWrongState[0];
      var setRoundWrong = roundWrongState[1];
      var reviewState = React.useState([]);
      var reviewIds = reviewState[0];
      var setReviewIds = reviewState[1];
      var reviewOpenState = React.useState(false);
      var reviewOpen = reviewOpenState[0];
      var setReviewOpen = reviewOpenState[1];
      var noticeState = React.useState('');
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var playingState = React.useState('');
      var playingId = playingState[0];
      var setPlayingId = playingState[1];

      var audioRef = React.useRef(null);
      var passedRef = React.useRef(false);
      var advanceRef = React.useRef(null);
      var mountedRef = React.useRef(true);
      // Auto-advance fires from a setTimeout created in the tap render; the
      // captured `submitted` state is still false there, so track it in a ref.
      var submittedRef = React.useRef(false);

      var segMap = React.useMemo(function () {
        var map = {};
        var list = p.segments || [];
        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (s && typeof s.index === 'number') map[s.index] = s;
        }
        return map;
      }, [p.segments]);

      React.useEffect(function () {
        return function () {
          var a = audioRef.current;
          if (a) {
            try { a.pause(); } catch (e) { /* ignore */ }
            try { a.removeAttribute('src'); } catch (e) { /* ignore */ }
            audioRef.current = null;
          }
        };
      }, []);

      // 「重置本集进度」或题目数据变化后整体重来
      React.useEffect(function () {
        hardReset('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [p.resetToken, p.quiz]);

      // 卸载时清掉自动跳转计时器
      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
          clearAdvance();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 换题 / 换轮 / 重置时也必须清掉（防止旧计时器把新题直接跳过）
      React.useEffect(function () {
        return function () { clearAdvance(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [qIndex, round, p.resetToken]);

      function clearAdvance() {
        if (advanceRef.current) {
          try { clearTimeout(advanceRef.current); } catch (e) { /* ignore */ }
          advanceRef.current = null;
        }
      }

      // 答对后短暂显示 ✓（约 700ms）再自动进入下一题
      function scheduleAdvance() {
        clearAdvance();
        advanceRef.current = setTimeout(function () {
          advanceRef.current = null;
          if (!mountedRef.current) return;
          nextQuestion();
        }, 700);
      }

      function stopClip() {
        var a = audioRef.current;
        if (a) { try { a.pause(); } catch (e) { /* ignore */ } }
        setPlayingId('');
      }

      function playClip(q) {
        var seg = segMap[q.segmentIndex];
        if (!seg || !seg.clip) {
          if (p.onError) p.onError('这道听力题缺少对应的音频片段（第 ' + (q.segmentIndex || '?') + ' 句）');
          return;
        }
        var a = audioRef.current;
        if (!a) {
          a = new Audio();
          a.preload = 'auto';
          audioRef.current = a;
        }
        if (playingId === q.id) {
          stopClip();
          return;
        }
        a.onended = function () { setPlayingId(''); };
        a.onerror = function () {
          setPlayingId('');
          if (p.onError) p.onError('听力音频加载失败，请确认物料已生成完整');
        };
        try { a.pause(); } catch (e) { /* ignore */ }
        a.src = mediaUrl(seg.clip);
        setPlayingId(q.id);
        var pr = a.play();
        if (pr && pr.catch) {
          pr.catch(function (e) {
            setPlayingId('');
            if (p.onError) p.onError('无法播放听力音频：' + msgOf(e));
          });
        }
      }

      function currentQuestion() {
        var idx = queue[qIndex];
        if (typeof idx !== 'number') return null;
        return questions[idx] || null;
      }

      function hasSelection(sel) {
        if (Array.isArray(sel)) return sel.length > 0;
        return sel != null;
      }

      // 第 1 轮的题序：跳过没有选项/答案的题目（旧版题库）
      function buildQueue() {
        var arr = [];
        for (var i = 0; i < questions.length; i++) {
          if (quizIsUsable(questions[i])) arr.push(i);
        }
        return arr;
      }

      // 从第 1 题重新开始：清空所有作答与轮次状态
      function hardReset(noticeText) {
        passedRef.current = false;
        submittedRef.current = false;
        clearAdvance();
        setPhase('question');
        setRound(1);
        setQueue(buildQueue());
        setQIndex(0);
        setSelection(null);
        setSelectionFor('');
        setSubmitted(false);
        setLastOk(false);
        setConsecutiveWrong(0);
        setFailedRounds(0);
        setRoundWrong([]);
        setReviewIds([]);
        setReviewOpen(false);
        setNotice(noticeText || '');
        stopClip();
      }

      function activeQidOf(q) {
        var question = q || currentQuestion();
        if (!question) return '';
        return question.id ? String(question.id) : ('idx' + queue[qIndex]);
      }

      function gradeSelection(q, value) {
        if (submitted) return;
        if (!q || !hasSelection(value)) return;
        var idx = queue[qIndex];
        var ok = quizSelectionCorrect(q, value);
        setSubmitted(true);
        submittedRef.current = true;
        setLastOk(ok);
        setNotice('');
        stopClip();
        if (ok) {
          setConsecutiveWrong(0);
          scheduleAdvance();
          return;
        }
        var cw = consecutiveWrong + 1;
        setConsecutiveWrong(cw);
        setRoundWrong(function (prev) { return prev.indexOf(idx) >= 0 ? prev : prev.concat([idx]); });
        setReviewIds(function (prev) { return prev.indexOf(idx) >= 0 ? prev : prev.concat([idx]); });
        if (round === 1 && cw >= 5) {
          hardReset('连续答错 5 道，测试重新开始');
        }
      }

      function pickOption(oi) {
        if (submitted) return;
        var q = currentQuestion();
        if (!q) return;
        var qid = activeQidOf(q);
        var multi = quizIsMulti(q);
        var current = selectionFor === qid ? selection : (multi ? [] : null);
        if (multi) {
          var arr = Array.isArray(current) ? current.slice() : [];
          var at = arr.indexOf(oi);
          if (at >= 0) arr.splice(at, 1);
          else arr.push(oi);
          arr.sort(function (a, b) { return a - b; });
          setSelectionFor(qid);
          setSelection(arr);
          return;
        }
        // 单选：点选即判分（不再有「提交答案」按钮）
        setSelectionFor(qid);
        setSelection(oi);
        gradeSelection(q, oi);
      }

      // 仅 multi 使用：勾选组合后点「提交答案」再判分
      function submitMulti() {
        if (submitted) return;
        var q = currentQuestion();
        if (!q) return;
        var qid = activeQidOf(q);
        if (selectionFor !== qid) return;
        gradeSelection(q, selection);
      }

      function nextQuestion() {
        if (!submittedRef.current) return;
        submittedRef.current = false;
        clearAdvance();
        stopClip();
        if (qIndex < queue.length - 1) {
          setQIndex(qIndex + 1);
          setSelection(null);
          setSelectionFor('');
          setSubmitted(false);
          setLastOk(false);
          return;
        }
        finishRound();
      }

      function finishRound() {
        clearAdvance();
        stopClip();
        if (!roundWrong.length) {
          // 本轮全部答对 → 最终通过
          setPhase('passed');
          if (!passedRef.current) {
            passedRef.current = true;
            if (p.onPass) p.onPass();
          }
          return;
        }
        if (round === 1) {
          // 第 1 轮有错题 → 进入错题重做轮
          setPhase('roundBreak');
          return;
        }
        var fails = failedRounds + 1;
        setFailedRounds(fails);
        setPhase(fails >= 3 ? 'failed' : 'roundBreak');
      }

      // 开始/继续错题重做轮（错题打乱顺序）
      function startWrongRound() {
        if (!roundWrong.length) {
          hardReset('');
          return;
        }
        clearAdvance();
        submittedRef.current = false;
        setRound(2);
        setQueue(shuffleArray(roundWrong));
        setQIndex(0);
        setSelection(null);
        setSelectionFor('');
        setSubmitted(false);
        setLastOk(false);
        setRoundWrong([]);
        setNotice('');
        setPhase('question');
        stopClip();
      }

      function toggleReview() {
        setReviewOpen(function (v) { return !v; });
      }

      function reviewButton() {
        return h(Btn, {
          small: true,
          variant: 'soft',
          icon: 'list',
          onClick: toggleReview,
          disabled: !reviewIds.length,
        }, '查看错题解析' + (reviewIds.length ? '（' + reviewIds.length + '）' : ''));
      }

      function reviewPanel() {
        if (!reviewOpen || !reviewIds.length) return null;
        return h('div', { style: Object.assign({}, S.card, { display: 'flex', flexDirection: 'column', gap: '10px' }) },
          h('div', { style: S.rowWrap },
            h('div', { style: { fontWeight: 650, fontSize: '15px' } }, '错题解析（' + reviewIds.length + ' 题）'),
            h('span', { style: { marginLeft: 'auto' } },
              h(Btn, { small: true, variant: 'ghost', onClick: toggleReview }, '收起'))
          ),
          reviewIds.map(function (qi, n) {
            var q = questions[qi];
            if (!q) return null;
            return h('div', { key: 'rv' + qi, style: S.quizQ },
              h('div', { style: S.quizQHead },
                h('span', { style: S.quizNum }, String(n + 1)),
                h(Chip, { tone: 'accent' }, QTYPE[quizTypeOf(q)]),
                h('span', { style: { marginLeft: 'auto', fontSize: '11.5px', opacity: 0.6 } }, '原题号 ' + (qi + 1))
              ),
              h('div', { style: S.quizQText }, String(q.question || '')),
              h('div', { style: { marginTop: '5px', fontSize: '12.5px', fontWeight: 600, color: C.ok } },
                '正确答案：' + quizAnswerText(q)),
              q.explanation
                ? h('div', { style: S.explanation },
                  h('span', { style: { fontWeight: 700, marginRight: '4px' } }, '解析：'),
                  String(q.explanation))
                : null
            );
          })
        );
      }

      function optionRow(q, multi, oi, opt) {
        var qid = activeQidOf(q);
        // 只有「选择属于当前题目」时才显示选中，避免上一题的样式泄漏到下一题
        var picked = selectionFor === qid
          ? (multi ? (Array.isArray(selection) && selection.indexOf(oi) >= 0) : selection === oi)
          : false;
        var want = quizCorrectIndices(q);
        var correctOpt = want.indexOf(oi) >= 0;
        var style = Object.assign({}, S.option);
        if (quizTypeOf(q) === 'fill') {
          style = Object.assign(style, { padding: '8px 14px' });
        }
        if (submitted) {
          if (correctOpt) Object.assign(style, S.optionCorrect);
          else if (picked) Object.assign(style, S.optionWrong);
        } else if (picked) {
          style.borderColor = C.accentBorder;
          style.background = C.accentSoft;
        }
        return h('label', { key: 'opt' + oi, style: style },
          h('input', {
            type: multi ? 'checkbox' : 'radio',
            name: 'meiju-q-' + (q.id || queue[qIndex]),
            checked: picked,
            disabled: submitted,
            onChange: function () { pickOption(oi); },
            style: { accentColor: ACCENT, margin: '2px 0 0', flex: '0 0 auto' },
          }),
          h('span', { style: { flex: '1 1 auto' } }, String.fromCharCode(65 + oi) + '. ' + String(opt)),
          submitted && correctOpt ? h(Icon, { name: 'check', size: 13 }) : null,
          submitted && picked && !correctOpt ? h(Icon, { name: 'cross', size: 13 }) : null
        );
      }

      if (!totalCount) {
        return h(EmptyState, {
          icon: 'settings',
          title: '本集测试题还未生成',
          desc: '测试题通常随物料自动生成；旧物料可以在步骤 3 里点「生成测试题」单独补生成，或回步骤 0 重新生成物料。',
        });
      }

      if (!usableCount) {
        return h(EmptyState, {
          icon: 'settings',
          title: '题库格式需要更新',
          desc: '当前 quiz.json 不是 v2 选择模式（题目缺少 options 或答案下标），请更新题库后刷新页面。',
        });
      }

      var q = currentQuestion();
      if (!q) {
        return h(EmptyState, {
          icon: 'settings',
          title: '题目数据缺失',
          desc: '第 ' + (qIndex + 1) + ' 题在 quiz.json 里不存在，请让内容侧检查题库文件。',
        });
      }
      var qtype = quizTypeOf(q);
      var multi = quizIsMulti(q);
      var opts = Array.isArray(q && q.options) ? q.options : [];
      var optionsWrapStyle = qtype === 'fill'
        ? { display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '8px' }
        : { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' };
      var activeQid = activeQidOf(q);
      var selValue = selectionFor === activeQid ? selection : (multi ? [] : null);
      var pickedCount = Array.isArray(selValue) ? selValue.length : (selValue == null ? 0 : 1);

      var topRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h(Chip, { tone: 'accent' },
          (round === 1 ? '第 1 轮 · ' : '错题重做 · ') + '第 ' + (qIndex + 1) + ' / ' + queue.length + ' 题'),
        h(Chip, { tone: 'neutral' }, QTYPE[qtype]),
        skippedCount > 0 ? h(Chip, { tone: 'warn' }, '已跳过 ' + skippedCount + ' 道无选项题目') : null,
        q.difficulty ? h(Chip, { tone: 'neutral' }, '难度 ' + q.difficulty) : null,
        round === 2 ? h(Chip, { tone: 'warn' }, '已失败 ' + failedRounds + ' / 3 轮') : null,
        p.passed ? h(Chip, { tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '本集测试已通过') : null,
        h('span', { style: { marginLeft: 'auto', fontSize: '11.5px', opacity: 0.6 } },
          '答错 4 题以内进入错题重做')
      );

      var noticeBanner = notice
        ? h('div', { style: Object.assign({}, S.bannerBase, S.bannerError) },
          h(Icon, { name: 'cross', size: 14 }),
          h('span', { style: { flex: '1 1 auto' } }, notice))
        : null;

      var questionCard = h('div', { key: 'q-' + activeQid + '-' + round, style: S.quizQ },
        h('div', { style: S.quizQHead },
          h('span', { style: S.quizNum }, String(qIndex + 1)),
          h(Chip, { tone: 'accent' }, QTYPE[qtype]),
          multi ? h(Chip, { tone: 'neutral' }, '勾选全部正确项') : null,
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
            submitted
              ? (lastOk
                ? h(Chip, { tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '正确')
                : h(Chip, { tone: 'danger' }, h(Icon, { name: 'cross', size: 11 }), '错误'))
              : null)
        ),
        h('div', { style: S.quizQText }, String(q.question || '（缺少题干）')),
        qtype === 'listening'
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
            h(Btn, {
              small: true,
              variant: 'soft',
              icon: playingId === q.id ? 'stop' : 'play',
              onClick: function () { playClip(q); },
            }, playingId === q.id ? '停止' : '播放录音'),
            h(Btn, { small: true, variant: 'ghost', icon: 'refresh', onClick: function () { playClip(q); } }, '重播'),
            h('span', { style: { fontSize: '11.5px', opacity: 0.62 } }, '第 ' + (q.segmentIndex || '?') + ' 句'))
          : null,
        h('div', { style: optionsWrapStyle },
          opts.map(function (opt, oi) { return optionRow(q, multi, oi, opt); })
        ),
        multi && !submitted
          ? h('div', { style: { fontSize: '11.5px', opacity: 0.6, marginTop: '5px' } }, '已勾选 ' + pickedCount + ' 项')
          : null,
        submitted
          ? h('div', { style: { marginTop: '7px', fontSize: '12.5px', fontWeight: 600, color: C.ok } },
            '正确答案：' + quizAnswerText(q))
          : null,
        submitted && q.explanation
          ? h('div', { style: S.explanation },
            h('span', { style: { fontWeight: 700, marginRight: '4px' } }, '解析：'),
            String(q.explanation))
          : null
      );

      var actionsRow = h('div', { style: S.quizActions },
        h('div', { style: { fontSize: '12.5px', opacity: 0.7, flex: '1 1 240px' } },
          submitted
            ? (lastOk
              ? (qIndex < queue.length - 1 ? '回答正确！马上进入下一题…' : '回答正确！马上显示成绩…')
              : '回答错误，看完解析后点「下一题」继续。')
            : (multi
              ? '勾选你认为正确的所有选项，然后点「提交答案」。'
              : '点选一个选项就会立即判分；答对会自动进入下一题。')),
        h('div', { style: { display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' } },
          reviewButton(),
          !submitted && multi
            ? h(Btn, { variant: 'primary', icon: 'check', onClick: submitMulti, disabled: !hasSelection(selValue) }, '提交答案')
            : null,
          submitted && !lastOk
            ? h(Btn, { variant: 'primary', icon: 'next', onClick: nextQuestion },
              qIndex < queue.length - 1 ? '下一题' : '查看结果')
            : null
        )
      );

      var questionBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '11px' } },
        topRow,
        noticeBanner,
        h(ProgressBar, { pct: ((qIndex + 1) / Math.max(1, queue.length)) * 100 }),
        questionCard,
        actionsRow
      );

      var passedBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: S.celebrate },
          h(Icon, { name: 'sparkle', size: 26 }),
          h('div', { style: { flex: '1 1 auto' } },
            h('div', { style: S.celebrateTitle }, '测试通过，恭喜！'),
            h('div', { style: { fontSize: '12.5px', opacity: 0.78 } },
              (round === 1 ? '第一轮全部答对。' : '错题重做全部答对。')
              + '本集测试已通过，可以继续第 4 步跟读练习。'))
        ),
        h('div', { style: S.quizActions },
          h('span', { style: { fontSize: '12.5px', opacity: 0.7, flex: '1 1 220px' } },
            '共 ' + usableCount + ' 题 · 满分 ' + passScore + ' 分 · 全部答对才算通过'),
          h('div', { style: { display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' } },
            reviewIds.length ? reviewButton() : null,
            h(Btn, { variant: 'soft', icon: 'refresh', onClick: function () { hardReset(''); } }, '再练一遍'))
        )
      );

      var failedBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', {
          style: {
            border: '1px solid ' + C.dangerBorder,
            background: C.dangerSoft,
            borderRadius: '12px',
            padding: '15px 17px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          },
        },
          h('div', { style: { fontSize: '15.5px', fontWeight: 700, color: C.danger } }, '本次不过关'),
          h('div', { style: { fontSize: '13px', lineHeight: 1.7 } },
            '错题重做连续 3 轮都没有全部答对，本次测试不过关，本步不会被标记为完成。'),
          h('div', { style: { fontSize: '12.5px', opacity: 0.78 } },
            '可以先看完错题解析，再点「重新开始」从第 1 题再来一次。')
        ),
        h('div', { style: S.quizActions },
          h('span', { style: { fontSize: '12.5px', opacity: 0.7, flex: '1 1 220px' } },
            '连续失败 ' + failedRounds + ' 轮 · 共 ' + usableCount + ' 题'),
          h('div', { style: { display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' } },
            reviewIds.length ? reviewButton() : null,
            h(Btn, { variant: 'primary', icon: 'refresh', onClick: function () { hardReset(''); } }, '重新开始'))
        )
      );

      var breakCorrect = Math.max(0, queue.length - roundWrong.length);
      var breakBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: S.scoreCard },
          h(ProgressRing, {
            pct: (breakCorrect / Math.max(1, queue.length)) * 100,
            size: 62,
            center: '对 ' + breakCorrect + '/' + queue.length,
            color: ACCENT,
          }),
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontSize: '14.5px', fontWeight: 700 } },
              round === 1 ? '第 1 轮完成' : '错题重做未全部答对'),
            h('div', { style: { fontSize: '12.5px', opacity: 0.8, marginTop: '3px', lineHeight: 1.65 } },
              round === 1
                ? ('本轮答对 ' + breakCorrect + ' / ' + queue.length + ' 题，还有 ' + roundWrong.length
                  + ' 道错题需要重做；重做时会重新打乱顺序。')
                : ('本轮还剩 ' + roundWrong.length + ' 道错题。连续 3 轮错题重做未全对就本次不过关'
                  + '（当前已失败 ' + failedRounds + ' 轮）。'))
          )
        ),
        h('div', { style: S.quizActions },
          h('span', { style: { fontSize: '12.5px', opacity: 0.7, flex: '1 1 220px' } },
            round === 1 ? '错题重做：只做答错的题目，顺序打乱' : '继续重做剩下的错题'),
          h('div', { style: { display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' } },
            reviewIds.length ? reviewButton() : null,
            h(Btn, { variant: 'primary', icon: 'refresh', onClick: startWrongRound },
              round === 1 ? '开始错题重做' : '重新打乱重做'))
        )
      );

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        phase === 'passed' ? passedBody : null,
        phase === 'failed' ? failedBody : null,
        phase === 'roundBreak' ? breakBody : null,
        phase === 'question' ? questionBody : null,
        reviewPanel()
      );
    }

    // ---- 4.2b 本地语音识别（SenseVoice）辅助：状态 / WAV 规范化 / base64 ----

    var MAX_STT_SECONDS = 30;

    var STT_PHASE_ZH = {
      ready: '已就绪',
      standby: '已就绪',
      unprepared: '未准备',
      downloading: '下载模型中',
      checking: '校验模型',
      loading: '加载模型',
      waking: '唤醒模型',
      preparing: '准备中',
      failed: '准备失败',
    };

    function sttPhaseZh(phase) {
      var key = String(phase || '').toLowerCase();
      return STT_PHASE_ZH[key] || (key ? key : '未知状态');
    }

    function sttPhaseInProgress(phase) {
      var key = String(phase || '').toLowerCase();
      return key === 'downloading' || key === 'checking' || key === 'loading'
        || key === 'waking' || key === 'preparing';
    }

    function sttProviderState(status) {
      var providers = status && Array.isArray(status.providers) ? status.providers : [];
      var selection = (status && status.selection) || {};
      var chosen = null;
      var i;
      for (i = 0; i < providers.length; i++) {
        if (providers[i] && providers[i].id === selection.providerId) { chosen = providers[i]; break; }
      }
      if (!chosen && providers.length) chosen = providers[0];
      var phase = chosen && chosen.phase ? String(chosen.phase) : '';
      var total = chosen ? Number(chosen.totalBytes) : 0;
      var done = chosen ? Number(chosen.completedBytes) : 0;
      return {
        provider: chosen,
        phase: phase,
        ready: phase === 'ready' || phase === 'standby',
        inProgress: sttPhaseInProgress(phase),
        progress: total > 0 && isFinite(done) ? clamp((done / total) * 100, 0, 100) : 0,
        message: chosen && chosen.message ? String(chosen.message) : '',
        step: chosen && chosen.step ? String(chosen.step) : '',
      };
    }

    function blobToArrayBuffer(blob) {
      if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
      return new Promise(function (resolve, reject) {
        try {
          var reader = new FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.onerror = function () { reject(new Error('读取录音数据失败')); };
          reader.readAsArrayBuffer(blob);
        } catch (e) {
          reject(e);
        }
      });
    }

    function writeAscii(view, offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    // Canonical WAV：RIFF/WAVE/fmt(16)/PCM/1ch/16000Hz/32000Bps/16bit/data
    function encodeWav16kMono(samples, sampleRate) {
      var count = samples.length;
      if (!count) {
        samples = [0];
        count = 1;
      }
      var buffer = new ArrayBuffer(44 + count * 2);
      var view = new DataView(buffer);
      writeAscii(view, 0, 'RIFF');
      view.setUint32(4, 36 + count * 2, true);
      writeAscii(view, 8, 'WAVE');
      writeAscii(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);       // PCM
      view.setUint16(22, 1, true);       // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true); // byte rate
      view.setUint16(32, 2, true);       // block align
      view.setUint16(34, 16, true);      // bits per sample
      writeAscii(view, 36, 'data');
      view.setUint32(40, count * 2, true);
      var offset = 44;
      for (var i = 0; i < count; i++) {
        var s = samples[i];
        if (!isFinite(s)) s = 0;
        s = Math.max(-1, Math.min(1, s));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
      return new Uint8Array(buffer);
    }

    function bytesToBase64(bytes) {
      var chunk = 0x8000;
      var parts = [];
      var i;
      for (i = 0; i < bytes.length; i += chunk) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
      }
      var binary = parts.join('');
      if (typeof btoa === 'function') return btoa(binary);
      throw new Error('当前环境不支持 base64 编码');
    }

    // 录音 Blob → 16 kHz 单声道 PCM16 WAV → base64（宿主的 SenseVoice 只接受这种格式）
    function convertToWav16kMono(arrayBuffer) {
      var AC = window.AudioContext || window.webkitAudioContext;
      var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC || !Offline) {
        return Promise.reject(new Error('当前浏览器不支持 AudioContext / OfflineAudioContext'));
      }
      var decodeCtx = null;
      function closeCtx() {
        try { if (decodeCtx && decodeCtx.state !== 'closed' && decodeCtx.close) decodeCtx.close(); } catch (e) { /* ignore */ }
        decodeCtx = null;
      }
      return Promise.resolve()
        .then(function () {
          decodeCtx = new AC();
          return decodeCtx.decodeAudioData(arrayBuffer.slice(0));
        })
        .then(function (decoded) {
          var channels = decoded.numberOfChannels;
          var length = decoded.length;
          var mono = decodeCtx.createBuffer(1, length, decoded.sampleRate);
          var out = mono.getChannelData(0);
          var ch;
          var i;
          for (ch = 0; ch < channels; ch++) {
            var data = decoded.getChannelData(ch);
            for (i = 0; i < length; i++) out[i] += data[i];
          }
          if (channels > 1) {
            for (i = 0; i < length; i++) out[i] = out[i] / channels;
          }
          var maxSeconds = Math.min(decoded.duration, MAX_STT_SECONDS);
          var frames = Math.max(1, Math.min(Math.ceil(maxSeconds * 16000), 16000 * MAX_STT_SECONDS));
          var offline = new Offline(1, frames, 16000);
          var src = offline.createBufferSource();
          src.buffer = mono;
          src.connect(offline.destination);
          src.start(0);
          return offline.startRendering().then(function (rendered) {
            var samples = rendered.getChannelData(0);
            var wav = encodeWav16kMono(samples, 16000);
            closeCtx();
            return {
              bytes: wav,
              base64: bytesToBase64(wav),
              duration: frames / 16000,
              truncated: decoded.duration > MAX_STT_SECONDS + 0.05,
            };
          });
        }, function (err) {
          closeCtx();
          throw new Error('录音格式转换失败：' + msgOf(err));
        });
    }

    // ---- 4.3 跟读练习（步骤 4） ----
    function ShadowPanel(props) {
      var p = props || {};
      var segments = p.segments || [];
      var progress = p.progress || {};
      var passedList = Array.isArray(progress.shadowPassed) ? progress.shadowPassed : [];

      var passedSet = React.useMemo(function () {
        var set = {};
        passedList.forEach(function (n) { set[n] = true; });
        return set;
      }, [progress.shadowPassed]);

      // ---- v4：记住上次跟读到第几句（localStorage 里 shadowPos = 句子 index） ----
      function findPosBySegmentIndex(list, wanted) {
        if (!wanted) return -1;
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].index === wanted) return i;
        }
        return -1;
      }
      function initialShadowPos() {
        var wanted = Number(progress && progress.shadowPos);
        if (!segments.length || !wanted) return 0;
        var at = findPosBySegmentIndex(segments, wanted);
        if (at >= 0) return at;
        return clamp(Math.floor(wanted), 0, segments.length - 1);
      }

      var posState = React.useState(initialShadowPos);
      var pos = posState[0];
      var setPos = posState[1];
      var resumedRef = React.useRef(false);
      var nextTimerRef = React.useRef(null);
      var resumedFrom = Number(progress && progress.shadowPos) || 0;

      function clearNextTimer() {
        if (nextTimerRef.current) {
          try { clearTimeout(nextTimerRef.current); } catch (e) { /* ignore */ }
          nextTimerRef.current = null;
        }
      }

      // 一句过关后稍等片刻自动进入下一句，保持“继续往下”的节奏
      function scheduleNextSentence() {
        clearNextTimer();
        if (segments.length <= 1) return;
        nextTimerRef.current = setTimeout(function () {
          nextTimerRef.current = null;
          if (!mountedRef.current) return;
          setPos(function (prev) { return Math.min(prev + 1, segments.length - 1); });
        }, 1200);
      }

      // 父组件异步补上进度后，再对齐一次「上次读到第 N 句」
      React.useEffect(function () {
        if (resumedRef.current || !segments.length) return;
        var wanted = Number(progress && progress.shadowPos);
        if (!wanted) return;
        var at = findPosBySegmentIndex(segments, wanted);
        if (at < 0) return;
        resumedRef.current = true;
        setPos(function (prev) { return prev === at ? prev : at; });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [progress && progress.shadowPos, segments]);

      // 位置变化 → 持久化到本机进度（下次进来从这里继续）
      React.useEffect(function () {
        if (!segments.length) return;
        var seg = segments[clamp(pos, 0, segments.length - 1)];
        if (seg && typeof seg.index === 'number' && p.onPos) p.onPos(seg.index);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pos, segments.length]);

      // 「重置本集进度」后回到第 1 句（只在 resetToken 真正变化时触发，挂载时不触发）
      var resetSeenRef = React.useRef(p.resetToken);
      React.useEffect(function () {
        if (p.resetToken === undefined) return;
        if (resetSeenRef.current === p.resetToken) return;
        resetSeenRef.current = p.resetToken;
        resumedRef.current = true;
        clearNextTimer();
        setPos(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [p.resetToken]);
      var phaseState = React.useState('idle');
      var phase = phaseState[0];
      var setPhase = phaseState[1];
      var recUrlState = React.useState('');
      var recUrl = recUrlState[0];
      var setRecUrl = recUrlState[1];
      var scoreState = React.useState(null);
      var score = scoreState[0];
      var setScore = scoreState[1];
      var micErrState = React.useState('');
      var micError = micErrState[0];
      var setMicError = micErrState[1];
      var levelState = React.useState(0);
      var level = levelState[0];
      var setLevel = levelState[1];
      var refPlayState = React.useState(false);
      var refPlaying = refPlayState[0];
      var setRefPlaying = refPlayState[1];
      var recPlayState = React.useState(false);
      var recPlaying = recPlayState[0];
      var setRecPlaying = recPlayState[1];

      // v3：本地语音模型（SenseVoice）状态
      var sttStatusState = React.useState(null);
      var sttStatus = sttStatusState[0];
      var setSttStatus = sttStatusState[1];
      var sttErrState = React.useState('');
      var sttErr = sttErrState[0];
      var setSttErr = sttErrState[1];
      var sttPreparingState = React.useState(false);
      var sttPreparing = sttPreparingState[0];
      var setSttPreparing = sttPreparingState[1];
      var sttTranscribingState = React.useState(false);
      var sttTranscribing = sttTranscribingState[0];
      var setSttTranscribing = sttTranscribingState[1];
      var sttNoticeState = React.useState('');
      var sttNotice = sttNoticeState[0];
      var setSttNotice = sttNoticeState[1];
      var sttWaitState = React.useState(null);
      var sttWait = sttWaitState[0];
      var setSttWait = sttWaitState[1];

      var clipAudioRef = React.useRef(null);
      var recAudioRef = React.useRef(null);
      var streamRef = React.useRef(null);
      var recorderRef = React.useRef(null);
      var chunksRef = React.useRef([]);
      var audioCtxRef = React.useRef(null);
      var analyserRef = React.useRef(null);
      var rafRef = React.useRef(null);
      var samplesRef = React.useRef([]);
      var recStartRef = React.useRef(0);
      var recDurRef = React.useRef(0);
      var transcriptRef = React.useRef('');
      var recognitionRef = React.useRef(null);
      var recognitionActiveRef = React.useRef(false);
      var recognitionEndedRef = React.useRef(true);
      var recUrlRef = React.useRef('');
      var mountedRef = React.useRef(true);
      var recBlobRef = React.useRef(null);
      var sttTimerRef = React.useRef(null);
      var sttAbortRef = React.useRef(null);
      var scoreSeqRef = React.useRef(0);
      var waitCancelRef = React.useRef(false);

      var safePos = segments.length ? clamp(pos, 0, segments.length - 1) : 0;
      var seg = segments.length ? segments[safePos] : null;

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      // 打开步骤时查询本地语音模型状态（宿主未提供 STT 时安静降级）
      React.useEffect(function () {
        loadSttStatus().then(function (res) {
          if (!mountedRef.current || !res) return;
          if (res.available === false) return;
          var st = sttProviderState(res);
          if (!st.ready && (st.inProgress || sttPhaseInProgress(st.phase))) startSttPolling();
        });
        return function () { stopSttPolling(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      function stopTracks() {
        var stream = streamRef.current;
        streamRef.current = null;
        if (!stream) return;
        try {
          var tracks = stream.getTracks ? stream.getTracks() : [];
          tracks.forEach(function (tr) { try { tr.stop(); } catch (e) { /* ignore */ } });
        } catch (e) { /* ignore */ }
      }

      function stopAudioGraph() {
        if (rafRef.current) {
          try { cancelAnimationFrame(rafRef.current); } catch (e) { /* ignore */ }
          rafRef.current = null;
        }
        analyserRef.current = null;
        var ctx = audioCtxRef.current;
        audioCtxRef.current = null;
        if (ctx) {
          try { if (ctx.state !== 'closed' && ctx.close) ctx.close(); } catch (e) { /* ignore */ }
        }
      }

      function abortRecognition() {
        var r = recognitionRef.current;
        recognitionRef.current = null;
        recognitionActiveRef.current = false;
        recognitionEndedRef.current = true;
        if (r) { try { r.abort(); } catch (e) { /* ignore */ } }
      }

      function revokeRecUrl() {
        if (recUrlRef.current) {
          try { URL.revokeObjectURL(recUrlRef.current); } catch (e) { /* ignore */ }
          recUrlRef.current = '';
        }
      }

      function stopMediaEl(el) {
        if (!el) return;
        try { el.pause(); } catch (e) { /* ignore */ }
      }

      function stopSttPolling() {
        if (sttTimerRef.current) {
          try { clearInterval(sttTimerRef.current); } catch (e) { /* ignore */ }
          sttTimerRef.current = null;
        }
      }

      function abortSttRequest() {
        var ctrl = sttAbortRef.current;
        sttAbortRef.current = null;
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } }
      }

      function isLive(seq) {
        return mountedRef.current && scoreSeqRef.current === seq;
      }

      function waitForRecBlob(timeoutMs) {
        return new Promise(function (resolve) {
          var started = Date.now();
          var timer = setInterval(function () {
            if (recBlobRef.current || Date.now() - started >= timeoutMs) {
              clearInterval(timer);
              resolve(recBlobRef.current || null);
            }
          }, 100);
        });
      }

      function loadSttStatus() {
        return apiRequest('/stt-status', 'GET').then(function (res) {
          if (!mountedRef.current) return null;
          setSttStatus(res);
          setSttErr('');
          return res;
        }).catch(function (e) {
          if (!mountedRef.current) return null;
          if (e && e.aborted) return null;
          setSttStatus(null);
          setSttErr('本地语音识别服务不可用：' + msgOf(e));
          return null;
        });
      }

      function startSttPolling() {
        stopSttPolling();
        sttTimerRef.current = setInterval(function () {
          if (!mountedRef.current) { stopSttPolling(); return; }
          loadSttStatus().then(function (res) {
            if (!res) { stopSttPolling(); return; }
            var st = sttProviderState(res);
            if (res.available === false || st.ready || st.phase === 'failed') stopSttPolling();
          });
        }, 1000);
      }

      function prepareStt() {
        if (sttPreparing) return;
        setSttPreparing(true);
        setSttErr('');
        apiRequest('/stt-prepare', 'POST', {}).then(function (res) {
          if (!mountedRef.current) return;
          if (res && Array.isArray(res.providers)) setSttStatus(res);
          startSttPolling();
        }).catch(function (e) {
          if (!mountedRef.current) return;
          setSttErr('启动模型准备失败：' + msgOf(e));
        }).then(function () {
          if (mountedRef.current) setSttPreparing(false);
        });
      }

      // 录音已经完成但模型未就绪（409）时，轮询状态直到 ready；最多等 10 分钟（可取消）
      function waitSttReady(maxMs, seq) {
        waitCancelRef.current = false;
        return new Promise(function (resolve) {
          var started = Date.now();
          var idleSince = 0;
          var timer = setInterval(function () {
            if (waitCancelRef.current) {
              waitCancelRef.current = false;
              clearInterval(timer);
              setSttWait(null);
              resolve(false);
              return;
            }
            if (!isLive(seq)) {
              clearInterval(timer);
              setSttWait(null);
              resolve(false);
              return;
            }
            loadSttStatus().then(function (res) {
              if (!isLive(seq)) {
                clearInterval(timer);
                setSttWait(null);
                resolve(false);
                return;
              }
              var st = sttProviderState(res);
              if (st.ready) {
                setSttWait(null);
                clearInterval(timer);
                resolve(true);
                return;
              }
              // 服务不可用，或长时间既不下载也不就绪（例如准备没启动），不要一直卡住
              if ((res && res.available === false) || st.phase === 'failed') {
                setSttWait(null);
                clearInterval(timer);
                resolve(false);
                return;
              }
              if (st.inProgress) {
                idleSince = 0;
              } else if (!idleSince) {
                idleSince = Date.now();
              } else if (Date.now() - idleSince > 15000) {
                setSttWait(null);
                clearInterval(timer);
                resolve(false);
                return;
              }
              if (Date.now() - started >= maxMs) {
                setSttWait(null);
                clearInterval(timer);
                resolve(false);
                return;
              }
              setSttWait({ phase: st.phase, pct: st.progress, message: st.message || '' });
            });
          }, 1000);
        });
      }

      // 卸载时必须清理：停止麦克风轨道、录音器、语音识别、AudioContext、object URL、STT 轮询/请求
      React.useEffect(function () {
        return function () {
          var rec = recorderRef.current;
          if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) { /* ignore */ } }
          recorderRef.current = null;
          stopTracks();
          abortRecognition();
          stopAudioGraph();
          revokeRecUrl();
          stopMediaEl(clipAudioRef.current);
          stopMediaEl(recAudioRef.current);
          stopSttPolling();
          abortSttRequest();
          recBlobRef.current = null;
          scoreSeqRef.current += 1;
        };
      }, []);

      function resetSession() {
        clearNextTimer();
        var rec = recorderRef.current;
        if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) { /* ignore */ } }
        recorderRef.current = null;
        stopTracks();
        abortRecognition();
        stopAudioGraph();
        revokeRecUrl();
        stopMediaEl(clipAudioRef.current);
        stopMediaEl(recAudioRef.current);
        chunksRef.current = [];
        samplesRef.current = [];
        transcriptRef.current = '';
        recDurRef.current = 0;
        scoreSeqRef.current += 1;
        abortSttRequest();
        stopSttPolling();
        recBlobRef.current = null;
        waitCancelRef.current = false;
        setSttNotice('');
        setSttWait(null);
        setSttTranscribing(false);
        setPhase('idle');
        setRecUrl('');
        setScore(null);
        setMicError('');
        setLevel(0);
        setRefPlaying(false);
        setRecPlaying(false);
      }

      // 切句时清场
      React.useEffect(function () {
        resetSession();
      }, [pos]);

      function startMeter(stream) {
        try {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          var ctx = new AC();
          audioCtxRef.current = ctx;
          try { if (ctx.resume) ctx.resume(); } catch (e) { /* ignore */ }
          var source = ctx.createMediaStreamSource(stream);
          var analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);
          analyserRef.current = analyser;
          var buf = new Uint8Array(analyser.fftSize);
          samplesRef.current = [];
          var tick = function () {
            var an = analyserRef.current;
            if (!an) return;
            try {
              an.getByteTimeDomainData(buf);
              var sum = 0;
              for (var i = 0; i < buf.length; i++) {
                var v = (buf[i] - 128) / 128;
                sum += v * v;
              }
              var rms = Math.sqrt(sum / buf.length);
              samplesRef.current.push(rms);
              if (samplesRef.current.length > 6000) samplesRef.current.shift();
              if (mountedRef.current) setLevel(Math.min(1, rms * 3.2));
            } catch (e) { /* ignore */ }
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        } catch (e) {
          // 拿不到音量分析就只用时长打分
          analyserRef.current = null;
        }
      }

      function startRecognition() {
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return;
        try {
          var r = new SR();
          r.lang = 'en-US';
          r.interimResults = false;
          r.continuous = false;
          r.maxAlternatives = 1;
          transcriptRef.current = '';
          recognitionEndedRef.current = false;
          recognitionActiveRef.current = true;
          r.onresult = function (ev) {
            var txt = '';
            try {
              for (var i = ev.resultIndex || 0; i < ev.results.length; i++) {
                txt += ' ' + (ev.results[i][0] && ev.results[i][0].transcript ? ev.results[i][0].transcript : '');
              }
            } catch (e) { /* ignore */ }
            transcriptRef.current = (transcriptRef.current + ' ' + txt).replace(/\s+/g, ' ').trim();
          };
          r.onerror = function () {
            recognitionEndedRef.current = true;
            recognitionActiveRef.current = false;
          };
          r.onend = function () {
            recognitionEndedRef.current = true;
            recognitionActiveRef.current = false;
            if (recognitionRef.current === r) recognitionRef.current = null;
          };
          r.start();
          recognitionRef.current = r;
        } catch (e) {
          recognitionRef.current = null;
          recognitionActiveRef.current = false;
          recognitionEndedRef.current = true;
        }
      }

      function waitTranscript(timeoutMs) {
        return new Promise(function (resolve) {
          var started = Date.now();
          var timer = setInterval(function () {
            if (recognitionEndedRef.current || !recognitionActiveRef.current || Date.now() - started >= timeoutMs) {
              clearInterval(timer);
              resolve(String(transcriptRef.current || '').trim());
            }
          }, 150);
        });
      }

      function startRecording() {
        setMicError('');
        setScore(null);
        setRecUrl('');
        revokeRecUrl();
        stopMediaEl(recAudioRef.current);
        chunksRef.current = [];
        samplesRef.current = [];
        transcriptRef.current = '';
        recDurRef.current = 0;
        recBlobRef.current = null;
        scoreSeqRef.current += 1; // 让上一次录音/识别的回调失效
        abortSttRequest();
        setSttNotice('');
        setSttWait(null);
        setSttTranscribing(false);
        setPhase('recording');
        try {
          if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            throw new Error('当前浏览器不支持麦克风录音（需要 localhost 或 HTTPS 环境）');
          }
          if (typeof window.MediaRecorder === 'undefined') {
            throw new Error('当前浏览器不支持 MediaRecorder 录音');
          }
        } catch (e) {
          setPhase('idle');
          setMicError(msgOf(e));
          return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
          if (!mountedRef.current) {
            try {
              stream.getTracks().forEach(function (tr) { tr.stop(); });
            } catch (e) { /* ignore */ }
            return;
          }
          streamRef.current = stream;
          var mime = '';
          var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
          for (var i = 0; i < candidates.length; i++) {
            try {
              if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(candidates[i])) {
                mime = candidates[i];
                break;
              }
            } catch (e) { /* ignore */ }
          }
          var rec;
          try {
            rec = mime ? new window.MediaRecorder(stream, { mimeType: mime }) : new window.MediaRecorder(stream);
          } catch (e) {
            rec = new window.MediaRecorder(stream);
          }
          recorderRef.current = rec;
          rec.ondataavailable = function (ev) {
            if (ev.data && ev.data.size) chunksRef.current.push(ev.data);
          };
          rec.onstop = function () {
            var chunks = chunksRef.current;
            var type = (chunks[0] && chunks[0].type) || mime || 'audio/webm';
            var blob = new Blob(chunks, { type: type });
            recBlobRef.current = blob;
            revokeRecUrl();
            var url = '';
            try { url = URL.createObjectURL(blob); } catch (e) { url = ''; }
            recUrlRef.current = url;
            if (mountedRef.current) setRecUrl(url);
          };
          startMeter(stream);
          startRecognition();
          recStartRef.current = Date.now();
          rec.start();
        }).catch(function (e) {
          var m = msgOf(e);
          if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError' || e.name === 'SecurityError')) {
            m = '麦克风权限被拒绝：请点浏览器地址栏左侧的权限图标，允许本页面使用麦克风后重试。';
          } else if (e && (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError')) {
            m = '没有检测到可用的麦克风设备，请检查设备连接。';
          } else if (e && e.name === 'NotReadableError') {
            m = '麦克风被其他程序占用，请关闭其他录音或会议软件后重试。';
          } else if (e && /getUserMedia/i.test(m)) {
            m = '无法访问麦克风：' + m;
          }
          stopTracks();
          stopAudioGraph();
          if (mountedRef.current) {
            setPhase('idle');
            setMicError(m);
          }
          if (p.onError) p.onError(m);
        });
      }

      // v3：词级准确度评分（识别文本 vs 原句 en）—— 匹配词数 / 原句总词数 ×100，录音时长不参与
      function scoreTranscript(transcript, source) {
        if (!mountedRef.current) return;
        var currentSeg = segments.length ? segments[clamp(pos, 0, segments.length - 1)] : null;
        var refText = (currentSeg && currentSeg.en) || '';
        var refWords = tokenize(refText);
        var hypWords = tokenize(transcript || '');
        var hits = lcsAlign(refWords, hypWords);
        var matched = 0;
        var i;
        for (i = 0; i < hits.length; i++) {
          if (hits[i]) matched += 1;
        }
        var value = refWords.length ? Math.round((matched / refWords.length) * 100) : 0;
        var missedWords = [];
        var parts = refWordParts(refText, hits);
        for (i = 0; i < parts.length; i++) {
          if (parts[i].hit === false) missedWords.push(parts[i].text);
        }
        var result = {
          method: 'speech',
          source: source === 'web' ? 'web' : 'host',
          value: value,
          passed: value >= 70,
          selfPassed: false,
          refText: refText,
          transcript: String(transcript || '').trim(),
          hits: hits,
          matched: matched,
          totalWords: refWords.length,
          missedWords: missedWords.slice(0, 8),
          missedCount: missedWords.length,
          label: source === 'web' ? '浏览器语音识别 · 词级准确度' : '本地语音模型 · 词级准确度',
        };
        setScore(result);
        setPhase('scored');
        setSttTranscribing(false);
        setSttWait(null);
        if (result.passed && currentSeg && p.onPass) p.onPass(currentSeg.index);
        if (result.passed) scheduleNextSentence();
      }

      // 所有识别路径都失败时才使用的最后手段（自评）
      function scoreUnavailable(reason) {
        if (!mountedRef.current) return;
        setSttTranscribing(false);
        setSttWait(null);
        setScore({
          method: 'unavailable',
          value: null,
          passed: false,
          selfPassed: false,
          refText: (seg && seg.en) || '',
          transcript: '',
          label: '自动评分不可用（最后手段：自评）',
          detail: reason ? String(reason) : '本地语音模型和浏览器语音识别都没有返回结果',
        });
        setPhase('scored');
      }

      function fallbackAfterStt(browserText, reason) {
        if (browserText) {
          setSttNotice('本地语音识别未完成（' + reason + '），已改用浏览器语音识别的结果。');
          scoreTranscript(browserText, 'web');
          return;
        }
        setSttNotice('本地语音识别未完成：' + reason);
        scoreUnavailable(reason);
      }

      function sttTranscribe(base64) {
        abortSttRequest();
        var ctrl = new AbortController();
        sttAbortRef.current = ctrl;
        return apiRequest('/stt', 'POST', { audioBase64: base64, language: 'en' }, ctrl.signal)
          .then(function (res) {
            sttAbortRef.current = null;
            return res;
          }, function (err) {
            sttAbortRef.current = null;
            throw err;
          });
      }

      async function transcribeAndScore(seq) {
        var out = await Promise.all([waitForRecBlob(3000), waitTranscript(2500)]);
        if (!isLive(seq)) return;
        var blob = out[0];
        var browserText = String(out[1] || '').trim();
        if (!blob) {
          if (browserText) { scoreTranscript(browserText, 'web'); return; }
          scoreUnavailable('没有拿到录音数据，请再录一次');
          return;
        }
        var wav;
        try {
          wav = await blobToArrayBuffer(blob).then(function (arrayBuffer) {
            return convertToWav16kMono(arrayBuffer);
          });
        } catch (e) {
          if (!isLive(seq)) return;
          fallbackAfterStt(browserText, '录音格式转换失败（' + msgOf(e) + '）');
          return;
        }
        if (!isLive(seq)) return;
        setSttTranscribing(true);
        try {
          var res = await sttTranscribe(wav.base64);
          if (!isLive(seq)) return;
          var text = res && typeof res.text === 'string' ? res.text.trim() : '';
          if (text) { scoreTranscript(text, 'host'); return; }
          fallbackAfterStt(browserText, '本地语音模型没有识别出内容');
        } catch (err) {
          if (!isLive(seq)) return;
          if (err && err.code === 'stt-not-ready') {
            setSttTranscribing(false);
            setSttNotice('本地语音模型还没准备好，正在准备中…');
            var notReadyPhase = (err.data && err.data.phase) || '';
            setSttWait({
              phase: notReadyPhase,
              pct: 0,
              message: err.message || '',
            });
            // 用户已经要求评分：允许自动触发一次模型准备（约 1GB，只下载一次）
            if (!sttPhaseInProgress(notReadyPhase)) prepareStt();
            var ready = await waitSttReady(600000, seq);
            if (!isLive(seq)) return;
            if (!ready) {
              fallbackAfterStt(browserText, '本地语音模型未就绪（请先在面板里点「开始准备模型」）');
              return;
            }
            setSttTranscribing(true);
            try {
              var res2 = await sttTranscribe(wav.base64);
              if (!isLive(seq)) return;
              var text2 = res2 && typeof res2.text === 'string' ? res2.text.trim() : '';
              if (text2) { scoreTranscript(text2, 'host'); return; }
              fallbackAfterStt(browserText, '本地语音模型没有识别出内容');
            } catch (err2) {
              if (!isLive(seq)) return;
              fallbackAfterStt(browserText, msgOf(err2));
            }
            return;
          }
          fallbackAfterStt(browserText, msgOf(err));
        }
      }

      // 最后手段：只有点了这个按钮才标记本句过关
      function selfPass() {
        var currentSeg = seg;
        if (!currentSeg) return;
        setScore(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { selfPassed: true, passed: true });
        });
        if (p.onPass) p.onPass(currentSeg.index);
        scheduleNextSentence();
      }

      function stopRecording() {
        if (phase !== 'recording') return;
        var seq = scoreSeqRef.current + 1;
        scoreSeqRef.current = seq;
        abortSttRequest();
        waitCancelRef.current = false;
        setSttNotice('');
        setSttWait(null);
        recDurRef.current = (Date.now() - (recStartRef.current || Date.now())) / 1000;
        var rec = recorderRef.current;
        try {
          if (rec && rec.state !== 'inactive') rec.stop();
        } catch (e) { /* ignore */ }
        recorderRef.current = null;
        stopTracks();
        stopAudioGraph();
        setLevel(0);
        // 浏览器 SpeechRecognition 作为宿主 STT 失败时的兜底，让它把最后一段结果吐出来
        var r = recognitionRef.current;
        if (r) {
          try { r.stop(); } catch (e) { /* ignore */ }
        }
        setPhase('scoring');
        transcribeAndScore(seq).catch(function (e) {
          if (!isLive(seq)) return;
          fallbackAfterStt(String(transcriptRef.current || '').trim(), msgOf(e));
        });
      }

      function playReference() {
        if (!seg || !seg.clip) {
          if (p.onError) p.onError('本句缺少音频片段（物料可能未生成完整）');
          return;
        }
        var a = clipAudioRef.current;
        if (!a) {
          a = new Audio();
          a.preload = 'auto';
          clipAudioRef.current = a;
          a.onended = function () { setRefPlaying(false); };
          a.onerror = function () {
            setRefPlaying(false);
            if (p.onError) p.onError('原句音频加载失败');
          };
        }
        if (refPlaying) {
          try { a.pause(); } catch (e) { /* ignore */ }
          setRefPlaying(false);
          return;
        }
        try { a.pause(); } catch (e) { /* ignore */ }
        a.src = mediaUrl(seg.clip);
        setRefPlaying(true);
        var pr = a.play();
        if (pr && pr.catch) {
          pr.catch(function (e) {
            setRefPlaying(false);
            if (p.onError) p.onError('无法播放原句音频：' + msgOf(e));
          });
        }
      }

      function playRecording() {
        if (!recUrl) return;
        var a = recAudioRef.current;
        if (!a) {
          a = new Audio();
          recAudioRef.current = a;
          a.onended = function () { setRecPlaying(false); };
          a.onerror = function () { setRecPlaying(false); };
        }
        if (recPlaying) {
          try { a.pause(); } catch (e) { /* ignore */ }
          setRecPlaying(false);
          return;
        }
        try { a.pause(); } catch (e) { /* ignore */ }
        a.src = recUrl;
        setRecPlaying(true);
        var pr = a.play();
        if (pr && pr.catch) {
          pr.catch(function (e) {
            setRecPlaying(false);
            if (p.onError) p.onError('无法播放录音：' + msgOf(e));
          });
        }
      }

      function go(delta) {
        if (phase === 'recording' || phase === 'scoring') return;
        setPos(function (prev) { return clamp(prev + delta, 0, Math.max(0, segments.length - 1)); });
      }

      function randomOne() {
        if (phase === 'recording' || phase === 'scoring') return;
        if (segments.length <= 1) return;
        var next = safePos;
        var guard = 0;
        while (next === safePos && guard < 30) {
          next = Math.floor(Math.random() * segments.length);
          guard += 1;
        }
        setPos(next);
      }

      if (!segments.length) {
        return h(EmptyState, {
          icon: 'mic',
          title: '没有可跟读的句子',
          desc: '本集物料里没有解析出双语台词。请确认字幕文件可用，然后重新生成物料。',
        });
      }

      var recording = phase === 'recording';
      var scoring = phase === 'scoring';

      var sentencePassed = seg && !!passedSet[seg.index];
      var passedCount = passedList.length;

      // 原句逐词高亮：绿色=读对，红色=漏读/读错（与 tokenize 的 token 数严格对齐）
      function renderRefWords(refText, hitFlags) {
        var parts = refWordParts(refText, hitFlags);
        return parts.map(function (part, i) {
          if (part.hit === null) {
            return h('span', { key: 'r' + i, style: { opacity: 0.8 } }, part.text);
          }
          return h('span', {
            key: 'r' + i,
            style: part.hit
              ? { color: C.ok, fontWeight: 650 }
              : { color: C.danger, fontWeight: 650, textDecoration: 'underline' },
          }, part.text);
        });
      }

      // ---- 本地语音模型状态卡（查询 / 准备进度 / 就绪 / 不可用） ----
      var sttCard = null;
      if (sttTranscribing) {
        sttCard = h('div', { style: S.infoBox },
          h('div', { style: { fontWeight: 650 } }, '正在用本地语音模型识别…'),
          h('div', { style: S.noteSmall }, '本机离线识别，通常 1–3 秒；首次识别可能需要加载模型。'));
      } else if (sttWait) {
        sttCard = h('div', { style: S.warnBox },
          h('div', { style: { fontWeight: 650 } }, '本地语音模型准备中…'),
          h('div', null, sttPhaseZh(sttWait.phase) + (sttWait.message ? '：' + sttWait.message : '')),
          sttWait.pct > 0 ? h(ProgressBar, { pct: sttWait.pct }) : null,
          h('div', { style: S.noteSmall }, '准备好后会自动重试这次录音；也可以在下面的模型卡片里点「开始准备模型」。'),
          h('div', { style: S.rowWrap },
            h(Btn, { small: true, variant: 'soft', icon: 'sparkle', onClick: prepareStt, disabled: sttPreparing }, '开始准备模型'),
            h(Btn, {
              small: true,
              variant: 'ghost',
              onClick: function () { waitCancelRef.current = true; },
            }, '不等了，先看其它结果')));
      } else if (sttErr && !sttStatus) {
        sttCard = h('div', { style: S.warnBox },
          h('div', { style: { fontWeight: 650 } }, '本地语音识别服务不可用'),
          h('div', null, sttErr),
          h('div', { style: S.noteSmall }, '会先尝试浏览器语音识别；都不行时可以用最后手段自评。'),
          h(Btn, { small: true, variant: 'soft', icon: 'refresh', onClick: function () { loadSttStatus(); } }, '重试连接'));
      } else if (sttStatus && sttStatus.available === false) {
        sttCard = h('div', { style: S.warnBox },
          h('div', { style: { fontWeight: 650 } }, '本地语音识别服务不可用'),
          h('div', null, String(sttStatus.message || sttStatus.reason || sttStatus.error || '宿主没有提供可用的语音识别服务。')),
          h('div', { style: S.noteSmall }, '会先尝试浏览器语音识别；都不行时可以用最后手段自评。'));
      } else if (sttStatus) {
        var sttState = sttProviderState(sttStatus);
        if (sttState.ready) {
          sttCard = h('div', { style: Object.assign({}, S.infoBox, { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }) },
            h(Chip, { tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '本地语音模型已就绪（离线识别）'),
            sttState.provider && sttState.provider.name
              ? h('span', { style: { fontSize: '11.5px', opacity: 0.6 } }, String(sttState.provider.name))
              : null,
            h(Btn, { small: true, variant: 'ghost', icon: 'refresh', onClick: function () { loadSttStatus(); } }, '刷新'));
        } else {
          sttCard = h('div', { style: S.warnBox },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 650 } },
                '本地语音模型' + (sttPhaseInProgress(sttState.phase) ? '准备中' : '未准备')),
              h(Chip, { tone: 'neutral' }, sttPhaseZh(sttState.phase)),
              sttState.provider && sttState.provider.name
                ? h('span', { style: S.noteSmall }, String(sttState.provider.name))
                : null),
            sttState.message ? h('div', null, sttState.message) : null,
            sttState.provider && Number(sttState.provider.totalBytes) > 0
              ? h('div', null,
                h(ProgressBar, { pct: sttState.progress }),
                h('div', { style: S.noteSmall },
                  '已下载 ' + fmtBytes(sttState.provider.completedBytes)
                  + ' / ' + fmtBytes(sttState.provider.totalBytes)
                  + '（' + Math.round(sttState.progress) + '%）'))
              : null,
            h('div', { style: S.noteSmall },
              '首次使用需要下载约 1GB 的本地语音模型（2–10 分钟，只下载一次）；之后完全离线识别。'),
            h('div', { style: S.rowWrap },
              h(Btn, {
                small: true,
                variant: 'primary',
                icon: 'sparkle',
                onClick: prepareStt,
                disabled: sttPreparing || sttPhaseInProgress(sttState.phase),
              }, sttPreparing
                ? '正在启动…'
                : (sttPhaseInProgress(sttState.phase) ? '模型准备中…' : '开始准备模型')),
              h(Btn, { small: true, variant: 'ghost', icon: 'refresh', onClick: function () { loadSttStatus(); } }, '刷新状态')));
        }
      }

      var scoringHint = null;
      if (scoring && !score && !sttTranscribing && !sttWait) {
        scoringHint = h('div', { style: S.infoBox },
          h('div', { style: { fontWeight: 650 } }, '正在处理录音…'),
          h('div', { style: S.noteSmall }, '正在把录音转换成 16kHz WAV 并识别，通常 1–3 秒。'));
      }

      var scoreBlock = null;
      if (score) {
        var againBtn = h(Btn, { small: true, variant: 'soft', icon: 'refresh', onClick: function () { resetSession(); startRecording(); } }, '再说一次');
        if (score.method === 'speech') {
          var passedScore = !!score.passed;
          var ringValue = typeof score.value === 'number' ? score.value : 0;
          var missedHint = score.missedWords && score.missedWords.length
            ? h('div', { style: { marginTop: '5px', fontSize: '12.5px', color: C.danger, lineHeight: 1.6 } },
              '这几个词再读清楚一点：' + score.missedWords.join('、'))
            : null;
          scoreBlock = h('div', { style: S.scoreCard },
            h(ProgressRing, {
              pct: ringValue,
              size: 68,
              center: ringValue,
              color: passedScore ? C.ok : ACCENT,
            }),
            h('div', { style: { flex: '1 1 260px', minWidth: 0 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
                h('div', { style: { fontSize: '14.5px', fontWeight: 700, color: passedScore ? C.ok : 'inherit' } },
                  passedScore ? '过关！' : '再试一次'),
                h(Chip, { tone: score.source === 'host' ? 'accent' : 'neutral' },
                  score.source === 'host' ? '本地模型识别' : '浏览器识别')),
              h('div', { style: { fontSize: '12.5px', opacity: 0.78, marginTop: '2px' } },
                score.label + ' · 过关线 70 分 · 读对 ' + score.matched + ' / ' + score.totalWords + ' 个词'),
              h('div', { style: { marginTop: '7px' } },
                h('div', { style: { fontSize: '11.5px', opacity: 0.62, marginBottom: '2px' } },
                  '原句对照（绿色=读对，红色=漏读/读错）'),
                h('div', { style: { fontSize: '14px', lineHeight: 1.65, display: 'flex', flexWrap: 'wrap', gap: '0 5px' } },
                  renderRefWords(score.refText || '', score.hits)),
                score.transcript
                  ? h('div', { style: { marginTop: '5px', fontSize: '12.5px', opacity: 0.8, wordBreak: 'break-word' } },
                    '识别到：' + score.transcript)
                  : null,
                missedHint,
                h('div', { style: { marginTop: '6px', fontSize: '12px', opacity: 0.66, lineHeight: 1.6 } },
                  '不要求一模一样，把每个词读清楚就算过；再读两遍会越来越顺。'))
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              passedScore
                ? h(Chip, { tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '本句已过关')
                : h(Chip, { tone: 'warn' }, '差一点点'),
              againBtn)
          );
        } else {
          scoreBlock = h('div', { style: S.scoreCard },
            h(Icon, { name: 'mic', size: 26 }),
            h('div', { style: { flex: '1 1 260px', minWidth: 0 } },
              h('div', { style: { fontSize: '14.5px', fontWeight: 700 } }, '自动评分暂时不可用'),
              h('div', { style: { fontSize: '12.5px', opacity: 0.8, marginTop: '3px', lineHeight: 1.65 } },
                (score.detail ? score.detail + '。' : '')
                + '这是最后手段：可以先播放原句和自己的录音对比，确认读得接近再点「这句算过关（自评）」。'),
              score.selfPassed
                ? h(Chip, { tone: 'ok', style: { marginTop: '6px' } }, h(Icon, { name: 'check', size: 11 }), '本句已自评过关')
                : null),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              againBtn,
              score.selfPassed
                ? null
                : h(Btn, { small: true, variant: 'primary', icon: 'check', onClick: selfPass }, '这句算过关（自评）'))
          );
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '11px' } },
        h('div', { style: S.rowWrap },
          h(Chip, { tone: 'accent' }, '第 ' + (seg.index != null ? seg.index : safePos + 1) + ' 句 / 共 ' + segments.length + ' 句'),
          h(Chip, { tone: 'neutral' }, '已过关 ' + passedCount + ' 句'),
          resumedFrom > 0 && seg && seg.index === resumedFrom
            ? h(Chip, { tone: 'accent' }, '上次读到第 ' + resumedFrom + ' 句')
            : null,
          sentencePassed ? h(Chip, { tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '这句已过关') : null,
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { fontSize: '11.5px', opacity: 0.6 } }, '先听原句，再录音，最后看词级准确度')
        ),
        h('div', { style: S.rowWrap },
          h(Btn, { small: true, variant: 'soft', icon: 'back', onClick: function () { go(-1); }, disabled: recording || scoring || safePos <= 0 }, '上一句'),
          h(Btn, { small: true, variant: 'soft', icon: 'next', onClick: function () { go(1); }, disabled: recording || scoring || safePos >= segments.length - 1 }, '下一句'),
          h(Btn, { small: true, variant: 'ghost', icon: 'shuffle', onClick: randomOne, disabled: recording || scoring }, '随机一句')
        ),
        h('div', { style: S.sentenceBox },
          h('div', { style: S.sentenceEn }, String(seg.en || '（本句缺少英文）')),
          h('div', { style: S.sentenceZh }, String(seg.zh || ''))
        ),
        h('div', { style: S.rowWrap },
          h(Btn, { small: true, icon: refPlaying ? 'pause' : 'sound', onClick: playReference, disabled: recording }, refPlaying ? '停止' : '播放原句'),
          recording
            ? h(Btn, { variant: 'danger', icon: 'stop', onClick: stopRecording }, '停止并评分')
            : h(Btn, { variant: 'primary', icon: 'mic', onClick: startRecording, disabled: scoring }, scoring ? '评分中…' : '开始录音'),
          recUrl ? h(Btn, { small: true, icon: recPlaying ? 'pause' : 'play', onClick: playRecording }, recPlaying ? '停止' : '播放我的录音') : null,
          recording
            ? h('div', { style: S.levelTrack },
              h('div', { style: Object.assign({}, S.levelFill, { width: Math.round(level * 100) + '%' }) }))
            : null,
          recording ? h('span', { style: { fontSize: '12px', color: C.danger, fontWeight: 600 } }, '正在录音…请朗读这句') : null
        ),
        sttCard,
        scoringHint,
        micError
          ? h('div', { style: Object.assign({}, S.bannerBase, S.bannerError) },
            h(Icon, { name: 'cross', size: 14 }),
            h('span', { style: { flex: '1 1 auto' } }, micError),
            h(Btn, { small: true, variant: 'ghost', onClick: startRecording }, '重试'))
          : null,
        sttNotice
          ? h('div', { style: Object.assign({}, S.bannerBase, { background: C.warnSoft, borderColor: C.warnBorder, color: C.warn }) },
            h(Icon, { name: 'cross', size: 14 }),
            h('span', { style: { flex: '1 1 auto' } }, sttNotice),
            h(Btn, { small: true, variant: 'ghost', onClick: function () { setSttNotice(''); } }, '关闭'))
          : null,
        scoreBlock,
        h('div', { style: S.noteSmall },
          '评分方式：录音会在浏览器里转成 16kHz 单声道 WAV，交给本机的本地语音模型（SenseVoice）识别，'
          + '再和原句做词级对齐：得分 = 读对的原句单词数 ÷ 原句总词数 × 100，录音时长不影响评分，70 分过关。'
          + '本地模型不可用时先尝试浏览器语音识别，最后才用自评。')
      );
    }

    // ---- 4.4 磨耳朵（步骤 5） ----
    function ListenPanel(props) {
      var p = props || {};
      var material = p.material || {};
      var audioInfo = material.audio || {};
      var full = audioInfo.full;
      var segments = Array.isArray(material.segments) ? material.segments : [];
      // v2：full.mp3 已去掉片头片尾，用 audioStart/audioEnd 定位；旧物料回退 start - timelineOffset
      var timelineOffset = Number(audioInfo.timelineOffset);
      if (!isFinite(timelineOffset)) {
        // 旧物料没有 timelineOffset 时，用第一段保留区间的起点兜底（通常就是被剪掉的片头长度）
        var keptFirst = Array.isArray(audioInfo.keptIntervals) && audioInfo.keptIntervals.length
          && Array.isArray(audioInfo.keptIntervals[0])
          ? Number(audioInfo.keptIntervals[0][0])
          : NaN;
        timelineOffset = isFinite(keptFirst) ? keptFirst : NaN;
      }
      var audioDuration = Number(audioInfo.audioDuration);
      if (!isFinite(audioDuration) || audioDuration <= 0) audioDuration = NaN;

      var tState = React.useState(0);
      var t = tState[0];
      var setT = tState[1];
      var durState = React.useState(Number(audioInfo.audioDuration) || Number(audioInfo.duration) || 0);
      var duration = durState[0];
      var setDuration = durState[1];
      var playState = React.useState(false);
      var playing = playState[0];
      var setPlaying = playState[1];
      var infoState = React.useState(null);
      var info = infoState[0];
      var setInfo = infoState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var copyState = React.useState('');
      var copyStateText = copyState[0];
      var setCopyState = copyState[1];
      var errState = React.useState('');
      var errText = errState[0];
      var setErrText = errState[1];

      var audioRef = React.useRef(null);
      var linkRef = React.useRef(null);
      var openedRef = React.useRef(false);

      React.useEffect(function () {
        return function () {
          var a = audioRef.current;
          if (a) { try { a.pause(); } catch (e) { /* ignore */ } }
        };
      }, []);

      function markOpened() {
        if (openedRef.current) return;
        openedRef.current = true;
        if (p.onOpened) p.onOpened();
      }

      function togglePlay() {
        var a = audioRef.current;
        if (!a) return;
        if (a.paused) {
          var pr = a.play();
          if (pr && pr.catch) {
            pr.catch(function (e) {
              if (p.onError) p.onError('无法播放完整音频：' + msgOf(e));
            });
          }
          markOpened();
        } else {
          a.pause();
        }
      }

      function seekTo(val) {
        var a = audioRef.current;
        if (!a) return;
        var d = Number(a.duration) || duration || 0;
        a.currentTime = clamp(Number(val) || 0, 0, Math.max(0, d));
      }

      function seekBy(delta) {
        var a = audioRef.current;
        if (!a) return;
        var d = Number(a.duration) || duration || 0;
        a.currentTime = clamp((Number(a.currentTime) || 0) + delta, 0, Math.max(0, d));
      }

      // ---- 音频时间轴映射：full.mp3 里的秒数 -> 句子 ----
      function segAudioStart(seg) {
        if (!seg) return NaN;
        if (typeof seg.audioStart === 'number' && isFinite(seg.audioStart)) return seg.audioStart;
        var st = Number(seg.start);
        if (!isFinite(st)) return NaN;
        return isFinite(timelineOffset) ? Math.max(0, st - timelineOffset) : st;
      }

      function segAudioEnd(seg) {
        if (!seg) return NaN;
        if (typeof seg.audioEnd === 'number' && isFinite(seg.audioEnd)) return seg.audioEnd;
        var en = Number(seg.end);
        if (!isFinite(en)) return segAudioStart(seg);
        return isFinite(timelineOffset) ? Math.max(0, en - timelineOffset) : en;
      }

      // 找到当前播放位置对应的句子（句子按下标升序，audioStart 单调递增）
      function findSegmentIndexByAudio(time) {
        var idx = -1;
        for (var i = segments.length - 1; i >= 0; i--) {
          var st = segAudioStart(segments[i]);
          if (isFinite(st) && st <= time + 0.05) {
            idx = i;
            break;
          }
        }
        return idx;
      }

      function findSegmentByAudio(time) {
        var idx = findSegmentIndexByAudio(time);
        if (idx < 0) return null;
        var seg = segments[idx];
        var end = segAudioEnd(seg);
        if (isFinite(end) && time > end + 0.45) return null;
        return seg;
      }

      function jumpSentence(dir) {
        var a = audioRef.current;
        if (!a) return;
        var cur = Number(a.currentTime) || 0;
        var idx = findSegmentIndexByAudio(cur);
        var target = cur + (dir > 0 ? 10 : -10);
        if (dir > 0) {
          if (idx >= 0 && segments[idx + 1]) {
            var nextStart = segAudioStart(segments[idx + 1]);
            if (isFinite(nextStart)) target = nextStart;
          }
        } else if (idx >= 0 && cur - segAudioStart(segments[idx]) > 1.2) {
          target = segAudioStart(segments[idx]);
        } else if (idx > 0) {
          target = segAudioStart(segments[idx - 1]);
        } else {
          target = 0;
        }
        if (!isFinite(target)) target = cur;
        seekTo(target);
      }

      function makeLink() {
        if (busy) return;
        setBusy(true);
        setErrText('');
        setCopyState('');
        apiGet('/listen-info?episodeId=' + encodeURIComponent(p.episodeId || ''))
          .then(function (res) {
            var url = res.url || (res.info && res.info.url) || '';
            if (!url) throw new Error('后端没有返回手机链接');
            setInfo({ url: url, path: res.path || '' });
            markOpened();
          })
          .catch(function (e) {
            setErrText('生成手机链接失败：' + msgOf(e));
          })
          .then(function () { setBusy(false); });
      }

      function copyLink() {
        if (!info || !info.url) return;
        var text = info.url;
        function fallbackSelect() {
          var el = linkRef.current;
          if (el) {
            try {
              el.focus();
              el.select();
            } catch (e) { /* ignore */ }
          }
          setCopyState('已选中链接，请按 Ctrl+C 复制');
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              setCopyState('已复制到剪贴板');
            }, fallbackSelect);
            return;
          }
        } catch (e) { /* ignore */ }
        fallbackSelect();
      }

      if (!full) {
        return h(EmptyState, {
          icon: 'sound',
          title: '还没有完整音频',
          desc: '本集音频（去头尾的 full.mp3）尚未生成，先回到第 0 步生成物料。',
        });
      }

      var current = findSegmentByAudio(t);
      var reasons = Array.isArray(audioInfo.excludedReasons) ? audioInfo.excludedReasons : [];
      var kept = Array.isArray(audioInfo.keptIntervals) ? audioInfo.keptIntervals : [];

      var reasonRows = reasons.map(function (r, i) {
        return h('div', { key: 'r' + i, style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600 } }, reasonZh(r && r.reason)),
          h('span', { style: { opacity: 0.72 } },
            fmtTime(r && r.start) + ' – ' + fmtTime(r && r.end))
        );
      });

      var linkBlock = info && info.url
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
          h('div', { style: S.linkRow },
            h('input', {
              ref: linkRef,
              readOnly: true,
              value: info.url,
              onFocus: function (e) { try { e.target.select(); } catch (err) { /* ignore */ } },
              style: S.linkInput,
              'aria-label': '手机收听链接',
            }),
            h(Btn, { small: true, icon: 'copy', onClick: copyLink }, '复制')
          ),
          copyStateText ? h('div', { style: { fontSize: '12px', color: C.ok } }, copyStateText) : null,
          h('div', { style: S.note },
            '手机和电脑连同一个 Wi-Fi，在手机浏览器打开即可听完整音频。'),
          h('div', null,
            h('a', { href: info.url, target: '_blank', rel: 'noreferrer', style: S.link }, info.url))
        )
        : null;

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '11px' } },
        h('audio', {
          ref: audioRef,
          src: mediaUrl(full),
          preload: 'metadata',
          style: { display: 'none' },
          onTimeUpdate: function (e) { setT(e.currentTarget.currentTime || 0); },
          onLoadedMetadata: function (e) {
            var d = Number(e.currentTarget.duration);
            if (isFinite(d) && d > 0) setDuration(d);
          },
          onPlay: function () { setPlaying(true); markOpened(); },
          onPause: function () { setPlaying(false); },
          onEnded: function () { setPlaying(false); },
          onError: function () {
            if (p.onError) p.onError('完整音频加载失败，请确认物料里的音频文件存在');
          },
        }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h(Btn, { variant: 'primary', icon: playing ? 'pause' : 'play', onClick: togglePlay }, playing ? '暂停' : '播放'),
          h(Btn, { small: true, icon: 'back', onClick: function () { jumpSentence(-1); }, title: '上一句' }, '上一句'),
          h(Btn, { small: true, icon: 'next', onClick: function () { jumpSentence(1); }, title: '下一句' }, '下一句'),
          h(Btn, { small: true, variant: 'ghost', onClick: function () { seekBy(-10); } }, '−10s'),
          h(Btn, { small: true, variant: 'ghost', onClick: function () { seekBy(10); } }, '+10s'),
          h('span', { style: { fontSize: '11.5px', opacity: 0.72, fontFamily: MONO, whiteSpace: 'nowrap' } },
            fmtTime(t) + ' / ' + fmtTime(duration))
        ),
        h('input', {
          type: 'range',
          min: 0,
          max: Math.max(1, Math.round(duration || 1)),
          step: 0.5,
          value: clamp(t, 0, Math.max(1, duration || 1)),
          style: { width: '100%', accentColor: ACCENT, height: '5px', cursor: 'pointer', margin: 0 },
          onChange: function (e) { seekTo(e.target.value); },
          'aria-label': '音频进度',
        }),
        current
          ? h('div', { style: Object.assign({}, S.infoBox, { gap: '3px' }) },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
              h(Chip, { tone: 'accent' }, '第 ' + (current.index != null ? current.index : '?') + ' 句'),
              h('span', { style: { fontSize: '11px', opacity: 0.6 } },
                fmtTime(segAudioStart(current)) + ' – ' + fmtTime(segAudioEnd(current)) + '（音频时间）')),
            h('div', { style: { fontSize: '13px', fontWeight: 550 } }, String(current.en || '')),
            h('div', { style: { fontSize: '12px', opacity: 0.72 } }, String(current.zh || '')))
          : null,
        h('div', { style: S.infoBox },
          h('div', { style: { fontWeight: 650 } }, '已自动去掉片头与片尾'),
          h('div', { style: S.noteSmall },
            '完整音频时长 ' + fmtDurCn(audioDuration || duration) + '，保留了 ' + kept.length + ' 段正文内容。'
            + '上面的当前句按去掉头尾后的音频时间对齐，和原片时间不同。'),
          reasonRows.length ? h('div', { style: S.reasonList }, reasonRows) : h('div', { style: S.noteSmall }, '没有记录被剪掉的时间段。'),
          h('div', { style: S.noteSmall }, '手机链接播的就是这份去掉片头片尾的音频，适合通勤时反复听。')
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' } },
          h(Btn, { variant: 'soft', icon: 'phone', onClick: makeLink, disabled: busy },
            busy ? '正在生成…' : (info ? '重新生成手机链接' : '生成手机链接')),
          errText ? h('span', { style: { fontSize: '12px', color: C.danger } }, errText) : null
        ),
        linkBlock,
        h('div', { style: S.noteSmall }, '提示：电脑和手机需要在同一个局域网内；如果链接打不开，检查防火墙是否放行了插件的局域网端口。')
      );
    }

    // =====================================================================
    // 5. 剧集详情 + 主面板
    // =====================================================================

    function SettingsPanel(props) {
      var p = props || {};
      return h('div', { style: Object.assign({}, S.card, { display: 'flex', flexDirection: 'column', gap: '11px' }) },
        h('div', { style: S.rowWrap },
          h('div', { style: { fontWeight: 650, fontSize: '15px' } }, p.title || '扫描设置'),
          h('span', { style: { marginLeft: 'auto', fontSize: '11.5px', opacity: 0.6 } }, '自动配对 s01e01 这类文件名')
        ),
        h('div', { style: S.fieldRow },
          h('label', { style: S.field },
            h('span', { style: S.label }, '视频目录'),
            h('input', {
              value: p.mediaDir || '',
              placeholder: '例如 H:\\Friends.S01',
              spellCheck: false,
              onChange: function (e) { if (p.onMediaDir) p.onMediaDir(e.target.value); },
              style: S.input,
            })
          ),
          h('label', { style: S.field },
            h('span', { style: S.label }, '字幕目录（.ass / .srt）'),
            h('input', {
              value: p.subtitleDir || '',
              placeholder: '例如 H:\\Friends.S01',
              spellCheck: false,
              onChange: function (e) { if (p.onSubtitleDir) p.onSubtitleDir(e.target.value); },
              style: S.input,
            })
          )
        ),
        p.error ? h('div', { style: S.warnBox }, p.error) : null,
        h('div', { style: S.rowWrap },
          h(Btn, { variant: 'primary', icon: 'scan', onClick: p.onScan, disabled: p.scanning },
            p.scanning ? '正在扫描…' : '扫描剧集'),
          p.onClose ? h(Btn, { variant: 'ghost', onClick: p.onClose }, '收起') : null,
          p.scanning ? h('span', { style: S.noteSmall }, '正在读取目录并配对视频与字幕…') : null
        ),
        h('div', { style: S.noteSmall },
          '视频文件名需要包含集号（s01e01 / S01E01 都可以）；字幕文件名包含同一个集号即可自动配对。扫描不会移动或删除任何文件。')
      );
    }

    function EpisodeCard(props) {
      var p = props || {};
      var ep = p.episode || {};
      var progress = p.progress || emptyProgress();
      var avail = ep.available || {};
      var steps = stepList(!!avail.material, progress);
      var doneCount = steps.filter(function (s) { return s.done; }).length;

      var imgErrState = React.useState(false);
      var imgErr = imgErrState[0];
      var setImgErr = imgErrState[1];
      var focusState = React.useState(false);
      var focused = focusState[0];
      var setFocused = focusState[1];

      var cardStyle = Object.assign({}, S.epCard);
      if (focused) {
        cardStyle.outline = '2px solid ' + ACCENT;
        cardStyle.outlineOffset = '2px';
      }

      var chips = [];
      if (avail.material) chips.push(h(Chip, { key: 'mat', tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '物料已生成'));
      else chips.push(h(Chip, { key: 'mat', tone: 'warn' }, '需生成'));
      if (avail.subtitle === false) chips.push(h(Chip, { key: 'sub', tone: 'danger' }, '无字幕'));
      else if (avail.subtitle) chips.push(h(Chip, { key: 'sub', tone: 'neutral' }, '有字幕'));
      if (avail.quiz) chips.push(h(Chip, { key: 'quiz', tone: 'neutral' }, '测试已就绪'));

      var posterInner = (!ep.poster || imgErr)
        ? h('div', { style: S.epFallback },
          h('div', { style: S.epFallbackCode }, codeName(ep)),
          h('div', { style: { fontSize: '11.5px', opacity: 0.85 } }, ep.titleZh || ''))
        : h('img', {
          src: mediaUrl(ep.poster),
          alt: codeName(ep) + ' 海报',
          style: S.epPosterImg,
          loading: 'lazy',
          onError: function () { setImgErr(true); },
        });

      var progressText = doneCount + '/6 步 · ' + (progress.quizPassed ? '测试已通过' : progress.watchedSubs || progress.watchedNoSubs ? '观看中' : '未开始');

      return h('div', {
        role: 'button',
        tabIndex: 0,
        style: cardStyle,
        onClick: function () { if (p.onOpen) p.onOpen(ep); },
        onKeyDown: function (e) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            if (p.onOpen) p.onOpen(ep);
          }
        },
        onFocus: function () { setFocused(true); },
        onBlur: function () { setFocused(false); },
        'aria-label': codeName(ep) + ' ' + (ep.titleEn || ''),
      },
        h('div', { style: S.epPoster },
          posterInner,
          h('span', { style: S.epBadge }, codeName(ep))
        ),
        h('div', { style: S.epBody },
          h('div', { style: S.epTitleEn }, String(ep.titleEn || ep.titleZh || '未命名剧集')),
          h('div', { style: S.epTitleZh }, String(ep.titleZh || '')),
          h('div', { style: S.epSummary }, String(ep.summaryEn || ep.summaryZh || '')),
          h('div', { style: S.epChips }, chips),
          h('div', { style: S.epFoot },
            h(StepBars, { steps: steps }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', opacity: 0.66 } },
              h('span', null, progressText)
            )
          )
        )
      );
    }

    function LoadingSkeleton() {
      function block(w, ht, mt) {
        return h('div', { style: Object.assign({}, S.skeletonBlock, { width: w, height: ht + 'px', marginTop: mt || 0 }) });
      }
      var items = [];
      for (var i = 0; i < 6; i++) {
        items.push(h('div', { key: i, style: Object.assign({}, S.card, { display: 'flex', flexDirection: 'column', gap: '9px' }) },
          block('100%', 150),
          block('72%', 15),
          block('46%', 12),
          block('100%', 26)
        ));
      }
      return h('div', { style: S.wide },
        h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
          block('240px', 28),
          block('120px', 28)
        ),
        h('div', { style: S.grid }, items),
        h('div', { style: S.noteSmall }, '正在加载剧集列表…')
      );
    }

    function EpisodeDetail(props) {
      var p = props || {};
      var ep = p.episode || {};
      var show = p.show || {};
      var epId = ep.episodeId || '';
      var avail = ep.available || {};

      var loadingState = React.useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var materialState = React.useState(null);
      var material = materialState[0];
      var setMaterial = materialState[1];
      var quizState = React.useState(null);
      var quiz = quizState[0];
      var setQuiz = quizState[1];
      var loadErrState = React.useState('');
      var loadErr = loadErrState[0];
      var setLoadErr = loadErrState[1];
      var errorState = React.useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var genState = React.useState(null);
      var gen = genState[0];
      var setGen = genState[1];
      var genBusyState = React.useState(false);
      var genBusy = genBusyState[0];
      var setGenBusy = genBusyState[1];
      var quizGenBusyState = React.useState(false);
      var quizGenBusy = quizGenBusyState[0];
      var setQuizGenBusy = quizGenBusyState[1];
      var quizGenMsgState = React.useState('');
      var quizGenMsg = quizGenMsgState[0];
      var setQuizGenMsg = quizGenMsgState[1];
      var quizGenErrState = React.useState('');
      var quizGenErr = quizGenErrState[0];
      var setQuizGenErr = quizGenErrState[1];
      var openState = React.useState(null);
      var openMap = openState[0];
      var setOpenMap = openState[1];
      var progState = React.useState(function () { return loadProgress(epId); });
      var prog = progState[0];
      var setProg = progState[1];
      var jobState = React.useState('');
      var jobId = jobState[0];
      var setJobId = jobState[1];
      var resetTokenState = React.useState(0);
      var resetToken = resetTokenState[0];
      var setResetToken = resetTokenState[1];

      var mountedRef = React.useRef(true);
      var progRef = React.useRef(prog);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () { mountedRef.current = false; };
      }, []);

      function updateProg(patch) {
        var next = Object.assign({}, progRef.current || emptyProgress(), patch);
        progRef.current = next;
        setProg(next);
        saveProgress(epId, next);
        if (p.onProgressChanged) p.onProgressChanged();
      }

      function loadMaterial(showSpinner) {
        if (showSpinner) setLoading(true);
        return apiGet('/material?episodeId=' + encodeURIComponent(epId)).then(function (res) {
          if (!mountedRef.current) return;
          var mat = res.material || (res.library && res.library.material) || null;
          var qz = res.quiz || (res.library && res.library.quiz) || null;
          setMaterial(mat);
          setQuiz(qz);
          setLoadErr('');
          setLoading(false);
        }).catch(function (e) {
          if (!mountedRef.current) return;
          setMaterial(null);
          setQuiz(null);
          setLoading(false);
          var m = msgOf(e);
          // 「还没生成物料」后端一般用 404 / not found 表示，这属于正常状态，交给生成引导
          setLoadErr(/404|not\s*found|不存在|未找到|未生成|没有/i.test(m) ? '' : m);
        });
      }

      React.useEffect(function () {
        loadMaterial(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [epId]);

      function openOf(key) {
        if (openMap && Object.prototype.hasOwnProperty.call(openMap, key)) return !!openMap[key];
        var defaults = {
          gen: !material,
          s1: !prog.watchedSubs,
          s2: !!prog.watchedSubs && !prog.watchedNoSubs,
          quiz: !!(prog.watchedSubs && prog.watchedNoSubs) && !prog.quizPassed,
          shadow: false,
          listen: false,
        };
        return !!defaults[key];
      }

      function toggle(key) {
        var next = !openOf(key);
        setOpenMap(function (prev) {
          var m = Object.assign({}, prev || {});
          m[key] = next;
          return m;
        });
      }

      async function startGenerate(force) {
        if (genBusy) return;
        setError('');
        setGen({ pct: 0, stage: 'start', message: '正在准备生成…', status: 'running' });
        setGenBusy(true);
        try {
          var res = await apiPost('/generate', { episodeId: epId, force: force === true });
          if (!mountedRef.current) return;
          var jid = res.jobId || (res.job && res.job.id) || '';
          if (!jid) throw new Error('后端没有返回任务编号');
          setJobId(jid);
          var deadline = Date.now() + 45 * 60 * 1000;
          while (mountedRef.current && Date.now() < deadline) {
            await sleep(1000);
            if (!mountedRef.current) return;
            var jr = await apiGet('/job?id=' + encodeURIComponent(jid));
            if (!mountedRef.current) return;
            var job = jr.job || jr;
            var pr = job.progress || {};
            setGen({
              pct: typeof pr.pct === 'number' ? clamp(pr.pct, 0, 100) : 0,
              stage: pr.stage || '',
              message: pr.message || '',
              status: job.status || 'running',
            });
            if (job.status === 'done') {
              setGen({ pct: 100, stage: 'done', message: '物料生成完成', status: 'done' });
              await loadMaterial(false);
              if (p.onLibraryRefresh) p.onLibraryRefresh();
              return;
            }
            if (job.status === 'error') {
              throw new Error(job.error || '生成任务失败');
            }
          }
          throw new Error('生成超时（超过 45 分钟），请稍后重试');
        } catch (e) {
          if (mountedRef.current) {
            setGen(null);
            setError('生成本集物料失败：' + msgOf(e));
          }
        } finally {
          if (mountedRef.current) {
            setGenBusy(false);
            setJobId('');
          }
        }
      }

      // 旧物料补生成测试题（只跑 quiz 生成，不重新转码视频/音频）
      async function startQuizGenerate() {
        if (quizGenBusy) return;
        setQuizGenErr('');
        setQuizGenMsg('正在生成测试题…');
        setQuizGenBusy(true);
        try {
          var res = await apiPost('/quiz', { episodeId: epId });
          if (!mountedRef.current) return;
          var jid = res.jobId || (res.job && res.job.id) || '';
          if (!jid) throw new Error('后端没有返回任务编号');
          var deadline = Date.now() + 5 * 60 * 1000;
          while (mountedRef.current && Date.now() < deadline) {
            await sleep(800);
            if (!mountedRef.current) return;
            var jr = await apiGet('/job?id=' + encodeURIComponent(jid));
            if (!mountedRef.current) return;
            var job = jr.job || jr;
            var pr = job.progress || {};
            if (pr.message) setQuizGenMsg(pr.message);
            if (job.status === 'done') {
              await loadMaterial(false);
              if (p.onLibraryRefresh) p.onLibraryRefresh();
              setQuizGenMsg('测试题已生成，可以开始做题了');
              return;
            }
            if (job.status === 'error') throw new Error(job.error || '生成测试题失败');
          }
          throw new Error('生成测试题超时，请稍后重试');
        } catch (e) {
          if (mountedRef.current) setQuizGenErr('生成测试题失败：' + msgOf(e));
        } finally {
          if (mountedRef.current) setQuizGenBusy(false);
        }
      }

      function doResetProgress() {        try {
          var ok = window.confirm('确定要重置本集的学习进度吗？观看记录、测试通过状态和跟读过关记录都会清空。');
          if (!ok) return;
        } catch (e) { /* confirm 不可用就直接重置 */ }
        clearProgress(epId);
        var fresh = emptyProgress();
        progRef.current = fresh;
        setProg(fresh);
        setResetToken(function (n) { return n + 1; });
        if (p.onProgressChanged) p.onProgressChanged();
      }

      var steps = stepList(!!material, prog);
      var doneCount = steps.filter(function (s) { return s.done; }).length;
      var segments = (material && Array.isArray(material.segments)) ? material.segments : [];
      var videoFile = material && material.video ? material.video.file : '';
      var videoDuration = material && material.video ? material.video.duration : 0;
      var subtitleMissing = avail.subtitle === false;
      var quizUnlocked = !!(prog.watchedSubs && prog.watchedNoSubs);

      // ---------- 第 0 步：生成物料 ----------
      var genBody;
      if (material) {
        var segCount = material.stats && material.stats.segmentCount != null
          ? material.stats.segmentCount
          : segments.length;
        genBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: S.rowWrap },
            h(Chip, { tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '物料已生成'),
            h(Chip, { tone: 'neutral' }, '逐句 ' + segCount + ' 句'),
            material.audio && material.audio.duration ? h(Chip, { tone: 'neutral' }, '音频 ' + fmtTime(material.audio.duration)) : null,
            material.generatedAt ? h(Chip, { tone: 'neutral' }, '生成于 ' + fmtDate(material.generatedAt)) : null
          ),
          h('p', { style: S.note },
            '第 1、2 步使用视频代理（mp4，已去掉字幕轨）；第 4、5 步使用去掉片头片尾的完整音频和逐句片段。'),
          gen ? progressBlock() : null,
          h('div', { style: S.rowWrap },
            h(Btn, { small: true, variant: 'soft', icon: 'refresh', onClick: function () { startGenerate(true); }, disabled: genBusy },
              genBusy ? '正在重新生成…' : '重新生成物料（覆盖现有文件）')
          )
        );
      } else if (loading) {
        genBody = h('div', { style: S.note }, '正在读取物料信息…');
      } else {
        genBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          genBusy || gen ? progressBlock() : null,
          h('p', { style: S.note },
            '从原视频 + 中英字幕生成：mp4 视频代理、去掉片头片尾的完整音频、逐句音频片段、双语字幕段落。首次生成需要几分钟。'),
          subtitleMissing
            ? h('div', { style: S.warnBox },
              h('div', { style: { fontWeight: 650 } }, '本集缺少字幕文件'),
              h('div', null,
                '没有字幕就无法生成双语物料。请在「扫描设置」里把字幕目录指向包含该集字幕的文件夹（文件名含 S01E01 即可，例如 S01E01.ass），或把字幕文件放到视频旁边后重新扫描。'),
              p.onNeedSettings
                ? h(Btn, { small: true, variant: 'soft', icon: 'settings', onClick: p.onNeedSettings, style: { alignSelf: 'flex-start', marginTop: '2px' } }, '去设置字幕目录')
                : null)
            : null,
          loadErr ? h('div', { style: S.warnBox }, '读取物料信息失败：' + loadErr) : null,
          h('div', { style: S.rowWrap },
            h(Btn, { variant: 'primary', icon: 'sparkle', onClick: function () { startGenerate(false); }, disabled: genBusy || subtitleMissing || loading },
              genBusy ? '正在生成…' : '生成本集物料'),
            h('span', { style: S.noteSmall },
              subtitleMissing ? '需要先补上字幕文件' : '生成期间可以切到别的页面，但请不要关闭窗口')
          )
        );
      }

      function progressBlock() {
        var pct = gen && typeof gen.pct === 'number' ? gen.pct : 0;
        var stageText = gen ? stageLabel(gen.stage) : '';
        var msg = gen && gen.message ? gen.message : '';
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { style: { fontWeight: 650 } }, gen && gen.status === 'done' ? '物料生成完成' : '正在生成物料'),
            h('span', { style: { marginLeft: 'auto', fontFamily: MONO, fontSize: '12px', opacity: 0.82 } }, Math.round(pct) + '%')
          ),
          h(ProgressBar, { pct: pct }),
          h('div', { style: S.noteSmall },
            [stageText, msg].filter(Boolean).join(' · ')
            + (jobId ? '（任务 ' + String(jobId).slice(0, 8) + '）' : '')
            + (gen && gen.status === 'running' ? '，请稍候…' : '')
          )
        );
      }

      // ---------- 第 1 / 2 步：观看 ----------
      function watchBody(noSubs) {
        if (!material) {
          return h(EmptyState, {
            icon: 'film',
            title: '先生成物料',
            desc: '第 ' + (noSubs ? '2' : '1') + ' 步需要本集的视频代理文件，请先完成第 0 步。',
          });
        }
        if (!videoFile) {
          return h(EmptyState, { icon: 'film', title: '缺少视频文件', desc: '物料里没有视频代理文件，请重新生成物料。' });
        }
        if (!noSubs && !segments.length) {
          return h(EmptyState, {
            icon: 'list',
            title: '没有解析到双语字幕',
            desc: '本集字幕可能格式特殊或没有中英对照。可以继续看无字幕版本，但字幕辅助不可用。',
          });
        }
        return h(VideoStage, {
          videoFile: videoFile,
          duration: videoDuration,
          segments: segments,
          showSubtitles: !noSubs,
          done: noSubs ? !!prog.watchedNoSubs : !!prog.watchedSubs,
          resetToken: resetToken,
          onDone: function (reason) {
            if (noSubs) updateProg({ watchedNoSubs: true });
            else updateProg({ watchedSubs: true });
          },
          onError: function (m) { setError(m); },
        });
      }

      // ---------- 第 3 步：测试 ----------
      function quizBody() {
        if (!quizUnlocked) {
          var missing = [];
          if (!prog.watchedSubs) missing.push('第 1 步 带中英字幕观看');
          if (!prog.watchedNoSubs) missing.push('第 2 步 无字幕观看');
          return h('div', { style: S.warnBox },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontWeight: 650 } },
              h(Icon, { name: 'lock', size: 14 }),
              '测试尚未解锁'),
            h('div', null, '需要先完成：' + missing.join('、') + '。两步都要看到 98% 或播放结束才算完成，顺序不限。'),
            h('div', { style: S.noteSmall }, '观看时可以随时暂停，进度会自动保存在本机。')
          );
        }
        if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) {
          if (!material) {
            return h(EmptyState, {
              icon: 'settings',
              title: '还没有本集物料',
              desc: '请先在步骤 0 生成物料，测试题会随物料一起自动生成。',
            });
          }
          return h('div', { style: S.card },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 650, fontSize: '15px' } },
              h(Icon, { name: 'settings', size: 16 }),
              '本集测试题还未生成'),
            h('div', { style: S.noteSmall },
              '新生成的物料会自动附带测试题；这一集是旧版生成的物料，可以点下面按钮单独补生成测试题，不需要重新转码视频。'),
            h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h(Btn, { variant: 'primary', icon: 'sparkle', onClick: startQuizGenerate, disabled: quizGenBusy },
                quizGenBusy ? '正在生成…' : '生成测试题'),
              quizGenErr
                ? h('span', { style: { fontSize: '12px', color: C.danger } }, quizGenErr)
                : (quizGenMsg ? h('span', { style: { fontSize: '12px', opacity: 0.7 } }, quizGenMsg) : null)
            )
          );
        }
        return h(QuizPanel, {
          quiz: quiz,
          segments: segments,
          passed: !!prog.quizPassed,
          resetToken: resetToken,
          onPass: function () {
            if (!prog.quizPassed) updateProg({ quizPassed: true });
          },
          onError: function (m) { setError(m); },
        });
      }

      // ---------- 第 4 步：跟读 ----------
      function shadowBody() {
        if (!material || !segments.length) {
          return h(EmptyState, {
            icon: 'mic',
            title: '还没有可跟读的句子',
            desc: '跟读需要本集的双语台词段落。先生成物料；如果物料里没有台词，说明字幕文件缺失或格式无法解析。',
          });
        }
        return h(ShadowPanel, {
          segments: segments,
          progress: prog,
          resetToken: resetToken,
          onPass: function (segmentIndex) {
            var list = Array.isArray(progRef.current.shadowPassed) ? progRef.current.shadowPassed.slice() : [];
            if (list.indexOf(segmentIndex) < 0) list.push(segmentIndex);
            updateProg({ shadowPassed: list });
          },
          onPos: function (segmentIndex) {
            if (!Number.isFinite(Number(segmentIndex))) return;
            if (progRef.current && Number(progRef.current.shadowPos) === Number(segmentIndex)) return;
            updateProg({ shadowPos: Number(segmentIndex) });
          },
          onError: function (m) { setError(m); },
        });
      }

      // ---------- 第 5 步：磨耳朵 ----------
      function listenBody() {
        if (!material || !material.audio || !material.audio.full) {
          return h(EmptyState, {
            icon: 'sound',
            title: '还没有完整音频',
            desc: '磨耳朵需要去掉片头片尾的完整音频，请先完成第 0 步生成物料。',
          });
        }
        return h(ListenPanel, {
          material: material,
          episodeId: epId,
          onOpened: function () {
            if (!progRef.current.listenOpened) updateProg({ listenOpened: true });
          },
          onError: function (m) { setError(m); },
        });
      }

      var errorBanner = error
        ? h('div', { style: Object.assign({}, S.bannerBase, S.bannerError) },
          h(Icon, { name: 'cross', size: 15 }),
          h('span', { style: { flex: '1 1 auto' } }, error),
          h(Btn, { small: true, variant: 'ghost', onClick: function () { setError(''); } }, '关闭')
        )
        : null;

      var summaryChips = [
        avail.material ? h(Chip, { key: 'a', tone: 'ok' }, '物料已生成') : h(Chip, { key: 'a', tone: 'warn' }, '需生成物料'),
        avail.subtitle === false ? h(Chip, { key: 'b', tone: 'danger' }, '无字幕') : null,
        avail.quiz ? h(Chip, { key: 'c', tone: 'neutral' }, '测试已就绪') : null,
        prog.quizPassed ? h(Chip, { key: 'd', tone: 'ok' }, h(Icon, { name: 'check', size: 11 }), '测试已通过') : null,
        (prog.shadowPassed || []).length ? h(Chip, { key: 'e', tone: 'neutral' }, '跟读过关 ' + prog.shadowPassed.length + ' 句') : null,
      ].filter(Boolean);

      var posterBlock = h('div', { style: S.poster },
        ep.poster
          ? h('img', {
            src: mediaUrl(ep.poster),
            alt: codeName(ep) + ' 海报',
            style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            onError: function (e) { try { e.currentTarget.style.display = 'none'; } catch (err) { /* ignore */ } },
          })
          : null
      );

      var bodyBlock;
      if (loading) {
        bodyBlock = h('div', { style: S.cardDash }, h('div', { style: S.note }, '正在读取本集物料…'));
      } else {
        bodyBlock = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          h(StepCard, {
            index: 0,
            title: '生成物料',
            subtitle: '视频代理 + 去头尾音频 + 逐句片段 + 双语字幕段落',
            done: !!material,
            open: openOf('gen'),
            onToggle: function () { toggle('gen'); },
            right: material ? h(Chip, { tone: 'ok' }, '已生成') : h(Chip, { tone: 'warn' }, '待生成'),
          }, genBody),

          h(StepCard, {
            index: 1,
            title: '带中英字幕观看',
            subtitle: '跟着原片看，字幕按时间轴自动出现（可切换中/英/双语）',
            done: !!prog.watchedSubs,
            open: openOf('s1'),
            onToggle: function () { toggle('s1'); },
            right: prog.watchedSubs ? h(Chip, { tone: 'ok' }, '已完成') : null,
          }, watchBody(false)),

          h(StepCard, {
            index: 2,
            title: '无字幕观看',
            subtitle: '关掉字幕再听一遍，检验真实听力（两部观看顺序不限）',
            done: !!prog.watchedNoSubs,
            open: openOf('s2'),
            onToggle: function () { toggle('s2'); },
            right: prog.watchedNoSubs ? h(Chip, { tone: 'ok' }, '已完成') : null,
          }, watchBody(true)),

          h(StepCard, {
            index: 3,
            title: '测试',
            subtitle: '一题一屏：单选点选即判分，多选勾选后提交；全部答对才算通过',
            done: !!prog.quizPassed,
            open: openOf('quiz'),
            onToggle: function () { toggle('quiz'); },
            right: !quizUnlocked
              ? h(Chip, { tone: 'warn' }, h(Icon, { name: 'lock', size: 11 }), '需先完成 1、2 步')
              : (prog.quizPassed ? h(Chip, { tone: 'ok' }, '已通过') : null),
          }, quizBody()),

          h(StepCard, {
            index: 4,
            title: '跟读练习',
            subtitle: '逐句听原声 → 录音 → 本地语音模型评分（词级准确度 70 分过关）',
            done: (prog.shadowPassed || []).length > 0,
            open: openOf('shadow'),
            onToggle: function () { toggle('shadow'); },
            right: (prog.shadowPassed || []).length ? h(Chip, { tone: 'ok' }, '过关 ' + prog.shadowPassed.length + ' 句') : null,
          }, shadowBody()),

          h(StepCard, {
            index: 5,
            title: '磨耳朵',
            subtitle: '通勤时用手机听去掉片头片尾的完整音频',
            done: !!prog.listenOpened,
            open: openOf('listen'),
            onToggle: function () { toggle('listen'); },
            right: prog.listenOpened ? h(Chip, { tone: 'ok' }, '已使用') : null,
          }, listenBody())
        );
      }

      return h('div', { style: S.root },
        h('div', { style: S.wide },
          h('div', { style: S.crumbRow },
            h(Btn, { variant: 'ghost', small: true, icon: 'back', onClick: p.onBack }, '返回剧集列表'),
            h('span', { style: { opacity: 0.4 } }, '/'),
            h('span', { style: { opacity: 0.72 } }, String(show.title || '美剧英语')),
            h('span', { style: { opacity: 0.4 } }, '/'),
            h('span', { style: { fontWeight: 650 } }, codeName(ep))
          ),
          h('div', { style: S.detailHead },
            posterBlock,
            h('div', { style: Object.assign({}, S.grow, { display: 'flex', flexDirection: 'column', gap: '2px' }) },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('span', { style: S.codeBadge }, codeName(ep)),
                h('h1', { style: S.detailTitle }, String(ep.titleEn || ep.titleZh || '未命名剧集'))
              ),
              h('div', { style: S.detailZh }, String(ep.titleZh || '')),
              h('p', { style: S.detailSummary }, String(ep.summaryZh || ep.summaryEn || '暂无剧情简介')),
              h('div', { style: S.chipRow }, summaryChips)
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px', flex: '0 0 auto' } },
              h(ProgressRing, { pct: (doneCount / 6) * 100, size: 66, center: doneCount + '/6' }),
              h('span', { style: { fontSize: '11px', opacity: 0.66 } }, '学习进度'),
              h(Btn, { small: true, variant: 'ghost', icon: 'refresh', onClick: doResetProgress }, '重置本集进度')
            )
          ),
          errorBanner,
          bodyBlock,
          h('div', { style: S.footer },
            '学习进度保存在本机浏览器（localStorage），换浏览器或清除缓存会丢失；视频与音频直接来自本机文件，不会上传。')
        )
      );
    }

    function StepCard(props) {
      var p = props || {};
      var focusState = React.useState(false);
      var focused = focusState[0];
      var setFocused = focusState[1];
      var headStyle = Object.assign({}, S.stepHead);
      if (focused) {
        headStyle.outline = '2px solid ' + ACCENT;
        headStyle.outlineOffset = '-2px';
      }
      var numStyle = p.done ? S.stepNumDone : (p.locked ? S.stepNumLocked : S.stepNum);
      return h('section', { style: S.stepCard },
        h('div', {
          style: headStyle,
          role: 'button',
          tabIndex: 0,
          'aria-expanded': !!p.open,
          onClick: p.onToggle,
          onFocus: function () { setFocused(true); },
          onBlur: function () { setFocused(false); },
          onKeyDown: function (e) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
              e.preventDefault();
              if (p.onToggle) p.onToggle();
            }
          },
        },
          h('div', { style: numStyle }, p.done ? h(Icon, { name: 'check', size: 13 }) : String(p.index)),
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: S.stepTitleRow }, h('span', { style: S.stepTitle }, String(p.title || ''))),
            p.subtitle ? h('div', { style: S.stepSub }, String(p.subtitle)) : null
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flex: '0 0 auto' } },
            p.right || null,
            h('span', { style: { display: 'flex', opacity: 0.6, transform: p.open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' } },
              h(Icon, { name: 'chevronDown', size: 15 }))
          )
        ),
        p.open ? h('div', { style: S.stepBody }, p.children) : null
      );
    }

    function App() {
      var libraryState = React.useState(null);
      var library = libraryState[0];
      var setLibrary = libraryState[1];
      var loadingState = React.useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var errorState = React.useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var selectedState = React.useState('');
      var selectedId = selectedState[0];
      var setSelectedId = selectedState[1];
      var settingsState = React.useState(false);
      var settingsOpen = settingsState[0];
      var setSettingsOpen = settingsState[1];
      var mediaState = React.useState('');
      var mediaDir = mediaState[0];
      var setMediaDir = mediaState[1];
      var subState = React.useState('');
      var subtitleDir = subState[0];
      var setSubtitleDir = subState[1];
      var scanErrState = React.useState('');
      var scanErr = scanErrState[0];
      var setScanErr = scanErrState[1];
      var scanOkState = React.useState('');
      var scanOk = scanOkState[0];
      var setScanOk = scanOkState[1];
      var scanningState = React.useState(false);
      var scanning = scanningState[0];
      var setScanning = scanningState[1];
      var versionState = React.useState(0);
      var setProgressVersion = versionState[1];

      var initRef = React.useRef(false);
      var mountedRef = React.useRef(true);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () { mountedRef.current = false; };
      }, []);

      function loadLibrary(opts) {
        var options = opts || {};
        if (options.spinner !== false) setLoading(true);
        return apiGet('/library').then(function (res) {
          if (!mountedRef.current) return;
          var lib = normalizeLibrary(res);
          setLibrary(lib);
          if (!initRef.current) {
            initRef.current = true;
            var settings = lib.settings || {};
            setMediaDir(function (prev) { return prev || settings.mediaDir || ''; });
            setSubtitleDir(function (prev) { return prev || settings.subtitleDir || ''; });
          }
          setError('');
        }).catch(function (e) {
          if (!mountedRef.current) return;
          setError('加载剧集列表失败：' + msgOf(e));
        }).then(function () {
          if (mountedRef.current) setLoading(false);
        });
      }

      React.useEffect(function () {
        loadLibrary();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 库刷新后如果当前剧集消失了，退回列表
      React.useEffect(function () {
        if (!selectedId || !library) return;
        var list = library.episodes || [];
        var found = false;
        for (var i = 0; i < list.length; i++) {
          if (list[i].episodeId === selectedId) { found = true; break; }
        }
        if (!found) setSelectedId('');
      }, [library, selectedId]);

      function bumpProgress() {
        setProgressVersion(function (v) { return v + 1; });
      }

      function doScan() {
        if (scanning) return;
        setScanning(true);
        setScanErr('');
        setScanOk('');
        setError('');
        var body = {
          mediaDir: String(mediaDir || '').trim(),
          subtitleDir: String(subtitleDir || '').trim(),
        };
        if (!body.mediaDir && !body.subtitleDir) {
          setScanning(false);
          setScanErr('请先填写视频目录（例如 H:\\Friends.S01），再点「扫描剧集」。');
          return;
        }
        apiPost('/scan', body).then(function (res) {
          if (!mountedRef.current) return;
          var lib = normalizeLibrary(res);
          if (lib.episodes.length) {
            setLibrary(lib);
            setSettingsOpen(false);
            if (lib.settings) {
              setMediaDir(lib.settings.mediaDir || body.mediaDir);
              setSubtitleDir(lib.settings.subtitleDir || body.subtitleDir);
            }
            var scanned = res.scanned || {};
            setScanOk('扫描完成：识别到 ' + (Number(scanned.episodes) || lib.episodes.length) + ' 集，'
              + '视频 ' + (Number(scanned.videos) || 0) + ' 个，字幕 ' + (Number(scanned.subtitles) || 0) + ' 个。');
            loadLibrary({ spinner: false });
          } else {
            setScanErr('目录里没有识别到剧集。请确认视频文件名包含 s01e01 这样的集号，然后重试。');
          }
        }).catch(function (e) {
          if (!mountedRef.current) return;
          setScanErr('扫描失败：' + msgOf(e));
        }).then(function () {
          if (mountedRef.current) setScanning(false);
        });
      }

      var show = library ? (library.show || {}) : {};
      var settings = library ? (library.settings || {}) : {};
      var episodes = library ? (library.episodes || []) : [];
      var configured = !!((settings.mediaDir || '') || (settings.subtitleDir || '') || mediaDir || subtitleDir);
      var showSettings = settingsOpen || !configured;

      var selected = null;
      for (var i = 0; i < episodes.length; i++) {
        if (episodes[i].episodeId === selectedId) { selected = episodes[i]; break; }
      }

      var bodyBlock;
      if (selected) {
        bodyBlock = h(EpisodeDetail, {
          key: selected.episodeId,
          episode: selected,
          show: show,
          onBack: function () { setSelectedId(''); },
          onLibraryRefresh: function () { loadLibrary({ spinner: false }); },
          onProgressChanged: bumpProgress,
          onNeedSettings: function () { setSelectedId(''); setSettingsOpen(true); },
        });
        return bodyBlock;
      }

      if (loading && !library) {
        return h('div', { style: S.root }, h(LoadingSkeleton));
      }

      var errorBanner = error
        ? h('div', { style: Object.assign({}, S.bannerBase, S.bannerError) },
          h(Icon, { name: 'cross', size: 15 }),
          h('span', { style: { flex: '1 1 auto' } }, error),
          h(Btn, { small: true, variant: 'ghost', onClick: function () { setError(''); } }, '关闭'),
          h(Btn, { small: true, variant: 'soft', onClick: function () { loadLibrary(); } }, '重新加载')
        )
        : null;

      var okBanner = scanOk
        ? h('div', { style: Object.assign({}, S.bannerBase, S.bannerOk) },
          h(Icon, { name: 'check', size: 15 }),
          h('span', { style: { flex: '1 1 auto' } }, scanOk),
          h(Btn, { small: true, variant: 'ghost', onClick: function () { setScanOk(''); } }, '关闭')
        )
        : null;

      var settingsBlock = showSettings
        ? h(SettingsPanel, {
          title: configured ? '扫描设置' : '第一步：让插件找到你的剧集目录',
          mediaDir: mediaDir,
          subtitleDir: subtitleDir,
          error: scanErr,
          scanning: scanning,
          onMediaDir: setMediaDir,
          onSubtitleDir: setSubtitleDir,
          onScan: doScan,
          onClose: configured ? function () { setSettingsOpen(false); } : null,
        })
        : null;

      var gridBlock;
      if (!library) {
        gridBlock = h('div', { style: S.card },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
            h('div', { style: { fontWeight: 650, fontSize: '15px' } }, '剧集列表加载失败'),
            h('p', { style: S.note }, error || '暂时无法连接插件后端。'),
            h(Btn, { variant: 'primary', icon: 'refresh', onClick: function () { loadLibrary(); } }, '重试')
          )
        );
      } else if (!episodes.length) {
        gridBlock = h(EmptyState, {
          icon: 'film',
          title: '还没有可学习的剧集',
          desc: '设置好视频目录并扫描后，这里会出现 24 张剧集卡片。',
          children: h(Btn, { variant: 'primary', icon: 'scan', onClick: function () { setSettingsOpen(true); }, style: { marginTop: '4px' } }, '扫描剧集'),
        });
      } else {
        var cards = episodes.map(function (ep) {
          return h(EpisodeCard, {
            key: ep.episodeId,
            episode: ep,
            progress: loadProgress(ep.episodeId),
            onOpen: function (item) { setSelectedId(item.episodeId); },
          });
        });
        gridBlock = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '11px' } },
          h('div', { style: S.sectionHead },
            h('div', null,
              h('h2', { style: S.sectionTitle }, '我的剧集'),
              h('p', { style: S.sectionSub }, '共 ' + episodes.length + ' 集 · 点卡片进入六步学习流程')
            ),
            h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' } },
              h('span', { style: { fontSize: '11.5px', opacity: 0.55 } },
                '已完成 ' + episodes.filter(function (ep) { return !!loadProgress(ep.episodeId).quizPassed; }).length + ' 集测试'),
              h(Btn, { small: true, variant: 'ghost', icon: 'refresh', onClick: function () { loadLibrary(); } }, '刷新')
            )
          ),
          h('div', { style: S.grid }, cards)
        );
      }

      return h('div', { style: S.root },
        h('div', { style: S.wide },
          h('header', { style: S.header },
            h('div', { style: S.brand },
              h('div', { style: S.brandIcon }, h(Icon, { name: 'film', size: 19 })),
              h('div', null,
                h('h1', { style: S.h1 }, String(show.title || '美剧英语')),
                h('div', { style: S.brandSub },
                  [show.titleEn, show.year ? String(show.year) : '', '看美剧 · 练英语'].filter(Boolean).join(' · '))
              )
            ),
            h('div', { style: S.headerActions },
              h(Btn, { variant: 'soft', icon: 'settings', onClick: function () { setSettingsOpen(function (v) { return !v; }); } },
                settingsOpen ? '收起设置' : '扫描设置'),
              h(Btn, { variant: 'ghost', icon: 'refresh', onClick: function () { loadLibrary(); } }, '刷新')
            )
          ),
          errorBanner,
          okBanner,
          settingsBlock,
          gridBlock,
          h('div', { style: S.footer },
            '剧集数据来自本机的 catalog.json；扫描只读取文件名，不会移动或删除文件。学习进度保存在本机浏览器。')
        )
      );
    }

    // =====================================================================
    // 6. 插件导出
    // =====================================================================

    function Panel() {
      return h(ErrorBoundary, null, h(App));
    }

    function SidebarIcon(props) {
      var size = (props && props.size) || 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 2.4, y: 4.6, width: 15.2, height: 10, rx: 2 }),
        h('path', { d: 'M2.4 8.1h15.2' }),
        h('path', { d: 'M6.2 4.6l1.7 3.5M10.4 4.6l1.7 3.5M14.6 4.6l1.2 2.5' }),
        h('path', { d: 'M5.4 17h9.2' })
      );
    }

    var plugin = {
      name: PANEL_ID,
      inject: ['slots'],
      apply: function (ctx) {
        try {
          var slots = ctx && ctx.slots;
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            console.warn('[meiju-english] slots service unavailable');
            return;
          }
          slots.inject('main', function () {
            return slots.register({ name: 'main', key: PANEL_ID }, Panel);
          });
          slots.inject('sidebar.panellist', function () {
            return slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: function () { return '美剧英语'; },
            }, SidebarIcon);
          });
        } catch (e) {
          console.warn('[meiju-english] client apply failed:', e && e.message);
        }
      },
    };

    module.exports = plugin;
    return module.exports;
  },
});
