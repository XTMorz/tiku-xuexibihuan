/* ============================================================================
 * 题库 · 学习闭环
 * 存储：localStorage，PDF 解析：PDF.js + 正则规则
 * ========================================================================== */

const STORAGE_KEY = 'tiku-app-v1';
const APP_VERSION = 3;  // v3: 教材可手动排序（order 字段）、文艺风 UI、右滑删除

// 配置 PDF.js worker
if (window.pdfjsLib) {
  // 指向本地 vendor：避免在离线 / file:// 协议下无法加载
  pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.js';
}

/* ============ mupdf.js 兜底解析（解决 PDF.js 抽不到 Identity-H 无 ToUnicode 的 PDF） ============ */
async function ensureMupdf() {
  if (window.mupdfLib) return window.mupdfLib;
  // mupdf-loader.js 已经预先开始加载；如果还没好，等待
  const mod = await import('./vendor/mupdf-loader.js');
  return mod.loadMupdf();
}

/* ============ 状态 ============ */
const defaultState = () => ({
  version: APP_VERSION,
  books: [],            // [{ id, name, createdAt }] 顶层教材，每本对应一份 PDF/一次导入
  chapters: [],         // { id, bookId, name, createdAt }
  questions: [],        // { id, chapterId, stem, options:[{key,text}], answer, explanation, note,
                        //   isWrong, isFav, attempts, correct, lastAt, history:[{at,userAnswer,isCorrect}] }
  practice: {           // 当前正在进行的练习
    active: false,
    set: [],            // question id 列表
    idx: 0,
    mode: 'sequential', // or 'shuffle'
    range: 'all',
    chapterId: null,
  },
});

let state = loadState();
let pendingParsed = null;  // 解析预览时的暂存
let pendingPdfDoc = null;  // 扫描件 PDF 的 pdfjs 引用，供 OCR 流程使用
let pendingPdfName = null; // 当前解析的 PDF 文件名，作为新教材的默认名
let pendingSourceText = null; // 解析时的教材原文缓存，确认导入后存入对应教材
let editingQuestionId = null;
let ocrCancelled = false;  // OCR 中断标志

/**
 * 题型 → { 标签, 图标, css class }
 * 用于在题卡 / 练习区显示题型 chip
 */
function qtypeInfo(qtype) {
  return ({
    single: { text: '单项选择题', icon: 'target', cls: 'qt-single' },
    multi:  { text: '多项选择题', icon: 'checkOutline', cls: 'qt-multi' },
    judge:  { text: '判断题', icon: 'checkOutline', cls: 'qt-judge' },
    calc:   { text: '计算分析题', icon: 'bolt', cls: 'qt-calc' },
    essay:  { text: '综合题', icon: 'note', cls: 'qt-essay' },
  })[qtype] || { text: '题目', icon: 'target', cls: 'qt-unknown' };
}

/* ============ 题型判定 · 分值 · 判分 ============ */

/**
 * 客观题每题分值
 *   单项选择题：每题 1.5 分，只有一个正确答案，错选或不答不得分
 *   多项选择题：每题 2 分，两个及以上正确答案；全部选对得满分，少选得相应分值，多选/错选/不答不得分
 *   判断题：每题 1 分，答对得分，答错或不答不得分（也不扣分）
 */
const OBJECTIVE_SCORE = { single: 1.5, multi: 2, judge: 1 };
/**
 * 主观题整段满分：计算分析题共 22 分。
 * 同一章节内该题型的题目平分这 22 分（如 5 小问 → 每问 4.4 分）；
 * 题干/题目自带 q.score 时以 q.score 为准。
 */
const SUBJECTIVE_SECTION_SCORE = { calc: 22, essay: 22 };

/** 保留两位小数（四舍五入） */
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
/** 分值显示：整数不带小数点，小数最多两位且去掉末尾 0 */
function fmtScore(n) {
  const v = round2(n);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** 答案文本是否是「多个选项字母」——只允许字母与分隔符，避免把解析文字误判成答案 */
function isMultiAnswerText(answer) {
  const a = String(answer || '').trim();
  if (!/^[A-H](?:[\s,、]*[A-H])+$/i.test(a)) return false;
  return new Set(a.replace(/[\s,、]/g, '').toUpperCase().split('')).size > 1;
}

/**
 * 统一解析题型的「原始键」：single / multi / judge / calc / essay
 * 这是所有按题型分流（作答控件 / 判分 / 筛选）的唯一入口。
 */
function resolveQtypeRaw(q) {
  const qtRaw = String(q.qtype || '').toLowerCase();
  // 判断/主观题：标签可信，直接返回（也避免对长题干做多余的正则）
  if (qtRaw === 'judge' || qtRaw === 'calc' || qtRaw === 'essay') return qtRaw;
  const hasOwnOptions = !!(q.options && q.options.length);
  const looksMulti = isMultiAnswerText(q.answer) || /多选|多项/.test(String(q.stem || ''));
  if (qtRaw === 'single' || qtRaw === 'multi') {
    if (!hasOwnOptions) {
      // 标了选择题却没有选项数组：可能是题干里内联写着「A. xxx B. xxx」的老数据
      if (!guessOptionsFromStem(q.stem).length) {
        return /^(.{0,4})?(对|错|正确|错误|是|否|对不对|√|×|T|F|True|False)$/i.test(String(q.answer || '').trim())
          ? 'judge' : 'essay';
      }
    }
    // 修复：数据里被标成「单选」但答案就是多个字母（解析器把多选题归成了单选）→ 纠正为多选，
    //   否则用户会被限制成只能选一个选项，判分规则也会用错。
    if (looksMulti) return 'multi';
    return qtRaw;
  }
  // 没有题型标记的老数据 → 启发式
  const options = hasOwnOptions ? q.options : guessOptionsFromStem(q.stem);
  if (options.length) return looksMulti ? 'multi' : 'single';
  return /^(.{0,4})?(对|错|正确|错误|是|否|对不对|√|×|T|F|True|False)$/i.test(String(q.answer || '').trim())
    ? 'judge' : 'essay';
}

/** 题型原始键 → 作答控件类型：choice（选项按钮）/ tf（对错按钮）/ essay（文字作答） */
function qtypeToInputMode(qtypeRaw) {
  if (qtypeRaw === 'single' || qtypeRaw === 'multi') return 'choice';
  if (qtypeRaw === 'judge') return 'tf';
  return 'essay';
}

/**
 * 主观题按章节均分时的「同题型题数」缓存。
 * 每次 saveState（题库可能改动）都会失效，避免大题库下反复全表扫描。
 */
let _peerCountCache = { sig: '', map: {} };
function subjectivePeerCount(qtypeRaw, chapterId) {
  const qs = state.questions || [];
  const sig = qs.length + '|' + qtypeRaw;
  if (_peerCountCache.sig !== sig) _peerCountCache = { sig, map: {} };
  const key = chapterId || '';
  if (_peerCountCache.map[key] === undefined) {
    let n = 0;
    for (const x of qs) {
      if ((x.chapterId || '') === key && resolveQtypeRaw(x) === qtypeRaw) n++;
    }
    _peerCountCache.map[key] = n;
  }
  return _peerCountCache.map[key];
}

/** 本题满分 */
function fullScoreOf(q, qtypeRaw, peerCount) {
  if (typeof q.score === 'number' && q.score > 0) return q.score;   // 题目自带分值（手动录入/编辑过）
  const sectionTotal = SUBJECTIVE_SECTION_SCORE[qtypeRaw];
  if (sectionTotal) {
    const n = peerCount || subjectivePeerCount(qtypeRaw, q.chapterId);
    return round2(sectionTotal / Math.max(1, n));
  }
  return OBJECTIVE_SCORE[qtypeRaw] || 1;
}

/** 已选选项（兼容旧数据：字符串 'A' 与数组 ['A','B']） */
function selectedKeysOf(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split('');
  const keys = arr.map(k => String(k).toUpperCase())
    .filter(k => /^[A-H]$/.test(k) || k === '√' || k === '×');
  return [...new Set(keys)].sort();
}

/**
 * 从 "A" / "ABD" / "A、B、D" / "A B C" / "A. 文本" / 选项全文 里解析出选项键数组
 */
function normalizeAnswerKeys(answer, options) {
  if (!answer || !options || !options.length) return [];
  const valid = new Set(options.map(o => String(o.key).toUpperCase()));
  const a = String(answer).trim();
  // ① 整串就是字母组合（多选常见写法）
  const compact = a.replace(/[\s,、\.\:\uff1a]+/g, '');
  if (/^[A-H]+$/i.test(compact)) {
    const ks = [...new Set(compact.toUpperCase().split(''))].filter(k => valid.has(k));
    if (ks.length) return ks.sort();
  }
  // ② 开头带少量修饰词的字母组合：「答案 ABD」「选 A、B」
  const head = a.match(/^[^A-Ha-h]{0,8}([A-H](?:[\s,、]*[A-H])*)(?![a-z])/);
  if (head) {
    const ks = [...new Set(head[1].toUpperCase().replace(/[\s,、]/g, '').split(''))].filter(k => valid.has(k));
    if (ks.length) return ks.sort();
  }
  // ③ 答案写的是选项全文（多选用、/，分隔）
  const byText = [];
  for (const p of a.split(/[、,;；\/|]+/).map(s => s.trim()).filter(Boolean)) {
    const clean = p.replace(/^[A-H][\.\、\:\uff1a]\s*/i, '');
    const o = options.find(x => x.text && x.text.trim() === clean);
    if (o) byText.push(o.key);
  }
  if (byText.length) return [...new Set(byText)].sort();
  // ④ 兜底：单个大写字母（不带后续字母），或整串等于某个选项文本
  const m1 = a.match(/^([A-H])(?![A-Za-z])/);
  if (m1 && valid.has(m1[1])) return [m1[1]];
  for (const o of options) if (o.text && a === o.text.trim()) return [o.key];
  return [];
}

/** 旧接口：返回字母串（'A' / 'ABD'），无匹配返回 null */
function normalizeAnswerKey(answer, options) {
  const ks = normalizeAnswerKeys(answer, options);
  return ks.length ? ks.join('') : null;
}

/**
 * 判分
 * @returns {{level:'full'|'partial'|'zero', score:number, wrongKeys:string[], missKeys:string[]}}
 */
function gradeChoiceAnswer(selected, correct, qtypeRaw, fullScore) {
  const sel = [...new Set(selected)].sort();
  const cor = [...new Set(correct)].sort();
  if (!cor.length) return { level: 'zero', score: 0, wrongKeys: sel, missKeys: [], unknown: true };
  if (!sel.length) return { level: 'zero', score: 0, wrongKeys: [], missKeys: cor };
  if (qtypeRaw === 'multi') {
    const wrongKeys = sel.filter(k => !cor.includes(k));
    if (wrongKeys.length) return { level: 'zero', score: 0, wrongKeys, missKeys: [] };  // 多选、错选：不得分
    const missKeys = cor.filter(k => !sel.includes(k));
    if (!missKeys.length) return { level: 'full', score: fullScore, wrongKeys: [], missKeys: [] };
    // 少选得相应分值：按选对的个数占正确选项个数的比例给分
    return { level: 'partial', score: round2(fullScore * sel.length / cor.length), wrongKeys: [], missKeys };
  }
  // 单选 / 判断：完全一致才得分，错选或不答不得分
  const ok = sel.length === 1 && cor.length === 1 && sel[0] === cor[0];
  return ok
    ? { level: 'full', score: fullScore, wrongKeys: [], missKeys: [] }
    : { level: 'zero', score: 0, wrongKeys: sel.filter(k => !cor.includes(k)), missKeys: cor.filter(k => !sel.includes(k)) };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    const merged = {
      ...d,
      ...s,
      books: s.books || [],
      chapters: s.chapters || [],
      questions: s.questions || [],
      practice: { ...d.practice, ...(s.practice || {}) },
    };
    // 数据迁移：v1 → v2，把没有 bookId 的章节归到"未分类教材"
    if (!merged.books.length && merged.chapters.length) {
      const orphanId = uid();
      merged.books = [{ id: orphanId, name: '未分类（历史数据）', createdAt: Date.now(), order: 0 }];
      merged.chapters.forEach(c => { c.bookId = orphanId; });
    }
    // 给所有未填 bookId 的章节填一个 fallback（兜底）
    if (merged.books.length && merged.chapters.some(c => !c.bookId)) {
      let fallback = merged.books.find(b => b.name === '未分类（历史数据）');
      if (!fallback) {
        fallback = { id: uid(), name: '未分类（历史数据）', createdAt: Date.now(), order: 0 };
        merged.books.push(fallback);
      }
      merged.chapters.forEach(c => { if (!c.bookId) c.bookId = fallback.id; });
    }
    // 数据迁移：v2 → v3，给没有 order 的教材补 order（按 createdAt 升序）
    merged.books.forEach((b, i) => {
      if (typeof b.order !== 'number') b.order = i;
    });
    // 数据迁移：给老题补 qtype 字段（v3 之前没有题型标记）
    merged.questions.forEach(q => {
      if (!q.qtype) {
        // 有选项的题：答案是多字母或题干写了「多项/多选」的按多选标记，其余按单选
        if (q.options && q.options.length) {
          q.qtype = (isMultiAnswerText(q.answer) || /多选|多项/.test(String(q.stem || '')))
            ? 'multi' : 'single';
        }
        else {
          const a = String(q.answer || '').trim();
          if (/^(对|错|正确|错误|√|×|T|F|True|False)$/i.test(a)) q.qtype = 'judge';
          else q.qtype = 'single'; // 老数据兜底视为单选（最常见）
        }
      }
    });
    return { ...merged, version: APP_VERSION };
  } catch (e) {
    console.warn('加载本地数据失败', e);
    return defaultState();
  }
}
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('保存失败：' + e.message);
  }
  _peerCountCache = { sig: '', map: {} };   // 题库可能已改动 → 分值缓存失效
}

/* ============ 工具 ============ */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
function findChapter(id) { return state.chapters.find(c => c.id === id); }
function findBook(id) { return state.books.find(b => b.id === id); }
function chaptersOfBook(bookId) { return state.chapters.filter(c => c.bookId === bookId); }
function questionsOfChapter(chapterId) {
  return state.questions.filter(q => q.chapterId === chapterId);
}
function questionsOfBook(bookId) {
  const chapIds = new Set(chaptersOfBook(bookId).map(c => c.id));
  return state.questions.filter(q => chapIds.has(q.chapterId));
}

/* ============ Tabs ============ */
function switchTab(target) {
  const btn = $(`.tab[data-tab="${target}"]`);
  if (!btn) return;
  $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === target));
  if (target === 'wrong') renderWrongBook();
  if (target === 'fav') renderFavorites();
  if (target === 'stats') renderStats();
  if (target === 'library') {
    renderSidebar();
    renderLibrary();
  }
  if (target === 'practice') {
    const practiceTab = $('.tab[data-tab="practice"]');
    $$('.tab').forEach(b => b.classList.toggle('active', b === practiceTab));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'practice'));
    // 修复：原来这里调用的 renderPractice() 全项目没有定义，切到练习页会抛
    //   ReferenceError（视图已切换，所以看不出来，但练习卡片不会重绘）。
    renderPracticeCard();
  }
}
function initTabs() {
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // bento 卡全局委托：data-go="library|practice|wrong|fav|stats" → 切到对应 tab
  document.addEventListener('click', e => {
    const card = e.target.closest('.bento-card[data-go]');
    if (!card) return;
    if (e.target.closest('button, a, input, select, textarea')) return; // 不拦截内部表单
    switchTab(card.dataset.go);
  });
}

/* ============ 题库：侧栏 + 主区 ============ */
let currentChapterId = null;
let currentBookId = null;
let libSearchQuery = '';

function renderSidebar() {
  const ul = $('#chapter-list');
  const total = state.questions.length;

  // 当前选中上下文：可能是教材或章节
  let html = `<li class="chapter-list-row all-item ${!currentChapterId && !currentBookId ? 'active' : ''}" data-kind="all">
    <div class="row-content">
      <span class="name">${icon('folder', 'icon icon-mauve')}<span>所有题库</span></span>
      <span class="count">${total}</span>
    </div>
  </li>`;

  state.books
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach(b => {
      const chaps = chaptersOfBook(b.id);
      const bookQ = chaps.reduce((s, c) => s + questionsOfChapter(c.id).length, 0);
      const isCurrentBook = currentBookId === b.id;
      const isExpanded = isCurrentBook || chaps.some(c => c.id === currentChapterId);
      html += `
        <li class="chapter-list-row book-item ${isCurrentBook ? 'active' : ''}"
            draggable="true" data-kind="book" data-id="${b.id}">
          <div class="row-content">
            <span class="caret">${icon(isExpanded ? 'caretDown' : 'caretRight', 'icon icon-muted icon-sm')}</span>
            <span class="name" title="双击重命名教材 · 拖动排序">${escapeHTML(b.name)}</span>
            <span class="count">${bookQ}</span>
          </div>
          <div class="swipe-action" data-act="swipe-del">${icon('trash', 'icon icon-danger')}<span>删除</span></div>
        </li>
      `;
      if (isExpanded) {
        chaps
          .slice()
          .sort((a, b) => a.createdAt - b.createdAt)
          .forEach(c => {
            const qc = questionsOfChapter(c.id).length;
            html += `
              <li class="chapter-list-row chapter-item ${currentChapterId === c.id ? 'active' : ''}" data-kind="chapter" data-id="${c.id}">
                <div class="row-content">
                  <span class="name" title="双击重命名章节">${escapeHTML(c.name)}</span>
                  <span class="count">${qc}</span>
                </div>
                <div class="swipe-action" data-act="swipe-del">${icon('trash', 'icon icon-danger')}<span>删除</span></div>
              </li>
            `;
          });
      }
    });

  ul.innerHTML = html;
  bindSidebarEvents(ul);
}

/* ============ 侧栏事件：点击 / 双击 / 拖拽 / 右滑 ============ */
let dragSrcId = null;
function bindSidebarEvents(ul) {
  ul.querySelectorAll('.chapter-list-row').forEach(li => {
    const kind = li.dataset.kind;
    const id = li.dataset.id;
    const rowContent = li.querySelector('.row-content');
    const swipeAction = li.querySelector('.swipe-action');

    // ===== 点击 row-content =====
    rowContent.addEventListener('click', e => {
      // 如果当前在 swiped 状态，先收起
      if (li.classList.contains('swiped')) {
        li.classList.remove('swiped');
        return;
      }
      if (kind === 'all') {
        currentChapterId = null;
        currentBookId = null;
      } else if (kind === 'book') {
      // 一级分类（教材）toggle 展开/折叠——不依赖 chapter
      const isBookExpanded = currentBookId === id
        || state.chapters.some(c => c.bookId === id && c.id === currentChapterId);
      if (isBookExpanded) {
        // 当前已展开 → 折叠
        currentBookId = null;
        currentChapterId = null;
      } else {
        // 当前未展开 → 展开
        currentBookId = id;
        currentChapterId = null;
      }
    } else if (kind === 'chapter') {
        currentChapterId = id;
        currentBookId = findChapter(id)?.bookId || null;
      }
      renderSidebar();
      renderLibrary();
    });

    // ===== 双击重命名 =====
    rowContent.addEventListener('dblclick', e => {
      e.preventDefault(); e.stopPropagation();
      if (kind === 'book') openRenameBookModal(id);
      else if (kind === 'chapter') openRenameChapterModal(id);
    });

    // ===== 点 swipe-action =====
    if (swipeAction) {
      swipeAction.addEventListener('click', e => {
        e.stopPropagation();
        if (kind === 'book') deleteBook(id);
        else if (kind === 'chapter') deleteChapter(id);
      });
    }

    // ===== 拖拽排序（仅教材）=====
    if (kind === 'book') {
      li.addEventListener('dragstart', e => {
        dragSrcId = id;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', id); } catch {}
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        ul.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
        dragSrcId = null;
      });
      li.addEventListener('dragover', e => {
        if (!dragSrcId || dragSrcId === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        ul.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
        li.classList.add('drop-target');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
      li.addEventListener('drop', e => {
        e.preventDefault();
        li.classList.remove('drop-target');
        if (!dragSrcId || dragSrcId === id) return;
        reorderBook(dragSrcId, id);
      });
    }

    // ===== 右滑 / 左滑手势 =====
    if (swipeAction) attachSwipeGesture(li, rowContent);
  });

  // 点击空白处收起所有 swiped
  document.addEventListener('click', e => {
    if (!e.target.closest('#chapter-list')) {
      ul.querySelectorAll('.chapter-list-row.swiped').forEach(x => x.classList.remove('swiped'));
    }
  }, { once: false });
}

function reorderBook(srcId, dstId) {
  if (srcId === dstId) return;
  const src = findBook(srcId);
  const dst = findBook(dstId);
  if (!src || !dst) return;
  const books = state.books.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const srcIdx = books.findIndex(b => b.id === srcId);
  const dstIdx = books.findIndex(b => b.id === dstId);
  if (srcIdx < 0 || dstIdx < 0) return;
  // 把 src 移到 dst 之后（drop 在 dst 上 = src 排到 dst 后面）
  const [moved] = books.splice(srcIdx, 1);
  books.splice(srcIdx < dstIdx ? dstIdx : dstIdx, 0, moved);
  books.forEach((b, i) => b.order = i);
  saveState();
  renderSidebar();
  toast(`已将「${moved.name}」移动`);
}

function attachSwipeGesture(li, rowContent) {
  let startX = 0, startY = 0, currentX = 0, swiping = false, started = false;
  const THRESHOLD = 60;
  const MAX = 108;

  rowContent.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; currentX = 0;
    swiping = false; started = true;
    rowContent.style.transition = 'none';
    try { rowContent.setPointerCapture(e.pointerId); } catch {}
  });

  rowContent.addEventListener('pointermove', e => {
    if (!started) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!swiping) {
      // 判断是水平还是垂直手势
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) { started = false; return; }
      swiping = true;
    }
    // 允许左滑（dx < 0）和右滑（dx > 0）但右滑时如果有 swiped 就收起
    let offset = 0;
    if (dx < 0) offset = Math.max(dx, -MAX);
    else if (dx > 0 && li.classList.contains('swiped')) offset = Math.min(dx, MAX);
    else return;
    currentX = offset;
    rowContent.style.transform = `translateX(${offset}px)`;
  });

  rowContent.addEventListener('pointerup', e => {
    if (!started) return;
    started = false;
    rowContent.style.transition = '';
    rowContent.style.transform = '';
    if (!swiping) return;
    if (currentX <= -THRESHOLD) {
      li.classList.add('swiped');
    } else if (currentX >= THRESHOLD) {
      li.classList.remove('swiped');
    }
    try { rowContent.releasePointerCapture(e.pointerId); } catch {}
  });

  rowContent.addEventListener('pointercancel', () => {
    if (!started) return;
    started = false;
    rowContent.style.transition = '';
    rowContent.style.transform = '';
  });
}

/**
 * 顶部 bento 统计小卡（4 个：教材数 / 章节数 / 题目数 / 错题数）
 * 根据视图上下文插入到对应位置
 */
function renderBentoStrip(viewName) {
  const stats = computeGlobalStats();
  const html = `
    <div class="bento-grid bento-strip">
      <div class="bento-card feature purple" data-go="library">
        <div>
          <div class="label">${icon('book', 'icon icon-mauve')}<span>教材</span></div>
          <div class="value">${stats.books}</div>
        </div>
        <div class="desc">${stats.chapters} 章节</div>
      </div>
      <div class="bento-card feature olive" data-go="practice">
        <div>
          <div class="label">${icon('note', 'icon icon-olive')}<span>题目</span></div>
          <div class="value">${stats.questions}</div>
        </div>
        <div class="desc">${stats.books ? '已录入' : '等待录入'}</div>
      </div>
      <div class="bento-card feature sand" data-go="wrong">
        <div>
          <div class="label">${icon('x', 'icon icon-sand')}<span>错题</span></div>
          <div class="value">${stats.wrongCount}</div>
        </div>
        <div class="desc">${stats.questions ? Math.round(100 * stats.wrongCount / stats.questions) + '% 错误率' : '尚未作答'}</div>
      </div>
      <div class="bento-card feature rose" data-go="fav">
        <div>
          <div class="label">${icon('star', 'icon icon-rose')}<span>收藏</span></div>
          <div class="value">${stats.favCount}</div>
        </div>
        <div class="desc">${stats.favCount ? '常回顾' : '尚无收藏'}</div>
      </div>
    </div>
  `;
  if (viewName === 'library') {
    // 插到 #question-list 之前
    let strip = $('#library-strip');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'library-strip';
      $('#question-list').parentNode.insertBefore(strip, $('#question-list'));
    }
    strip.innerHTML = stats.questions ? html : '';  // 没题目时隐藏（避免空状态重复）
    // 给每个 bento 卡绑点击 → 切到对应视图
    strip.querySelectorAll('[data-go]').forEach(card => {
      card.addEventListener('click', () => {
        const t = card.dataset.go;
        const tabBtn = $$('.tab').find(b => b.dataset.tab === t);
        if (tabBtn) tabBtn.click();
      });
    });
  }
}

function computeGlobalStats() {
  const wrongCount = state.questions.filter(q => q.isWrong).length;
  const favCount = state.questions.filter(q => q.isFav).length;
  return {
    books: state.books.length,
    chapters: state.chapters.length,
    questions: state.questions.length,
    wrongCount,
    favCount,
  };
}

/**
 * 顶部 bento 统计小卡（4 个：教材数 / 章节数 / 题目数 / 错题数）
 * 根据视图上下文插入到对应位置
 */
function renderBentoStripLegacy() { /* 占位，不再使用 */ }

function renderLibrary() {
  const ch = currentChapterId ? findChapter(currentChapterId) : null;
  const bk = currentBookId ? findBook(currentBookId) : null;

  // 标题与操作按钮可见性
  let title, meta;
  if (ch) {
    title = ch.name;
    meta = `共 ${questionsOfChapter(ch.id).length} 题`;
  } else if (bk) {
    title = bk.name;
    meta = `${chaptersOfBook(bk.id).length} 章 · ${questionsOfBook(bk.id).length} 题`;
  } else {
    title = '所有题库';
    meta = `${state.books.length} 本教材 · ${state.chapters.length} 章 · ${state.questions.length} 题`;
  }
  $('#lib-title').textContent = title;
  $('#lib-title').title = ch ? '双击重命名章节' : (bk ? '双击重命名教材' : '');
  $('#lib-meta').textContent = meta;

  $('#btn-delete-chapter').hidden = !ch;
  $('#btn-delete-book').hidden = !bk || !!ch;  // 选教材时显示"删除整本"
  $('#btn-rename-chapter').hidden = !(ch || bk);
  $('#btn-add-question').disabled = false;  // 永远可点（无章节时自动建）

  // 渲染顶部 bento 统计小卡
  renderBentoStrip('library');

  // 列表
  let list;
  if (ch) list = questionsOfChapter(ch.id);
  else if (bk) {
    const chapIds = new Set(chaptersOfBook(bk.id).map(c => c.id));
    list = state.questions.filter(q => chapIds.has(q.chapterId));
  } else {
    list = state.questions.slice();
  }

  if (libSearchQuery) {
    const q = libSearchQuery.toLowerCase();
    list = list.filter(item =>
      (item.stem || '').toLowerCase().includes(q) ||
      (item.answer || '').toLowerCase().includes(q) ||
      (item.explanation || '').toLowerCase().includes(q) ||
      (item.options || []).some(o => (o.text || '').toLowerCase().includes(q))
    );
  }

  // 筛选条：根据当前筛选模式过滤
  const baseList = list;
  let filteredList = baseList;
  const mode = window._libFilterMode || 'all';
  if (mode === 'no-answer') {
    filteredList = baseList.filter(x => !(x.answer || '').trim());
  } else if (mode === 'no-explain') {
    filteredList = baseList.filter(x => !(x.explanation || '').trim());
  } else if (mode === 'both-missing') {
    filteredList = baseList.filter(x => !(x.answer || '').trim() && !(x.explanation || '').trim());
  }
  list = filteredList;

  // 实时统计筛选 chip 数字(用 baseList 统计,跟筛选无关)
  updateFilterCounts(baseList);

  // 分组渲染：所有题库模式按教材/章节分组；教材模式按章节分组；章节模式平铺
  if (!ch && !bk) {
    // 顶层：按教材分块，每块内按章节分小段
    const groups = {};
    list.forEach(q => {
      const ch2 = findChapter(q.chapterId);
      const bId = ch2?.bookId || '_none';
      if (!groups[bId]) groups[bId] = {};
      const cId = q.chapterId || '_none';
      if (!groups[bId][cId]) groups[bId][cId] = { name: ch2?.name || '未分类', qs: [] };
      groups[bId][cId].qs.push(q);
    });
    let html = '';
    state.books.forEach(book => {
      const cgs = groups[book.id];
      if (!cgs) return;
      const bookCount = Object.values(cgs).reduce((s, x) => s + x.qs.length, 0);
      html += `<section class="chapter-block">
        <h3 class="chapter-block-title"><span class="cb-icon">${icon('book', 'icon icon-sm icon-mauve')}</span> ${escapeHTML(book.name)} <span class="muted">· ${bookCount} 题</span></h3>`;
      Object.values(cgs).forEach(cg => {
        html += `<div class="sub-chap"><strong>${escapeHTML(cg.name)}</strong> <span class="muted">· ${cg.qs.length}</span></div>`;
        html += cg.qs.map(q => questionCardHTML(q, mode !== 'all')).join('');
      });
      html += `</section>`;
    });
    if (!html) html = emptyHTML('还没有题目，去上传 Word 解析入库吧', 'folder');
    $('#question-list').innerHTML = html;
    bindQuestionCards($('#question-list'));
    if (mode !== 'all') bindInlineEditors($('#question-list'));
    return;
  }
  if (!ch && bk) {
    // 教材模式：按章节分组
    const grouped = {};
    list.forEach(q => {
      if (!grouped[q.chapterId]) grouped[q.chapterId] = [];
      grouped[q.chapterId].push(q);
    });
    const html = chaptersOfBook(bk.id)
      .filter(c => grouped[c.id])
      .map(c => `
        <section class="chapter-block">
          <h3 class="chapter-block-title">${escapeHTML(c.name)} <span class="muted">· ${grouped[c.id].length}</span></h3>
          ${grouped[c.id].map(q => questionCardHTML(q, mode !== 'all')).join('')}
        </section>
      `).join('');
    $('#question-list').innerHTML = html || emptyHTML('这本教材里暂无题目', 'empty');
    bindQuestionCards($('#question-list'));
    if (mode !== 'all') bindInlineEditors($('#question-list'));
    return;
  }
  // 章节模式：平铺
  $('#question-list').innerHTML = list.length
    ? list.map(q => questionCardHTML(q, mode !== 'all')).join('')
    : emptyHTML('本章暂无题目', 'edit');
  bindQuestionCards($('#question-list'));
  if (mode !== 'all') bindInlineEditors($('#question-list'));
}

function questionCardHTML(q, inlineEdit = false) {
  const ch = findChapter(q.chapterId);
  const opts = (q.options || []).map(o => `${o.key}. ${o.text}`).join('\n');
  const tags = [];
  if (ch) tags.push(`<span class="tag chap">${icon('book', 'icon icon-sm icon-mauve')} ${escapeHTML(ch.name)}</span>`);
  if (q.isWrong) tags.push(`<span class="tag wrong">${icon('x', 'icon icon-sm icon-danger')} 错题</span>`);
  if (q.isFav) tags.push(`<span class="tag fav">${icon('star', 'icon icon-sm icon-warn')} 收藏</span>`);
  const acc = q.attempts ? Math.round(q.correct * 100 / q.attempts) : null;
  if (acc !== null) tags.push(`<span class="tag">${icon('chart', 'icon icon-sm icon-muted')} 正确率 ${acc}%</span>`);

  // 缺失标签（黄色虚线标）
  const missing = [];
  if (!(q.answer || '').trim()) missing.push('答案');
  if (!(q.explanation || '').trim()) missing.push('解析');
  if (missing.length) tags.unshift(`<span class="tag missing">⚠ 缺${missing.join('、')}</span>`);

  // 题型 tag（右上角）：用统一解析结果，跟练习页保持一致
  //   （例如被误标成「单项」但答案是 ABD 的题，这里也会显示为多项选择题）
  const qt = qtypeInfo(resolveQtypeRaw(q));

  // inline 编辑器：只在筛选模式下显示
  const editor = inlineEdit ? inlineEditorHTML(q) : '';

  return `
    <div class="q-card ${q.isWrong ? 'is-wrong' : ''} ${q.isFav ? 'is-fav' : ''} ${missing.length ? 'has-missing' : ''}" data-id="${q.id}">
      <span class="qtype-tag ${qt.cls}" title="${escapeHTML(qt.text)}">${icon(qt.icon, 'icon icon-sm')} ${escapeHTML(qt.text)}</span>
      <div class="q-stem">${escapeHTML(q.stem || '')}</div>
      ${opts ? `<div class="q-stem muted" style="margin-top:6px;font-size:13px;white-space:pre-wrap">${escapeHTML(opts)}</div>` : ''}
      ${q.answer ? `<div class="q-stem" style="margin-top:8px"><strong>答案：</strong>${escapeHTML(q.answer)}</div>` : ''}
      ${q.explanation ? `<div class="q-stem muted" style="margin-top:4px"><strong>解析：</strong>${escapeHTML(q.explanation)}</div>` : ''}
      <div class="q-meta">${tags.join('')}
        <span class="q-actions">
          <button data-act="edit">${icon('edit', 'icon icon-sm')}<span>编辑</span></button>
          <button data-act="fav" class="star ${q.isFav ? 'active' : ''}">${q.isFav ? icon('star', 'icon icon-sm') : icon('starOutline', 'icon icon-sm')}</button>
          <button data-act="delete" class="del">${icon('trash', 'icon icon-sm')}</button>
        </span>
      </div>
      ${editor}
    </div>
  `;
}

/**
 * 紧凑 inline 编辑器，只展开缺失的字段
 */
function inlineEditorHTML(q) {
  const noAns = !(q.answer || '').trim();
  const noExp = !(q.explanation || '').trim();
  const ch = findChapter(q.chapterId);
  const bk = ch ? findBook(ch.bookId) : null;
  const hasSource = !!(bk && bk.sourceText && bk.sourceText.length > 100);
  return `
    <div class="inline-editor" data-qid="${q.id}">
      ${noAns ? `
        <label class="inline-row">
          <span class="inline-label">答案</span>
          <textarea data-field="answer" rows="2" placeholder="填答案，如 A 或 选 C…">${escapeHTML(q.answer || '')}</textarea>
          <button type="button" data-pick="answer" class="btn ghost small picker-btn" title="${hasSource ? '从教材原文划取' : '打开划取面板（教材无原文，可粘贴章节文字）'}">${icon('bookOpen', 'icon')} 从教材划取</button>
        </label>` : ''}
      ${noExp ? `
        <label class="inline-row">
          <span class="inline-label">解析</span>
          <textarea data-field="explanation" rows="3" placeholder="填解析，可留空…">${escapeHTML(q.explanation || '')}</textarea>
          <button type="button" data-pick="explanation" class="btn ghost small picker-btn" title="${hasSource ? '从教材原文划取' : '打开划取面板（教材无原文，可粘贴章节文字）'}">${icon('bookOpen', 'icon')} 从教材划取</button>
        </label>` : ''}
      <div class="inline-actions">
        <button data-inline-save class="btn primary small">${icon('check', 'icon')} 保存</button>
        <button data-inline-collapse class="btn ghost small">收起</button>
      </div>
    </div>`;
}

/** 实时统计筛选 chip 上的数字 */
function updateFilterCounts(baseList) {
  const arr = baseList || state.questions;
  let noAns = 0, noExp = 0, both = 0;
  arr.forEach(q => {
    const a = !(q.answer || '').trim();
    const e = !(q.explanation || '').trim();
    if (a) noAns++;
    if (e) noExp++;
    if (a && e) both++;
  });
  const all = arr.length;
  const c = id => $('#' + id);
  if (c('cnt-all')) c('cnt-all').textContent = all;
  if (c('cnt-no-answer')) c('cnt-no-answer').textContent = noAns;
  if (c('cnt-no-explain')) c('cnt-no-explain').textContent = noExp;
  if (c('cnt-both')) c('cnt-both').textContent = both;
}

/** 绑定 inline 编辑器：保存/收起 + 从教材选取 */
function bindInlineEditors(root) {
  if (!root) return;
  root.querySelectorAll('.inline-editor').forEach(ed => {
    const qid = ed.dataset.qid;
    const q = state.questions.find(x => x.id === qid);
    if (!q) return;
    const saveBtn = ed.querySelector('[data-inline-save]');
    const collapseBtn = ed.querySelector('[data-inline-collapse]');
    if (saveBtn) saveBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const ans = ed.querySelector('[data-field="answer"]');
      const exp = ed.querySelector('[data-field="explanation"]');
      if (ans) q.answer = ans.value.trim();
      if (exp) q.explanation = exp.value.trim();
      saveState();
      try { if (typeof scheduleSync === 'function') scheduleSync(); } catch {}
      // 局部刷新：仅这一题
      toast(`已补全第 ${q.id.slice(-4)} 题` + (q.answer || q.explanation ? ' · 5 秒后同步' : ''));
      renderLibrary();
      // 同时刷新收藏/统计/侧边栏
      try { renderStats(); } catch {}
    });
    if (collapseBtn) collapseBtn.addEventListener('click', e => {
      e.stopPropagation();
      ed.style.display = 'none';
    });
    // 「从教材划取」按钮
    ed.querySelectorAll('[data-pick]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openPickerModal(qid, btn.dataset.pick);
      });
    });
  });
}

/**
 * 打开「从教材划取」modal
 *  - 若教材已缓存原文 → 自动填到 textarea
 *  - 若没有 → 显示提示,可手动粘贴一段文字也能划取
 *  - 搜索框高亮命中的所有段落
 *  - 划取后选「填到答案 / 填到解析」把文字写回对应 inline textarea
 */
let _pickerContext = null; // { qid, field }

function openPickerModal(qid, field) {
  const q = state.questions.find(x => x.id === qid);
  if (!q) return;
  const ch = findChapter(q.chapterId);
  const bk = ch ? findBook(ch.bookId) : null;
  _pickerContext = { qid, field };
  const label = field === 'answer' ? '答案' : '解析';
  $('#picker-target-label').textContent = `· 第 ${q.id.slice(-4)} 题 → 填到「${label}」`;
  // 顶部两个按钮根据 field 高亮
  const ansBtn = $('#btn-picker-fill-answer');
  const expBtn = $('#btn-picker-fill-explanation');
  if (ansBtn && expBtn) {
    ansBtn.style.display = field === 'answer' ? '' : 'none';
    expBtn.style.display = field === 'explanation' ? '' : 'none';
  }
  const hasSource = !!(bk && bk.sourceText && bk.sourceText.length > 100);
  $('#picker-source').value = hasSource ? bk.sourceText : '';
  $('#picker-empty-hint').hidden = hasSource;
  $('#picker-source').readOnly = hasSource;
  $('#picker-source').placeholder = hasSource
    ? '教材原文（只读，在里面拖选文字即可）'
    : '教材原文（粘贴一段文字进来就可以划取答案 / 解析）';
  $('#picker-search').value = '';
  $('#picker-hits').textContent = '';
  // 默认聚焦搜索框
  setTimeout(() => $('#picker-search').focus(), 100);
  openModal('modal-picker');
}

function bindPickerModal() {
  const src = $('#picker-source');
  const search = $('#picker-search');
  const hits = $('#picker-hits');
  if (!src || !search) return;

  // 搜索高亮（不破坏原文，只覆盖一层透明 mark）
  let _searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      const kw = search.value.trim();
      if (!kw) { hits.textContent = ''; return; }
      const text = src.value;
      if (!text) { hits.textContent = '没有原文可搜'; return; }
      const re = new RegExp(escapeRegExp(kw), 'gi');
      const m = text.match(re);
      hits.textContent = m ? `${m.length} 处匹配` : '未找到';
      // 滚动到首个命中
      if (m && m.length) {
        const idx = text.search(re);
        if (idx > 0) {
          // 估算行高 ~20px,定位到首个命中行
          const before = text.slice(0, idx);
          const line = (before.match(/\n/g) || []).length;
          src.scrollTop = Math.max(0, line * 20 - 60);
        }
      }
    }, 150);
  });

  // 把选中文本写回 inline editor
  function fillSelection(targetField) {
    if (!_pickerContext) return;
    const sel = (src.value.substring(src.selectionStart, src.selectionEnd) || '').trim();
    if (!sel) {
      toast('请先在文本里拖选一段文字', 'warn');
      return;
    }
    const { qid } = _pickerContext;
    const ed = document.querySelector(`.inline-editor[data-qid="${qid}"]`);
    if (!ed) {
      toast('已保存到剪贴板（编辑器已收起）：' + sel.slice(0, 30) + (sel.length > 30 ? '…' : ''), 'info');
      try { navigator.clipboard.writeText(sel); } catch {}
      return;
    }
    const ta = ed.querySelector(`[data-field="${targetField}"]`);
    if (ta) {
      ta.value = sel;
      ta.focus();
      ta.setSelectionRange(sel.length, sel.length);
    }
    closeModal('modal-picker');
    toast(`已填入「${targetField === 'answer' ? '答案' : '解析'}」· 别忘了点保存`, 'success');
  }

  const ansBtn = $('#btn-picker-fill-answer');
  const expBtn = $('#btn-picker-fill-explanation');
  if (ansBtn) ansBtn.addEventListener('click', () => fillSelection('answer'));
  if (expBtn) expBtn.addEventListener('click', () => fillSelection('explanation'));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emptyHTML(text, iconName = 'empty') {
  return `<div class="empty"><div class="emoji">${icon(iconName, 'icon icon-lg icon-muted')}</div><p>${escapeHTML(text)}</p></div>`;
}

function bindQuestionCards(root) {
  root.querySelectorAll('.q-card').forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-act="edit"]').addEventListener('click', e => {
      e.stopPropagation();
      openQuestionModal(id);
    });
    card.querySelector('[data-act="fav"]').addEventListener('click', e => {
      e.stopPropagation();
      toggleFav(id);
    });
    card.querySelector('[data-act="delete"]').addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('确定删除这道题吗？')) deleteQuestion(id);
    });
  });
}

function toggleFav(id) {
  const q = state.questions.find(x => x.id === id);
  if (!q) return;
  q.isFav = !q.isFav;
  saveState();
  renderLibrary();
  renderFavorites();
  updateBadges();
  toast(q.isFav ? '已加入收藏' : '已取消收藏');
}

function deleteQuestion(id) {
  state.questions = state.questions.filter(q => q.id !== id);
  saveState();
  renderLibrary();
  renderSidebar();
  renderWrongBook();
  renderFavorites();
  renderStats();
  updateBadges();
  toast('已删除');
}

function updateBadges() {
  $('#bad-wrong').textContent = state.questions.filter(q => q.isWrong).length || '';
  $('#bad-fav').textContent = state.questions.filter(q => q.isFav).length || '';
  refreshPracticeFilters();   // 练习栏的题型/题况计数跟着题库变化
}

/* ============ OCR（Tesseract.js） ============ */
let ocrWorker = null;
async function ensureOCRWorker() {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract) throw new Error('Tesseract.js 未加载');
  ocrWorker = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
    logger: m => {
      if (m.status === 'recognizing text') {
        setOcrProgressText(`识别中… ${Math.round(m.progress * 100)}%`);
      } else if (m.status) {
        setOcrProgressText(`状态：${m.status}…`);
      }
    },
    // 中文+英文语言包约 10MB，首次会从 jsdelivr 拉取
  });
  return ocrWorker;
}

function setOcrProgress(percent) {
  const bar = document.getElementById('ocr-bar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
}
function setOcrProgressText(text) {
  const el = document.getElementById('ocr-progress-text');
  if (el) el.textContent = text;
}
function appendOcrLog(line) {
  const el = document.getElementById('ocr-log');
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  el.textContent += `[${ts}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

/**
 * 把 PDF 的第 N 页画到 canvas
 * @param {PDFPageProxy} page
 * @param {number} scale 缩放（2 = 2x，~144 DPI 起步）
 * @returns {Promise<HTMLCanvasElement>}
 */
async function renderPageToCanvas(page, scale = 2) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  // PDF.js 需要 canvasContext 参数
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * OCR 流程入口：把 PDF 前 N 页逐页跑 OCR，拼接文本后走 parseTextToQuestions
 * @param {PDFDocumentProxy} pdf
 * @param {number} maxPage
 * @param {number} scale
 */
async function runOCRFlow(pdf, maxPage, scale = 2) {
  if (!pdf) {
    toast('PDF 文档不可用，请重新上传', 'danger');
    return;
  }
  ocrCancelled = false;
  document.getElementById('btn-ocr-cancel').hidden = false;
  document.getElementById('btn-ocr-close').hidden = true;
  document.getElementById('ocr-log').textContent = '';
  setOcrProgress(0);
  openModal('modal-ocr');

  try {
    const worker = await ensureOCRWorker();
    if (ocrCancelled) throw new Error('用户取消');
    appendOcrLog(`Worker 就绪，语言：chi_sim + eng`);
    appendOcrLog(`准备识别 ${maxPage} 页，缩放 ${scale}x`);

    const allText = [];
    const t0 = Date.now();
    for (let i = 1; i <= maxPage; i++) {
      if (ocrCancelled) throw new Error('用户取消');
      const pageT0 = Date.now();
      const page = await pdf.getPage(i);
      const canvas = await renderPageToCanvas(page, scale);
      const { data } = await worker.recognize(canvas);
      const text = (data.text || '').trim();
      const sec = ((Date.now() - pageT0) / 1000).toFixed(1);
      appendOcrLog(`第 ${i}/${maxPage} 页：${text.length} 字，用时 ${sec}s`);
      allText.push(text);
      allText.push(`\n--- 第 ${i} 页 (OCR) ---\n`);
      setOcrProgress((i / maxPage) * 100);
      setOcrProgressText(`已识别 ${i}/${maxPage} 页`);
    }
    const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
    appendOcrLog(`全部识别完成，共用时 ${totalSec}s`);
    const text = allText.join('\n');
    pendingPdfDoc = null;

    // 用现有解析器解析
    pendingParsed = parseTextToQuestions(text);
    appendOcrLog(`解析到 ${pendingParsed.length} 个章节，${pendingParsed.reduce((s,x)=>s+x.questions.length,0)} 题`);
    setOcrProgress(100);
    setOcrProgressText('完成，准备预览');

    // 关闭 OCR 模态框，打开解析预览
    setTimeout(() => {
      closeModal('modal-ocr');
      document.getElementById('btn-ocr-cancel').hidden = true;
      document.getElementById('btn-ocr-close').hidden = true;
      renderParsePreview(pendingParsed);
      openModal('modal-parse');
    }, 600);
  } catch (e) {
    if (e.message === '用户取消') {
      appendOcrLog('已取消');
      setOcrProgressText('已取消');
    } else {
      console.error(e);
      appendOcrLog(`错误：${e.message}`);
      toast('OCR 失败：' + e.message, 'danger');
    }
    document.getElementById('btn-ocr-cancel').hidden = true;
    document.getElementById('btn-ocr-close').hidden = false;
  }
}

/**
 * 用 mupdf.js 解码整个 PDF，按页拆成行。
 * 关键能力：能解码 Identity-H 无 ToUnicode CMap 的 PDF（PDF.js 抽不到的情况）。
 * @param {ArrayBuffer} buf PDF 二进制
 * @returns {Promise<string>} 全文（含 \n--- 第 N 页 ---\n 分隔符）
 */
async function extractTextByMupdf(buf) {
  const mupdf = await ensureMupdf();
  // mupdf 不同版本的 API 略有差异：兼容新旧两种调用
  const openDoc = mupdf.Document?.openDocument
    || mupdf.openDocument
    || (mupdf.mupdf && mupdf.mupdf.Document?.openDocument);
  if (!openDoc) throw new Error('mupdf API 不匹配：找不到 openDocument');
  const doc = openDoc(buf, 'application/pdf');
  const total = doc.countPages();
  const lines = [];
  for (let i = 0; i < total; i++) {
    const page = doc.loadPage(i);
    const text = page.toStructuredText().asText();
    // 每页清理：去掉 justmarkdown 之类的页脚（"2026/9/5 18:18 justmarkdown https://... N/283"）
    const cleaned = text
      .split('\n')
      .filter(line => !/justmarkdown\.com|^\s*\d{1,4}\/\d{1,4}\s*$/.test(line))
      // 去掉每页底部那种"日期 + 工具名 + URL"三行的页脚
      .filter((line, idx, arr) => {
        // 简单启发：如果紧邻下一行就是日期 + URL，把它们当页脚一起跳
        const next = arr[idx + 1] || '';
        const next2 = arr[idx + 2] || '';
        if (/^\s*\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*$/.test(line)
            && /justmarkdown\.com/.test(next)) return false;
        return true;
      })
      .join('\n');
    lines.push(cleaned);
    lines.push(`\n--- 第 ${i + 1} 页 ---\n`);
  }
  return lines.join('\n');
}

/**
 * 从 .docx 文件中提取纯文本。
 * docx = zip 压缩包，里面有 word/document.xml，所有正文都在 <w:p> 段落的 <w:t> 文本节点里。
 * 表格 <w:tbl> 单元格里也可能有题号/选项——会把每个单元格单独当成一行（合并行用 \t 分隔）。
 * @param {ArrayBuffer} buf docx 二进制
 * @returns {Promise<string>} 全文，按段落分行（含 \n--- 第 N 页 ---\n）
 */
async function extractTextByDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  // 主文档：word/document.xml（99% 的内容在这）
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new Error('不是合法 docx：缺少 word/document.xml');
  const docXml = await docXmlFile.async('string');

  // 按段落 <w:p> 切分（用正则查 <w:p ...> ... </w:p> 整段；嵌套的 <w:p> 不会出现在 docx 中，所以简单 split 即可）
  // 用 DOMParser 更稳
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXml, 'application/xml');
  if (xmlDoc.querySelector('parsererror')) {
    throw new Error('document.xml 解析失败（parsererror）');
  }

  const lines = [];
  let pageNum = 1;
  let answerHeaderPending = false;  // 上一个非空段落是否是"参考答案及解析"，决定接下来的 <w:tbl> 是否按答案表展开

  // 递归遍历 body，把所有块级元素按文档顺序拿出来
  // 块级：<w:p>（段落）、<w:tbl>（表格）
  // 多个 fallback 兼容不同 XML 解析器（浏览器 DOMParser / Node xmldom）：
  //   - xmldom 把 <w:body> 转大写 → 'W:BODY'
  //   - 浏览器 DOMParser 保留小写 → 'w:body'（但 querySelector 对命名空间选择器不可靠，所以统一用 getElementsByTagName）
  const body = xmlDoc.getElementsByTagName('w:body')[0]
             || xmlDoc.getElementsByTagName('W:BODY')[0]
             || xmlDoc.documentElement;
  // 带命名空间前缀的 tagName 是 'w:body'，不能用全等比较；只看 localName
  const bodyLocal = body && (body.localName || body.tagName.split(':').pop());
  if (!body || bodyLocal.toLowerCase() !== 'body') throw new Error('document.xml 找不到 <w:body>');

  // 分页：<w:br w:type="page"/> 是 Word 的硬分页符，遇到就插一个"--- 第 N 页 ---"
  // tag 统一转小写，兼容浏览器 DOMParser（保留原始 'w:p'）和 xmldom（转成 'W:P'）
  for (const child of Array.from(body.children)) {
    const tag = (child.tagName || '').toLowerCase();
    if (tag === 'w:p') {
      const text = paragraphText(child);
      // 检查段落里是否含分页符
      if (/<w:br[^/]*w:type="page"/i.test(child.outerHTML) || /w:type="page"/i.test(child.outerHTML)) {
        // 这种段落文本可能还在，先把文本放进 lines，再加分隔
        if (text) lines.push(text);
        lines.push('');
        lines.push(`--- 第 ${pageNum} 页 ---`);
        lines.push('');
        pageNum++;
      } else {
        if (text) {
          lines.push(text);
          // 非空段落：标记"参考答案及解析"
          if (/^\s*参考答案\s*(?:及\s*解析)?\s*$/.test(text)) {
            answerHeaderPending = true;
          }
        }
        // 空段落不重置 answerHeaderPending（docx 里标题后常有空白段）
      }
    } else if (tag === 'w:tbl') {
      const rows = child.getElementsByTagName('w:tr');
      if (answerHeaderPending) {
        // 答案表：每行展开为 3 行（题号 / 答案 / 解析），让 parseAnswerBlock 直接读取
        // 第 1 行通常是表头 "题号 / 答案 / 解析"，跳过
        let isFirst = true;
        for (const tr of Array.from(rows)) {
          if (isFirst) { isFirst = false; continue; }
          const cells = tr.getElementsByTagName('w:tc');
          const cellTexts = Array.from(cells).map(tc => paragraphText(tc).replace(/\s+/g, ' ').trim());
          // 一题 3 列：第一列是题号、第二列是答案、第三列是解析
          for (const c of cellTexts) lines.push(c);
          lines.push('');
        }
        answerHeaderPending = false;
      } else {
        // 普通表格：每行单独一行，单元格之间用 \t 分隔
        for (const tr of Array.from(rows)) {
          const cells = tr.getElementsByTagName('w:tc');
          const cellTexts = Array.from(cells).map(tc => paragraphText(tc).replace(/\s+/g, ' ').trim());
          lines.push(cellTexts.join('\t'));
        }
        // 表格结束后空一行
        lines.push('');
      }
    } else if (tag === 'w:sectPr') {
      // 节属性，忽略
    } else {
      // 其他标签（理论上 docx body 只有 p / tbl / sectPr），保守地取文本
      const text = paragraphText(child);
      if (text) lines.push(text);
    }
  }

  return lines.join('\n');
}

/**
 * 把一个段落（或任意元素）下的所有 <w:t> 文本节点拼成一行。同一段落里的多个 run 之间不加分隔
 * （让解析器按正常的"行"处理——Word 段落换行就是 \n）。
 */
function paragraphText(el) {
  const ts = el.getElementsByTagName('w:t');
  let s = '';
  for (const t of Array.from(ts)) {
    s += t.textContent || '';
  }
  return s;
}

/* ============ PDF / Word 解析入口 ============ */
async function handlePDFUpload(file) {
  if (!file) return;
  // 记录文件名（去掉扩展名），用于创建教材时做默认名
  pendingPdfName = (file.name || '未命名教材').replace(/\.(pdf|docx|doc|txt|md)$/i, '').trim() || '未命名教材';

  const lowerName = (file.name || '').toLowerCase();
  // 显示一个非阻断 toast 提示当前格式（让用户知道进度）
  toast(`正在读取「${file.name}」…`, 'info', 1600);

  // === .docx 走 JSZip 解析 ===
  if (lowerName.endsWith('.docx')) {
    if (!window.JSZip) { toast('JSZip 未加载（解析 .docx 需要）', 'danger'); return; }
    toast('正在解析 Word 文档…');
    try {
      const buf = await file.arrayBuffer();
      const docxText = await extractTextByDocx(buf);
      if (!docxText || docxText.replace(/\s/g, '').length < 50) {
        toast('Word 文档中没抽到文字（可能是空文档或图片型）', 'danger');
        return;
      }
      pendingPdfDoc = null;
      pendingSourceText = docxText;
      pendingParsed = parseTextToQuestions(docxText);
      if (!pendingParsed.length || !pendingParsed.some(s => s.questions.length)) {
        toast('Word 文档未识别到题目，请检查格式或用手动录入', 'warn');
        return;
      }
      renderParsePreview(pendingParsed);
      openModal('modal-parse');
      toast(`已识别 ${pendingParsed.reduce((s, x) => s + x.questions.length, 0)} 道题，待你确认入库`, 'success');
    } catch (e) {
      console.error(e);
      toast('Word 解析失败：' + e.message, 'danger');
    }
    return;
  }

  // === .pdf 走 PDF.js ===
  if (lowerName.endsWith('.pdf')) {
    if (!window.pdfjsLib) { toast('PDF.js 未加载', 'danger'); return; }
    toast('正在解析 PDF…');
    try {
      const buf = await file.arrayBuffer();
      const result = await extractPdfText(buf);
      pendingPdfDoc = result.scanOnly ? result.doc : null;
      if (result.scanOnly) {
        // 扫描件 PDF → 弹 OCR 提示
        if (window.Tesseract) {
          toast('检测到扫描件 PDF，可点击「开始 OCR」识别', 'warn', 4000);
        }
        pendingSourceText = null;
        pendingParsed = [];
        renderParseScannedPDF(result.doc.numPages);
        openModal('modal-parse');
        return;
      }
      pendingSourceText = result.text;
      pendingParsed = parseTextToQuestions(result.text);
      renderParsePreview(pendingParsed);
      openModal('modal-parse');
      toast(`已识别 ${pendingParsed.reduce((s, x) => s + x.questions.length, 0)} 道题，待你确认入库`, 'success');
    } catch (e) {
      console.error(e);
      toast('PDF 解析失败：' + e.message, 'danger');
    }
    return;
  }

  // === 其他格式（txt / md 等纯文本）走纯文本解析 ===
  if (/\.(txt|md|markdown)$/i.test(lowerName)) {
    try {
      const text = await file.text();
      pendingSourceText = text;
      pendingParsed = parseTextToQuestions(text);
      renderParsePreview(pendingParsed);
      openModal('modal-parse');
      toast(`已识别 ${pendingParsed.reduce((s, x) => s + x.questions.length, 0)} 道题，待你确认入库`, 'success');
    } catch (e) {
      toast('文本读取失败：' + e.message, 'danger');
    }
    return;
  }

  // === 不支持的格式 → 给清晰提示 ===
  toast(`暂不支持「${lowerName.split('.').pop() || '该格式'}」格式，请使用 .docx / .pdf / .txt`, 'warn', 4000);
}

/**
 * 从 PDF 提取文本。如果 PDF.js 抽不到（Identity-H 无 ToUnicode 或扫描件），尝试 mupdf.js 兜底
 * 返回 { text, doc, scanOnly }
 *   - text: 提取出的文本（scanOnly=true 时为空）
 *   - doc: PDFDocumentProxy 引用（仅扫描件需要 OCR 时保留）
 *   - scanOnly: true 表示这是扫描件，需要走 OCR 流程
 */
async function extractPdfText(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const allText = [];
  let totalChars = 0;
  const sampleTo = Math.min(pdf.numPages, 50);
  for (let i = 1; i <= sampleTo; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = groupTextByLines(content.items);
    const joined = lines.join('\n');
    totalChars += joined.length;
    allText.push(joined);
    allText.push(`\n--- 第 ${i} 页 ---\n`);
  }
  if (totalChars < Math.max(50, sampleTo * 5)) {
    try {
      const mupdf = await ensureMupdf();
      const mupdfText = await extractTextByMupdf(buf);
      if (mupdfText && mupdfText.replace(/\s/g, '').length >= Math.max(50, sampleTo * 5)) {
        return { text: mupdfText, doc: null, scanOnly: false };
      }
    } catch (e) { console.warn('[mupdf fallback]', e); }
    return { text: '', doc: pdf, scanOnly: true };
  }
  for (let i = sampleTo + 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = groupTextByLines(content.items);
    allText.push(lines.join('\n'));
    allText.push(`\n--- 第 ${i} 页 ---\n`);
  }
  return { text: allText.join('\n'), doc: null, scanOnly: false };
}

function renderParseScannedPDF(pages) {
  $('#btn-confirm-parse').disabled = true;
  const safePages = Math.min(pages, 200);  // 浏览器跑 OCR 默认上限 200 页，避免长任务卡死
  $('#parse-body').innerHTML = `
    <div class="empty" style="padding:30px 20px">
      <div class="emoji">${icon('camera', 'icon icon-lg icon-mauve')}</div>
      <h3 style="margin:0 0 10px">这看起来是一份扫描件 PDF</h3>
      <p class="muted">共 ${pages} 页，没抽出任何文字。<br>文字全部在图片里，需要 OCR 才能识别。</p>
      <div style="text-align:left;background:var(--bg-3);padding:14px 16px;border-radius:8px;margin-top:16px;font-size:13px;line-height:1.8">
        <strong>三种处理方式：</strong><br>
        ① <strong>用文字版 PDF</strong>：在电脑上右键 PDF → 属性，看是否有「文本层」；或重新下载带文字层的版本<br>
        ② <strong>本应用内置 OCR</strong>：点击下方「开始 OCR」按钮，浏览器内直接识别（速度较慢，但零外部依赖）<br>
        ③ <strong>手动录入</strong>：本应用支持「+ 手动录入」按钮，对难解析的资料可逐题录入（也能获得所有练习/统计功能）
      </div>
      ${window.Tesseract ? `
        <div style="margin-top:18px;text-align:left;background:var(--bg-2);border:1px solid var(--border);padding:14px 16px;border-radius:8px">
          <label style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <span>识别页数范围：</span>
            <select id="ocr-range">
              <option value="all">全部 ${pages} 页（可能很慢）</option>
              <option value="20">前 20 页（先试效果）</option>
              <option value="50">前 50 页</option>
              <option value="100">前 100 页</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
            <span>识别精度：</span>
            <select id="ocr-scale">
              <option value="1.5">快速（缩放 1.5x，约 1–3 秒/页）</option>
              <option value="2" selected>标准（缩放 2x，约 2–6 秒/页）</option>
              <option value="3">高精（缩放 3x，约 5–12 秒/页）</option>
            </select>
          </label>
          <button class="btn primary" id="btn-start-ocr">${icon('camera', 'icon')}开始 OCR 识别</button>
          <p class="muted" style="font-size:12px;margin-top:8px">
            提示：首次加载中文识别包约需下载 ~10MB 语言文件（chi_sim），请保持网络畅通。
          </p>
        </div>
      ` : `
        <p class="muted" style="margin-top:14px;color:var(--danger)">Tesseract.js 未加载，无法在浏览器内识别。</p>
      `}
    </div>
  `;
  const btn = document.getElementById('btn-start-ocr');
  if (btn) btn.addEventListener('click', async () => {
    closeModal('modal-parse');
    const range = document.getElementById('ocr-range').value;
    const scale = Number(document.getElementById('ocr-scale').value);
    const maxPage = range === 'all' ? pages : Math.min(pages, Number(range));
    await runOCRFlow(pendingPdfDoc, maxPage, scale);
  });
}

// 将 PDF.js 给出的 items 还原成行
function groupTextByLines(items) {
  const rows = {};
  items.forEach(it => {
    if (!it.str) return;
    const y = Math.round(it.transform[5]);
    if (!rows[y]) rows[y] = [];
    rows[y].push(it.str);
  });
  return Object.keys(rows)
    .map(Number)
    .sort((a, b) => b - a)
    .map(y => rows[y].join('').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 主解析函数（修复版）：
 * 1) 全局识别章节标题，把题目分组到对应章节
 * 2) 整卷共享一份「参考答案」块（不再按章节切）
 * 3) 按题号匹配答案与解析
 */
function parseTextToQuestions(text) {
  // 章节标题：中英文常见格式
  // 增加："专题一/二/..."、"第N部分" 识别（如"第四部分 应试跨章节专题"）
  const chapterRe = /^\s*(?:第\s*([一二三四五六七八九十百千\d]+)\s*[章节单元篇]\s*[、\.\:：]?\s*([^\n]*)|chapter\s+(\d+)\s*[:：\.]?\s*([^\n]*)|unit\s+(\d+)\s*[:：\.]?\s*([^\n]*)|第\s*(\d+)\s*课[、\.\:：]?\s*([^\n]*)|模块\s*(\d+)[\.\:：]\s*([^\n]*)|专题\s*([一二三四五六七八九十]+)\s*[、\.\:：·]?\s*([^\n]*)|第\s*([一二三四五六七八九十百千\d]+)\s*部分\s*[、\.\:：]?\s*([^\n]*))/i;
  // 目录行判定：含 "...... 数字" 页码 → 视为目录项（章节或"参考答案"）
  const tocPageNoRe = /\.{3,}\s*\d+\s*$/;
  // 答案区起始：识别到后该行起算答案区；要求不紧跟目录页码格式
  const answerStartRe = /^(答案\s*与\s*解析|参考答案|答案\s*$|解题\s*提示|附\s*[答案解析])\s*(?!\.{3,})/i;
  // 题型小标题（如「一、单项选择题」）— 跳过不切（避免过度切分）
  // 也兼容专题里的裸「综合题 / 计算分析题」（没有「一、」前缀）
  const subSecRe = /^\s*(?:[一二三四五六七八九十]+[、]\s*[^0-9\n]{2,12}|(?:综合题|计算分析题)\s*)$/;

  const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 第一步：把每行打标签（chapter / answer / misc）
  const tagged = [];
  let inAnswer = false;
  for (const line of rawLines) {
    if (/^---+/.test(line)) continue;
    // 章节标题优先于答案区标记——遇到新章节时重置 inAnswer（每章都有独立的"参考答案及解析"块）
    if (chapterRe.test(line)) {
      if (tocPageNoRe.test(line)) continue;  // 目录章节行跳过
      inAnswer = false;
      tagged.push({ kind: 'chap', text: line });
      continue;
    }
    if (!inAnswer && answerStartRe.test(line) && !tocPageNoRe.test(line)) {
      inAnswer = true;
      tagged.push({ kind: 'answer-start', text: line });
      continue;
    }
    if (inAnswer) {
      tagged.push({ kind: 'answer', text: line });
      continue;
    }
    if (subSecRe.test(line)) {
      // 题型小标题（如「一、单项选择题」）——既要保留给答案区按题型分组，
      // 也要进入 qLines，这样题目解析时才能根据它切换 curType
      tagged.push({ kind: 'qtype', text: line });
      tagged.push({ kind: 'misc', text: line });
      continue;
    }
    tagged.push({ kind: 'misc', text: line });
  }

  // 第二步：按章节归并题目行 + 答案行 + 题型小标题（每章节各自独立）
  const chapters = [{ name: '默认章节', qLines: [], aLines: [], qtypes: [] }];
  let cur = chapters[0];
  for (const t of tagged) {
    if (t.kind === 'chap') {
      cur = { name: t.text.replace(/\s+/g, ' ').slice(0, 60), qLines: [], aLines: [], qtypes: [] };
      chapters.push(cur);
    } else if (t.kind === 'misc') {
      cur.qLines.push(t.text);
    } else if (t.kind === 'answer') {
      cur.aLines.push(t.text);
    } else if (t.kind === 'qtype') {
      cur.qtypes.push(t.text);
    }
  }

  // 第三步（推迟到题目解析之后）：先识别题目，把 qtype 信息传给 parseAnswerBlock
  const result = [];

    // 第四步：每章节内识别题目（专题综合题/计算分析题也走这里）
    // 注意：不允许 "（1）" 这种带括号的前缀，那是计算分析题/综合题内部的小问
    const startRe = /^\s*(?:(\d+)\s*[\.\、\:：\．]|Q\s*(\d+)\s*[\.\:：])\s*/i;
  // 子问题标记：像「（1）（2）」或「1) 2) 3)」——综合题/计算分析题内部的小问，不当作新题
  const subQRe = /^\s*[（(]\s*\d+\s*[）)]\s*/;
  // 专题综合题 / 计算分析题标记（如「1.【2024年·综合题】」或「6.【2023年·计算分析题】」）
  const essayQHeaderRe = /【[^\】]*?(综合题|计算分析题)/;
  // 「裸综合题 header」——没有题号前缀也能起新题（如【2025年·计算分析题】，专题五用）
  const bareHeaderRe = /^\s*【[^】]+】\s*[（(]?/;
  for (let i = 0; i < chapters.length; i++) {
    const sec = chapters[i];
    const qs = [];
    let curQ = null;
    let curType = 'single';  // 当前题型（默认单项选择题）
    let sectionNumCounter = 0; // 章节内自增题号（用于无前缀数字的裸综合题）

    // 计算分析题 / 综合题拆分状态
    let calcBase = '';        // 题干背景（资料）
    let calcSubCount = 0;     // 当前大题已产生几个小问
    let calcParentNum = 0;    // 当前大题的题号
    let calcExpecting = false;// 进入 calc/essay 题型后，等待第一道非空行作为题干
    let inRequirements = false; // 是否已进入「要求/问题」段落，之后的小问才是真正题目

    for (const line of sec.qLines) {
      // 题型小标题 → 切换（如「一、单项选择题」「四、计算分析题」）
      if (subSecRe.test(line)) {
        if (curQ) { qs.push(curQ); curQ = null; }
        curType = detectQTypeFromLabel(line);
        calcBase = '';
        calcSubCount = 0;
        calcParentNum = 0;
        calcExpecting = (curType === 'calc' || curType === 'essay');
        inRequirements = false;
        continue;
      }

      const sm = line.match(startRe);
      const headerMatch = line.match(essayQHeaderRe);
      // 新规则：无数字前缀但命中「【...】综合题/计算分析题」——作为新题起点（如专题五）
      const bareHeaderHit = !sm && !curQ && bareHeaderRe.test(line) && headerMatch;
      const isSubQ = subQRe.test(line) && !essayQHeaderRe.test(line);

      // 1) 带数字前缀的新题
      if (sm) {
        if (curQ) qs.push(curQ);
        const qNum = Number(sm[1] || sm[2]);
        const { stem, options } = splitInlineQuestion(line);
        let qType = curType;
        if (headerMatch) {
          if (/计算分析/.test(headerMatch[1])) qType = 'calc';
          else if (/综合/.test(headerMatch[1])) qType = 'essay';
        }
        curQ = { num: qNum, stem, options, explanation: '', qtype: qType, answer: '' };
        sectionNumCounter = Math.max(sectionNumCounter, qNum);
        calcBase = '';
        calcSubCount = 0;
        calcParentNum = qNum;
        calcExpecting = false;
        inRequirements = false;
        continue;
      }

      // 2) 裸 【YYYY年·计算分析题】 header（专题综合题）
      if (bareHeaderHit) {
        if (curQ) qs.push(curQ);
        sectionNumCounter++;
        let qType = curType;
        if (/计算分析/.test(headerMatch[1])) qType = 'calc';
        else if (/综合/.test(headerMatch[1])) qType = 'essay';
        if (qType === 'single') qType = 'calc';
        curQ = { num: sectionNumCounter, stem: line, options: [], explanation: '', qtype: qType, answer: '' };
        calcBase = '';
        calcSubCount = 0;
        calcParentNum = sectionNumCounter;
        calcExpecting = false;
        inRequirements = false;
        continue;
      }

      // 3) 计算分析题 / 综合题 内部的小问（1）（2）（3）
      if (curQ && (curQ.qtype === 'essay' || curQ.qtype === 'calc') && isSubQ) {
        if (!inRequirements) {
          // 还没进入「要求/问题」段落，(1)(2)(3) 只是资料性说明，并入题干背景
          curQ.stem = (curQ.stem ? curQ.stem + '\n' : '') + line;
        } else if (calcSubCount === 0) {
          // 第一个真正的小问：把之前累计的背景作为题干前缀
          calcBase = curQ.stem;
          calcParentNum = calcParentNum || curQ.num;
          curQ.num = calcParentNum * 1000 + 1;
          curQ.stem = calcBase + '\n' + line;
          calcSubCount++;
        } else {
          qs.push(curQ);
          curQ = {
            num: calcParentNum * 1000 + calcSubCount + 1,
            stem: calcBase + '\n' + line,
            options: [],
            explanation: '',
            qtype: curQ.qtype,
            answer: ''
          };
          calcSubCount++;
        }
        continue;
      }

      // 4) 计算分析题 / 综合题 没有题号前缀，直接以背景资料开头（最常见教材格式）
      if (!curQ && calcExpecting && line.trim()) {
        sectionNumCounter++;
        curQ = { num: sectionNumCounter, stem: line, options: [], explanation: '', qtype: curType, answer: '' };
        calcBase = line;
        calcSubCount = 0;
        calcParentNum = sectionNumCounter;
        calcExpecting = false;
        inRequirements = false;
        continue;
      }

      // 4.5) 标记进入「要求/问题」段落（之后的小问才拆分）
      if (curQ && (curQ.qtype === 'essay' || curQ.qtype === 'calc') && /^(?:要求|问题|作答|QUESTION)[：:\s]*$/i.test(line)) {
        inRequirements = true;
        curQ.stem = (curQ.stem ? curQ.stem + '\n' : '') + line;
        continue;
      }

      // 5) 累计到当前题
      if (curQ) {
        // 附在每题后的参考答案：支持【参考答案】A / 【参考答案】 A / 参考答案：A / 答案：A / 【答案】A
        const ansInline = line.match(/^\s*(?:【\s*)?参考答案\s*】?\s*[:：]?\s*(.+?)\s*$/);
        if (ansInline) {
          curQ.answer = ansInline[1].trim();
          continue;
        }
        // 裸【答案】标签（不带"参考"前缀，必须带【】避免误识别）
        const ansInline2 = line.match(/^\s*【\s*答案\s*】\s*[:：]?\s*(.+?)\s*$/);
        if (ansInline2) {
          curQ.answer = ansInline2[1].trim();
          continue;
        }
        // 附在每题后的解析：支持【解析】xxx / 解析：xxx / 解析 xxx / 【详解】xxx
        const expInline = line.match(/^\s*(?:【\s*)?(?:解析|详解|说明)\s*】?\s*[:：]?\s*(.*)$/);
        if (expInline) {
          curQ.explanation = (curQ.explanation ? curQ.explanation + '\n' : '') + expInline[1];
          continue;
        }
        const optMatch = line.match(/^\s*([A-Z])[\.\、\:\uff1a]\s*(.+)$/);
        if (optMatch && optMatch[1] === optMatch[1].toUpperCase() && 'ABCDEFGH'.includes(optMatch[1])) {
          curQ.options.push({ key: optMatch[1], text: optMatch[2].trim() });
        } else {
          // 兼容旧版"解析：xxx"无前缀版（题干里的），不剥到 explanation 而是累加到 stem
          const exp2 = line.match(/^(?:解析|详解|说明|解)[：:\s]+(.+)$/);
          if (exp2) {
            curQ.explanation = (curQ.explanation ? curQ.explanation + '\n' : '') + exp2[1];
          } else {
            curQ.stem = (curQ.stem ? curQ.stem + '\n' : '') + line;
          }
        }
      }
    }
    if (curQ) qs.push(curQ);

    if (!qs.length) continue;

    // 现在题目都识别完了，再解析答案块（带 qtypes 信息让段落式答案能正确归类）
    const ansMap = parseAnswerBlock(sec.aLines, qs);

    // 兜底：单题章节（专题五那种整章就 1 道综合题）——若 aLines 没有「第N题」/纯数字题号分隔，
    // 且 qs 只有 1 道 essay/calc 题未被关联 explanation → 把整个 aLines 当成这道题的解析
    if (sec.aLines.length && qs.length === 1 && (qs[0].qtype === 'essay' || qs[0].qtype === 'calc')) {
      const hasEssayMark = sec.aLines.some(l => /^第\s*\d+\s*题\s*$/.test(l.trim()));
      const hasNumMark = sec.aLines.some(l => /^\d+$/.test(l.trim()));
      const q0 = qs[0];
      const m = (ansMap[q0.qtype] || {})[q0.num];
      if (!hasEssayMark && !hasNumMark && (!m || !m.explanation)) {
        const cleanLines = sec.aLines.filter(l => !/^(参考答案.*?及.*?解析|参考答案|答案\s*与\s*解析)\s*$/i.test(l.trim()));
        if (!ansMap[q0.qtype]) ansMap[q0.qtype] = {};
        ansMap[q0.qtype][q0.num] = { num: q0.num, answer: '参见解析', explanation: cleanLines.join('\n') };
      }
    }

    // 关联本章节答案（按题型分组查）；若章节末尾答案区没拿到，优先用题内【参考答案】
    const built = qs.map(q => {
      const a = (ansMap[q.qtype] || {})[q.num];
      let answer = q.answer || '', explanation = q.explanation || '';
      if (!answer && a) answer = a.answer;
      if (!explanation && a) explanation = a.explanation;
      // 兼容旧版块格式：若答案块里没拿到答案，尝试从题干中提取
      if (!answer && q.stem) {
        const m = q.stem.match(/\(([A-D对错√×])\)\s*$/);
        if (m) answer = m[1];
      }
      return {
        num: q.num,
        stem: q.stem.trim(),
        options: q.options || [],
        answer,
        explanation,
        qtype: q.qtype,
      };
    });
    result.push({ name: sec.name, questions: built });
  }

  return result;
}

/**
 * 从"一、单项选择题"这种标签识别题型
 */
function detectQTypeFromLabel(label) {
  if (/单项/.test(label)) return 'single';
  if (/多项/.test(label)) return 'multi';
  if (/判断/.test(label)) return 'judge';
  if (/计算/.test(label)) return 'calc';
  if (/综合/.test(label)) return 'essay';
  return 'single';  // 默认
}

/**
 * 拆分 Word 教材常见的"单行多选项"题目：
 *   "1. 下列项目中...（　）。　A. 赊购原材料　B. 接受投资者投入办公楼　C. 收回应收账款　D. 提取法定盈余公积"
 * 返回 { stem: '1. 下列项目中...（　）。', options: [{key:'A', text:'赊购原材料'}, ...] }
 * 如果行内没有 "A. xxx" 这种选项，则 stem = 原行、options = []
 */
function splitInlineQuestion(line) {
  // 在第一个 [A-H]. [空格] 之前找位置
  // 用全角空格 \u3000 或半角空格 \s+ 作为分隔符
  const optStart = line.search(/\s+[A-H][.\、:\uff1a]\s+/);
  if (optStart < 0) {
    return { stem: line, options: [] };
  }
  const stem = line.slice(0, optStart).trimEnd();
  const rest = line.slice(optStart).trim();
  // rest 形如 "A. xxx　B. xxx　C. xxx　D. xxx"
  // 按 "字母. 文本" 切分
  const options = [];
  const optRe = /([A-H])[.\、:\uff1a]\s*([^]+?)(?=\s+[A-H][.\、:\uff1a]\s+|$)/g;
  let m;
  while ((m = optRe.exec(rest)) !== null) {
    options.push({ key: m[1], text: m[2].trim() });
  }
  return { stem, options };
}

/**
 * 从答案区行里提取题号 → {answer, explanation}，按题型分组
 * 适配"题号 / 答案字母 / 解析"三列对齐结构（如轻一 PDF）
 * 例如：
 *   一、单项选择题       → 切换当前题型
 *   题号 / 答案 / 解析   → 跳过表头
 *   1                    → 题号开始
 *   B                    → 答案字母
 *   生产线安装过程中...  → 解析（可能跨多行）
 *   2                    → 下一题
 *   A B D                → 多项选择题的多个答案字母（可能单独成行）
 *   对 / 错 / √ / ×      → 判断题答案
 *
 * 返回 { single: {num: {...}}, multi: {...}, judge: {...}, calc: {...}, essay: {...} }
 */
function parseAnswerBlock(lines, qtypes = []) {
  // qtypes: 当前章节的题目列表（含 qtype: 'essay'/'calc'/'single' 等），用于推断"第N题"对应的题型
  const map = { single: {}, multi: {}, judge: {}, calc: {}, essay: {} };
  // 修复章节级 bug：部分专题章（如专题五）答案区没有「一、计算分析题」qtype 标题，
  //   也没有「第N题」header，但答案直接以"（1）（2）（3）"开头。若 curType 默认为 'single'，
  //   subAnsMatch 永远不会被触发，整段小问答案会被静默丢弃。
  // 推断规则：如果章节内所有 qtypes 都是 calc/essay（无 single/multi/judge），则初始 curType
  //   取该 qtype。混合章节仍然从 'single' 开始，由后续「一、xxx」「第N题」触发切换。
  let curType = 'single';
  if (qtypes && qtypes.length) {
    const tSet = new Set(qtypes.map(q => q.qtype));
    if (tSet.size === 1) {
      const only = [...tSet][0];
      if (only === 'calc' || only === 'essay') curType = only;
    }
  }
  let cur = null;
  // 计算分析题 / 综合题 的小问答案队列：题干已按 (1)(2)(3) 拆成 1001/1002/1003...，
  // 答案区里的 "（1）" 按顺序对应队列中的题号。
  // 修复 bug：之前用全部 calc+essay 题号作单一队列，遇到"先计算分析题、后综合题"排版的章节时，
  //           切题型会把 calcIdx 重置回 0，导致综合题的 (1)(2)(3)(4) 被错误地映射到计算分析题的题号上。
  // 新做法：按 curType 分别维护队列，切换题型时把 calcIdx 重置并只取当前题型的题号。
  // 关键：calcQueue 必须跟 curType 保持同步；任何 curType 变化（章节顶部 / 第N题 内嵌）都要重建队列。
  const calcQueueFor = (qt) => (qtypes || [])
    .filter(q => q.qtype === qt)
    .map(q => q.num);
  const rebuildCalcQueue = () => { calcQueue = calcQueueFor(curType); calcIdx = 0; };
  let calcQueue = calcQueueFor(curType);
  let calcIdx = 0;
  // 用「父题号 * 1000」区间反查 qtypes 真实题型(不直接 num===parentNum 找,
  //   否则章节里同时存在 single #1 和 calc #1001 时会错误兜底到 single,
  //   把已经在 calc/essay 上下文的 curType 切回 single).
  const findQtypeByParent = (parentNum) => {
    if (!parentNum) return null;
    const lo = parentNum * 1000, hi = lo + 1000;
    const m = qtypes.find(q => q.num >= lo && q.num < hi);
    return m ? m.qtype : null;
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 跳过表头与栏目名（要求独立成行，行末必须是空白，避免误跳「解析1」这种含答案的行）
    if (/^(题\s*号|答\s*案|解\s*析|题目|答案|题号|参考答案.*?及.*?解析)\s*$/i.test(t)) continue;
    // 题型小标题
    if (/^[一二三四五六七八九十]+、/.test(t)) {
      if (cur) map[curType][cur.num] = cur;   // 先保存上一题，避免切题型时把第6题等丢弃
      curType = detectQTypeFromLabel(t);
      cur = null;
      // 修复：每次切换题型时，重新构造当前题型的 calc/essay 队列，calcIdx 重置为 0
      rebuildCalcQueue();
      continue;
    }

    // 计算分析题 / 综合题 的小问答案（如 "（1）" "（2）" "（3）"）
    const subAnsMatch = t.match(/^[（(]\s*(\d+)\s*[）)]\s*(.*)$/);
    if (subAnsMatch && (curType === 'calc' || curType === 'essay')) {
      // 关键修复：subAnsMatch 必须使用「当前父题」的 calcQueue（被 essayHeader/essayInline
      //   按 parentNum 过滤后的子题号列表），而不是全局 calcQueueFor(curType)。
      // 之前用全局队列导致：第1父题的 3 个小问映射到 1001/1002/1003，第2父题的（1）又映射到
      //   全局队列第 0 位 1001，把 1001 的内容覆盖，并把 2001-2004 全部跳过。
      let curQueueFromType = calcQueue;
      if (curQueueFromType.length === 0) {
        // 兜底：calcQueue 被清空（极少情况），从全队列按 calcIdx 取
        curQueueFromType = calcQueueFor(curType);
      }
      // 用 curType 的"剩余小问号"做队列：每次进入新的"第N题"父问时 calcIdx 应该从 0 开始重数。
      // calcQueue 由 essayHeader/essayInline 在每次「第N题」时按 parentNum 过滤 + calcIdx=0。
      if (calcIdx >= curQueueFromType.length) {
        // 越界 → 全部已发完，把 curType 队列从头开始补充（不重置 calcIdx，因为后续不再用）
        const num = curQueueFromType[(calcIdx) % curQueueFromType.length];
        if (num) {
          if (cur) map[curType][cur.num] = cur;
          cur = { num, answer: '参见解析', explanation: subAnsMatch[2] || '' };
        }
        calcIdx++;
        continue;
      }
      if (cur) map[curType][cur.num] = cur;
      const num = curQueueFromType[calcIdx++];
      if (num) {
        cur = { num, answer: '参见解析', explanation: subAnsMatch[2] || '' };
      } else {
        cur = null; // 没有对应题干，丢弃
      }
      continue;
    }

    // ============ 修复第6题以后漏关联的核心 ============
    // PDF/Word 答案区常见格式：
    //   A) 「6.」+ 下一行「B 解析...」
    //   B) 「6. B 解析...」一行式
    //   C) 「6、B」/「6:B」无空格
    //   D) 「第6题」(综合题/计算分析题段落式)
    //   E) 「第6题 解析文字...」行内
    //   F) tab 分隔「6\tB\t解析」
    // ===============================================

    // 先按 tab 切：常见「题号\t答案\t解析」三栏表格
    const tabParts = t.split(/\t+/).map(s => s.trim()).filter(Boolean);
    const tabbed = tabParts.length >= 2 && /^\d+\.?\s*$/.test(tabParts[0]);

    let numMatch = null;
    let restOfLine = '';

    if (tabbed) {
      // tab 分隔：题号 \t 答案字母 \t 解析
      numMatch = [tabParts[0], tabParts[0].replace(/\.$/, '')];
      restOfLine = tabParts.slice(1).join(' ');
    } else {
      // 「数字+标点」前缀题号（修复核心）：支持「6.」「6、」「6:」「6、」「6 」+ 可选内容
      const numPrefix = t.match(/^(\d+)\s*[\.\、\:\u3000]\s*(.*)$/);
      if (numPrefix) {
        numMatch = numPrefix;
        restOfLine = (numPrefix[2] || '').trim();
      } else {
        // 「第N题」段落式（综合题/计算分析题）：支持「第6题」+ 紧跟内容
        const essayInline = t.match(/^第\s*(\d+)\s*题\s*[:：\.\、\s]?\s*(.*)$/);
        if (essayInline) {
          const parentNum = Number(essayInline[1]);
          if (cur) map[curType][cur.num] = cur;
          // 修复 bug：之前 qtypes.find() 直接匹配，若该题号同时存在于 single/multi/judge
          //           （章节内单选编号从 1 开始），会错误地把 curType 改成 single，
          //           导致（1）（2）（3）多行说明误入"单选答案 + 解析续行"分支。
          // 同样在两个分支里都要重置 calcIdx 和 calcQueue，确保新父题的小问从 0 开始数。
          // 修复边界 bug：与 essayHeader 对齐，若实际 qtype 与 curType 不一致也要切换
          //   （如 essay 段后跟 calc 父题），避免 calcQueue 过滤到空。
          // 关键修复:别再用 qtypes.find(num===parentNum) 兜底——会在 single #1
          //   与 calc #1001 共存的章节里错误回退到 single,把已经在 calc/essay 区
          //   的 curType 切到 single,后续所有 subAnsMatch 失效,calc 子题答案全部丢失。
          // 正确做法:用「parentNum*1000」区间定位真实 qtype(专题五无 section header
          //   也能正确切到 calc / essay).
          if (curType === 'calc' || curType === 'essay') {
            const actualType = findQtypeByParent(parentNum);
            if (actualType && actualType !== curType) curType = actualType;
            calcQueue = calcQueueFor(curType).filter(q => Math.floor(q / 1000) === parentNum);
            calcIdx = 0;
            // 不要再用 parentNum 创建 cur——(1)(2)(3) 的 subAnsMatch 会创建 subNum cur,
            //   这样避免在 map[curType][parentNum] 里留下一条假数据(章节没有 parentNum 直接的题)。
            cur = null;
            continue;
          }
          curType = findQtypeByParent(parentNum) || 'essay';
          calcQueue = calcQueueFor(curType).filter(q => Math.floor(q / 1000) === parentNum);
          calcIdx = 0;
          cur = { num: parentNum, answer: '参见解析', explanation: essayInline[2] || '' };
          continue;
        }
      }
    }

    if (numMatch) {
      if (cur) map[curType][cur.num] = cur;
      const n = Number(numMatch[1].replace(/\.$/, '').trim());
      cur = { num: n, answer: '', explanation: '' };
      // 解析本行剩余部分
      if (restOfLine) {
        const ansM = matchAnswerToken(restOfLine);
        if (ansM) {
          cur.answer = ansM.answer;
          if (ansM.rest) cur.explanation = ansM.rest;
        } else {
          cur.explanation = restOfLine;
        }
      }
      continue;
    }

    // 纯题号（兜底，无标点）
    if (/^\d+$/.test(t)) {
      if (cur) map[curType][cur.num] = cur;
      cur = { num: Number(t), answer: '', explanation: '' };
      continue;
    }
    // 段落式答案块开始：「第N题」标记（独立成行）
    const essayHeader = t.match(/^第\s*(\d+)\s*题\s*$/);
    if (essayHeader) {
      if (cur) map[curType][cur.num] = cur;
      const parentNum = Number(essayHeader[1]);
      // 关键：calcQueue 应该是当前父题（parentNum）的子题号（如父 1 → 1001/1002/1003），
      //       而不是整个章节 calc 队列。每次遇到「第N题」重置。
      // 修复策略：
      //   1) 如果当前已经在计算分析/综合题块（curType 是 calc 或 essay），绝不退回到 single，
      //      因为题目可能被拆分成 1001+/1002+ 子题号，按"第N题"形参只拿原始父题号 → 用 Math.floor 反查
      //   2) 否则才尝试从 qtypes 里匹配同号 question
      if (curType === 'calc' || curType === 'essay') {
        const actualType = findQtypeByParent(parentNum);
        if (actualType && actualType !== curType) curType = actualType;
        calcQueue = calcQueueFor(curType).filter(q => Math.floor(q / 1000) === parentNum);
        calcIdx = 0;
        cur = null;
        continue;
      }
      curType = findQtypeByParent(parentNum) || 'essay';
      calcQueue = calcQueueFor(curType).filter(q => Math.floor(q / 1000) === parentNum);
      calcIdx = 0;
      cur = { num: parentNum, answer: '参见解析', explanation: '' };
      continue;
    }
    // 答案字母行：单项 A/B/C/D、多项 "A B C" / "A B" / "ABD" / "ABC"
    // 增强：支持「B 解析...」一行式
    if (cur && /^[A-H]+(?:[\s,、]+[A-H]+)*\s*(.*)$/i.test(t)) {
      const m = t.match(/^([A-H]+(?:[\s,、]+[A-H]+)*)\s*(.*)$/i);
      if (m) {
        const ans = m[1].replace(/[\s,、]+/g, '').toUpperCase();
        if (!cur.answer) cur.answer = ans;
        // 否则忽略（说明这一行的字母是上一题遗留的）
        if (m[2]) cur.explanation = (cur.explanation ? cur.explanation + '\n' : '') + m[2].trim();
        continue;
      }
    }
    // 判断题答案
    if (cur && /^(对|错|正确|错误|√|×|T|F|True|False)$/i.test(t)) {
      cur.answer = t;
      continue;
    }
    // 解析文字（累积多行直到下一个题号/答案字母）
    if (cur) {
      cur.explanation = (cur.explanation ? cur.explanation + '\n' : '') + t;
    }
  }
  if (cur) map[curType][cur.num] = cur;
  return map;
}

/**
 * 从字符串开头识别「答案 token」，返回 { answer, rest }
 * 支持：单个/多个大写字母、对错符号、中文「对」「错」
 * 例：「B 解析...」→ { answer:'B', rest:'解析...' }
 * 例：「A B C 解析」→ { answer:'ABC', rest:'解析' }
 * 例：「对 解析」→ { answer:'对', rest:'解析' }
 */
function matchAnswerToken(s) {
  const m = s.match(/^([A-H]+(?:[\s,、]+[A-H]+)*|√|×|对|错|正确|错误|T|F|True|False)\s*(.*)$/i);
  if (!m) return null;
  let tok = m[1].trim();
  if (/^(对|错|正确|错误|√|×|T|F|True|False)$/i.test(tok)) {
    return { answer: tok, rest: (m[2] || '').trim() };
  }
  // 多字母答案：去分隔符
  const compact = tok.replace(/[\s,、]+/g, '').toUpperCase();
  return { answer: compact, rest: (m[2] || '').trim() };
}

/* ============ 解析预览 ============ */
function renderParsePreview(sections) {
  if (!sections || !sections.length) {
    $('#parse-body').innerHTML = emptyHTML('未识别到任何题目，请检查 PDF 是否为文本型（非扫描件）', 'warn');
    $('#btn-confirm-parse').disabled = true;
    return;
  }
  const total = sections.reduce((s, x) => s + x.questions.length, 0);
  // 默认教材名 = PDF 文件名；若有同名教材则显示"已有同名教材，将合并追加"
  const bookName = pendingPdfName || '未命名教材';
  const dupBook = state.books.find(b => b.name.trim() === bookName.trim());
  const html = `
    <div class="parse-summary">
      识别到 <strong>${sections.length}</strong> 章 · <strong>${total}</strong> 题。
      可以重命名教材/章节、编辑/删除题目，确认无误后导入题库。
    </div>
    <div class="parse-book-row" style="background:var(--primary-soft);border:1px solid var(--border);padding:12px 14px;border-radius:8px;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--primary)">${icon('book', 'icon')}<span>教材名：</span></span>
      <input type="text" id="parse-book-name" value="${escapeHTML(bookName)}"
        style="flex:1;min-width:180px;padding:6px 10px;border:1px solid var(--border-2);border-radius:6px;font:inherit;background:var(--bg-2);color:var(--fg)" />
      ${dupBook
        ? `<span class="muted" style="display:inline-flex;align-items:center;gap:4px;color:var(--warn);font-size:12px">${icon('warn', 'icon icon-sm icon-warn')}已存在同名教材「${escapeHTML(bookName)}」，导入后章节会追加进去</span>`
        : `<span class="muted" style="font-size:12px">新建一本教材</span>`}
    </div>
    ${sections.map((sec, sIdx) => `
      <div class="parse-chapter-block" data-sidx="${sIdx}">
        <h4>
          <input type="text" value="${escapeHTML(sec.name)}" data-field="name" />
          <span class="muted">${sec.questions.length} 题</span>
          <button class="btn small danger" data-del-chap>${icon('trash', 'icon icon-sm')}移除整章</button>
        </h4>
        ${sec.questions.map((q, qIdx) => `
          <div class="parse-q-item" data-qidx="${qIdx}">
            <div class="text">
              <div class="stem">${escapeHTML(q.stem.slice(0, 240))}${q.stem.length > 240 ? '…' : ''}</div>
              ${q.options.length ? `<div class="opts">${q.options.map(o => `<span>${o.key}. ${escapeHTML(o.text)}</span> `).join('')}</div>` : ''}
              ${q.answer ? `<div class="opts" style="color:var(--success)">答案：${escapeHTML(q.answer)}</div>` : ''}
              ${q.explanation ? `<div class="opts">解析：${escapeHTML(q.explanation.slice(0, 130))}${q.explanation.length > 130 ? '…' : ''}</div>` : ''}
            </div>
            <div class="actions">
              <button data-edit-q title="编辑">${icon('edit', 'icon icon-sm')}</button>
              <button data-del-q class="del" title="删除">${icon('close', 'icon icon-sm')}</button>
            </div>
          </div>
        `).join('')}
      </div>
    `).join('')}
  `;
  $('#parse-body').innerHTML = html;
  $('#btn-confirm-parse').disabled = false;
  const bookInput = $('#parse-book-name');
  if (bookInput) {
    bookInput.addEventListener('input', e => { pendingPdfName = e.target.value; });
  }

  $$('.parse-chapter-block').forEach(block => {
    block.querySelector('[data-del-chap]').addEventListener('click', () => {
      const sIdx = Number(block.dataset.sidx);
      pendingParsed[sIdx].questions = [];
      renderParsePreview(pendingParsed);
    });
    block.querySelectorAll('[data-qidx]').forEach(item => {
      const sIdx = Number(block.dataset.sidx);
      const qIdx = Number(item.dataset.qidx);
      item.querySelector('[data-del-q]').addEventListener('click', () => {
        pendingParsed[sIdx].questions.splice(qIdx, 1);
        renderParsePreview(pendingParsed);
      });
      item.querySelector('[data-edit-q]').addEventListener('click', () => {
        const q = pendingParsed[sIdx].questions[qIdx];
        const next = promptEditQuestion(q);
        if (next) {
          pendingParsed[sIdx].questions[qIdx] = next;
          renderParsePreview(pendingParsed);
        }
      });
    });
    block.querySelector('[data-field="name"]').addEventListener('input', e => {
      pendingParsed[sIdx].name = e.target.value;
    });
  });
}

function confirmParseImport() {
  if (!pendingParsed || !pendingParsed.length) return;
  const bookName = (pendingPdfName || '未命名教材').trim() || '未命名教材';
  // 按教材名去重：同名教材复用，否则新建
  let book = state.books.find(b => b.name.trim() === bookName);
  if (!book) {
    const maxOrder = state.books.reduce((m, b) => Math.max(m, b.order || 0), -1);
    book = { id: uid(), name: bookName, createdAt: Date.now(), order: maxOrder + 1 };
    state.books.push(book);
  }
  // 缓存教材原文，供「从教材划取」使用
  if (pendingSourceText && pendingSourceText.length > 100) {
    book.sourceText = pendingSourceText;
  }
  let imported = 0;
  pendingParsed.forEach(sec => {
    if (!sec.name.trim() || !sec.questions.length) return;
    let ch = state.chapters.find(c => c.bookId === book.id && c.name.trim() === sec.name.trim());
    if (!ch) {
      ch = { id: uid(), bookId: book.id, name: sec.name.trim(), createdAt: Date.now() };
      state.chapters.push(ch);
    }
    sec.questions.forEach(q => {
      state.questions.push({
        id: uid(),
        chapterId: ch.id,
        stem: q.stem,
        options: q.options,
        answer: q.answer,
        explanation: q.explanation,
        note: '',
        isWrong: false,
        isFav: false,
        attempts: 0,
        correct: 0,
        lastAt: null,
        history: [],
        createdAt: Date.now(),
        qtype: q.qtype || 'single',
      });
      imported++;
    });
  });
  saveState();
  pendingParsed = null;
  pendingPdfName = null;
  pendingSourceText = null;
  closeModal('modal-parse');
  $('#file-pdf').value = '';
  // 自动跳转到新导入的教材
  currentBookId = book.id;
  currentChapterId = null;
  toast(`已导入 ${imported} 道题到「${book.name}」`);
  renderSidebar(); renderLibrary(); renderStats(); updateBadges();
}

/* ============ 手动录入 / 编辑题目 ============ */
function openQuestionModal(id = null) {
  editingQuestionId = id;
  $('#modal-q-title').textContent = id ? '编辑题目' : '录入题目';
  // 无章节时自动建一本"随手记"教材 + "未命名章节"
  if (!id && state.chapters.length === 0) {
    const book = { id: uid(), name: '随手记', createdAt: Date.now() };
    state.books.push(book);
    const chap = { id: uid(), bookId: book.id, name: '未命名章节', createdAt: Date.now() };
    state.chapters.push(chap);
    currentBookId = book.id;
    currentChapterId = chap.id;
    saveState();
    renderSidebar();
  }
  const sel = $('#q-chapter');
  // 按教材分组：每个教材为一个 optgroup，下面是该教材的章节
  if (state.chapters.length === 0) {
    sel.innerHTML = '<option value="">请先创建章节</option>';
  } else {
    let html = '';
    state.books.forEach(b => {
      const chs = chaptersOfBook(b.id);
      if (!chs.length) return;
      html += `<optgroup label="${icon('book', 'icon icon-sm icon-mauve')} ${escapeHTML(b.name)}">`;
      chs.forEach(c => {
        html += `<option value="${c.id}">${escapeHTML(c.name)}</option>`;
      });
      html += `</optgroup>`;
    });
    sel.innerHTML = html;
  }

  if (id) {
    const q = state.questions.find(x => x.id === id);
    if (!q) return;
    sel.value = q.chapterId;
    $('#q-stem').value = q.stem || '';
    $('#q-options').value = (q.options || []).map(o => `${o.key}. ${o.text}`).join('\n');
    $('#q-answer').value = q.answer || '';
    $('#q-explanation').value = q.explanation || '';
  } else {
    sel.value = currentChapterId || sel.options[0]?.value || '';
    $('#q-stem').value = '';
    $('#q-options').value = '';
    $('#q-answer').value = '';
    $('#q-explanation').value = '';
  }
  openModal('modal-question');
}

function saveQuestionFromModal() {
  const letters = ['A','B','C','D','E','F','G','H'];
  const parsed = [];
  $('#q-options').value.split('\n').map(l => l.trim()).filter(Boolean).forEach((line, i) => {
    const m = line.match(/^([A-Z])[\.\、\:\uff1a]\s*(.+)$/i);
    if (m) parsed.push({ key: m[1].toUpperCase(), text: m[2].trim() });
    else parsed.push({ key: letters[i], text: line });
  });

  const data = {
    chapterId: $('#q-chapter').value,
    stem: $('#q-stem').value.trim(),
    options: parsed,
    answer: $('#q-answer').value.trim(),
    explanation: $('#q-explanation').value.trim(),
  };

  if (!data.stem) { toast('请填写题干', 'danger'); return; }
  if (!data.chapterId) { toast('请先创建章节', 'danger'); return; }

  if (editingQuestionId) {
    const q = state.questions.find(x => x.id === editingQuestionId);
    Object.assign(q, data);
  } else {
    state.questions.push({
      id: uid(),
      ...data,
      note: '',
      isWrong: false, isFav: false,
      attempts: 0, correct: 0,
      lastAt: null, history: [],
      createdAt: Date.now(),
    });
  }
  saveState();
  closeModal('modal-question');
  toast('已保存');
  renderLibrary(); renderSidebar(); renderStats();
}

function promptEditQuestion(q) {
  const stem = prompt('题干', q.stem || '');
  if (stem === null) return null;
  const opts = prompt('选项（每行一项，可用 "A. xxx" 格式）',
    q.options.map(o => `${o.key}. ${o.text}`).join('\n'));
  const answer = prompt('正确答案', q.answer || '');
  const explanation = prompt('解析', q.explanation || '');
  const parsed = (opts || '').split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
    const m = line.match(/^([A-Z])[\.\、\:\uff1a]\s*(.+)$/i);
    return m ? { key: m[1].toUpperCase(), text: m[2].trim() }
             : { key: ['A','B','C','D','E','F'][i], text: line };
  });
  return {
    stem: stem.trim(),
    options: parsed,
    answer: (answer || '').trim(),
    explanation: (explanation || '').trim(),
  };
}

function addNewChapter() {
  // 确保有一个教材：当前选中教材 > 否则建一个「默认教材」
  let bookId = currentBookId;
  if (!bookId && state.books.length === 0) {
    bookId = uid();
    state.books.push({ id: bookId, name: '默认教材', createdAt: Date.now() });
    currentBookId = bookId;
  } else if (!bookId) {
    bookId = state.books[0].id;
    currentBookId = bookId;
  }
  const name = prompt(`在「${findBook(bookId)?.name || '默认教材'}」下新建章节：`, '新章节');
  if (!name) return;
  const ch = { id: uid(), bookId, name: name.trim(), createdAt: Date.now() };
  state.chapters.push(ch);
  currentChapterId = ch.id;
  saveState();
  renderSidebar(); renderLibrary();
  toast('章节已创建');
}

function deleteChapter() {
  if (!currentChapterId) return;
  const ch = findChapter(currentChapterId);
  if (!ch) return;
  const n = questionsOfChapter(ch.id).length;
  if (!confirm(`删除章节「${ch.name}」${n > 0 ? `及其 ${n} 道题` : ''}吗？`)) return;
  state.chapters = state.chapters.filter(c => c.id !== ch.id);
  state.questions = state.questions.filter(q => q.chapterId !== ch.id);
  currentChapterId = null;
  saveState();
  renderSidebar(); renderLibrary(); renderStats(); renderWrongBook(); renderFavorites(); updateBadges();
  toast('已删除');
}

function deleteBook() {
  if (!currentBookId) return;
  const bk = findBook(currentBookId);
  if (!bk) return;
  const chs = chaptersOfBook(bk.id);
  const total = questionsOfBook(bk.id).length;
  if (!confirm(`删除整本教材「${bk.name}」？\n\n将一并删除 ${chs.length} 章${total ? ` · ${total} 道题` : ''}，此操作不可撤销！`)) return;
  const removeChapIds = new Set(chs.map(c => c.id));
  state.chapters = state.chapters.filter(c => c.bookId !== bk.id);
  state.questions = state.questions.filter(q => !removeChapIds.has(q.chapterId));
  state.books = state.books.filter(b => b.id !== bk.id);
  currentBookId = null;
  currentChapterId = null;
  saveState();
  renderSidebar(); renderLibrary(); renderStats(); renderWrongBook(); renderFavorites(); updateBadges();
  toast(`已删除「${bk.name}」`);
}

function clearAllLibrary() {
  if (!confirm('此操作将清空所有教材、章节、题目与练习记录，不可撤销！')) return;
  const txt = ($('#clear-confirm-input')?.value || '').trim();
  if (txt !== '确认清空') { toast('输入不正确，已取消', 'danger'); return; }
  state.books = [];
  state.chapters = [];
  state.questions = [];
  state.practice = { active: false, set: [], idx: 0, mode: 'sequential', range: 'all', chapterId: null };
  currentBookId = null;
  currentChapterId = null;
  saveState();
  renderSidebar(); renderLibrary(); renderStats(); renderWrongBook(); renderFavorites(); updateBadges();
  closeModal('modal-clear');
  $('#clear-confirm-input').value = '';
  toast('题库已清空');
}

/* ============ 帮助 / 上手指南 modal ============ */
const HELP_CONTENT = {
  guide: () => `
    <div class="help-section">
      <h3>${icon('bookOpen', 'icon-mauve')} 上手指南</h3>
      <p>这是一款轻量的财务题库应用，主要用于在 <strong>本地浏览器</strong> 中刷题。所有数据都存在 localStorage 里，不会上传到服务器。</p>
    </div>

    <div class="help-section">
      <h3>${icon('upload', 'icon-mauve')} 1. 导入题库</h3>
      <ul>
        <li><strong>从文件导入</strong>：点击「上传文件」按钮，支持 <strong>.docx（推荐）</strong>、.pdf、.txt、.md 四种格式</li>
        <li><strong>手动录入</strong>：点「手动录入」可单题添加（适合老师或自制题）</li>
        <li><strong>Word 教材示例</strong>：教材若用「1. 题干 A. 选项 B. 选项」这种格式，会自动识别为选择题；若用「1.【2024·综合题】资料一...」这种段落格式，会识别为综合题</li>
        <li><strong>扫描件 PDF</strong>：如果上传的是扫描版 PDF，会自动走 OCR 识别（首次会下载中英文识别模型）</li>
      </ul>
    </div>

    <div class="help-section">
      <h3>${icon('target', 'icon-mauve')} 2. 练习模式</h3>
      <ul>
        <li><strong>选择题</strong>：点击选项立刻看到对错反馈和解析</li>
        <li><strong>综合题 / 计算分析题</strong>：看题→在答题区写答案→提交→对照参考答案后点「答对了 / 答错了」手动判定</li>
        <li>答错的题会自动进入「错题本」，收藏的题进入「收藏」</li>
      </ul>
    </div>

    <div class="help-section">
      <h3>${icon('chart', 'icon-mauve')} 3. 统计</h3>
      <ul>
        <li>「统计」tab 里能看到各章节掌握度、最近 7 天刷题量、总览数据</li>
        <li>错题本/收藏都可单独导出或清空</li>
      </ul>
    </div>

    <div class="help-section">
      <h3>${icon('settings', 'icon-mauve')} 4. 数据备份</h3>
      <ul>
        <li>本应用所有数据都存浏览器本地（localStorage），<strong>清浏览器缓存会丢数据</strong></li>
        <li>建议每隔一段时间通过「设置 → 导出题库」备份一份 JSON 文件</li>
        <li>需要换设备时，用「导入题库」恢复</li>
      </ul>
    </div>
  `,

  shortcuts: () => `
    <div class="help-section">
      <h3>${icon('keyboard', 'icon-mauve')} 键盘快捷键</h3>
      <table class="shortcut-table">
        <tr><td><kbd>1</kbd> - <kbd>4</kbd></td><td>在练习中选择 A / B / C / D 选项</td></tr>
        <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>上一题 / 下一题</td></tr>
        <tr><td><kbd>Space</kbd></td><td>显示答案与解析</td></tr>
        <tr><td><kbd>F</kbd></td><td>收藏 / 取消收藏</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>关闭弹窗 / 关闭下拉</td></tr>
        <tr><td><kbd>Enter</kbd>（题库搜索框内）</td><td>把搜索结果作为练习范围</td></tr>
      </table>
    </div>
    <div class="help-section">
      <p style="font-size:12px;color:var(--fg-2)">提示：在题目练习卡页按上述键即可。所有快捷键不影响输入框本身。</p>
    </div>
  `,

  about: () => `
    <div class="help-section">
      <h3>${icon('info', 'icon-mauve')} 关于</h3>
      <p><strong>财管轻一题库 · 本地版</strong></p>
      <p>适用于东奥《轻松过关一》配套题库。纯前端实现，单 HTML 文件即可运行。</p>
      <ul>
        <li>数据全部存浏览器 localStorage，<strong>不上传任何信息</strong></li>
        <li>支持 .docx（推荐）/ .pdf / .txt / .md 四种格式导入</li>
        <li>扫描件 PDF 自动调用 OCR 引擎（首次会下载约 20MB 模型）</li>
        <li>支持章节分组、错题本、收藏、统计</li>
      </ul>
    </div>
    <div class="help-section">
      <h3>${icon('bulb', 'icon-warn')} 常见问题</h3>
      <ul>
        <li><strong>Q：上传 Word 没反应？</strong><br/>A：检查浏览器控制台是否有报错，或换 .docx（不是 .doc）/ .pdf 重试</li>
        <li><strong>Q：综合题答案为空？</strong><br/>A：教材若用「（1）（2）」子问题格式且答案区没有「第 N 题」标记，会自动整章作为单题归并，整体作为一个综合题解析</li>
        <li><strong>Q：扫描 PDF 识别不准？</strong><br/>A：扫描件走 OCR，识别率受印刷清晰度影响，可结合「手动录入」微调</li>
      </ul>
    </div>
  `,
};

function openHelpModal(kind = 'guide') {
  const body = $('#help-body');
  const title = $('#modal-help-title');
  if (!body || !title) return;
  const fn = HELP_CONTENT[kind] || HELP_CONTENT.guide;
  const labels = { guide: '上手指南', shortcuts: '快捷键', about: '关于' };
  title.innerHTML = icon({guide:'bookOpen', shortcuts:'keyboard', about:'info'}[kind] || 'info', 'icon icon-mauve')
    + '<span style="margin-left:6px">' + (labels[kind] || '帮助') + '</span>';
  body.innerHTML = fn();
  openModal('modal-help');
}

/* ============ 重命名教材 / 章节 ============ */
let renameTarget = null;  // { kind: 'book'|'chapter', id }

function openRenameBookModal(id) {
  const bk = findBook(id);
  if (!bk) return;
  renameTarget = { kind: 'book', id };
  $('#rename-input').value = bk.name;
  openModal('modal-rename');
  setTimeout(() => { $('#rename-input').focus(); $('#rename-input').select(); }, 50);
}
function openRenameChapterModal(id) {
  const ch = findChapter(id);
  if (!ch) return;
  renameTarget = { kind: 'chapter', id };
  $('#rename-input').value = ch.name;
  openModal('modal-rename');
  setTimeout(() => { $('#rename-input').focus(); $('#rename-input').select(); }, 50);
}
function confirmRename() {
  const newName = ($('#rename-input').value || '').trim();
  if (!newName) { toast('名称不能为空', 'danger'); return; }
  if (!renameTarget) return;
  if (renameTarget.kind === 'book') {
    const bk = findBook(renameTarget.id);
    if (!bk) return;
    if (state.books.some(b => b.id !== bk.id && b.name.trim() === newName)) {
      toast('已存在同名教材', 'danger'); return;
    }
    bk.name = newName;
  } else {
    const ch = findChapter(renameTarget.id);
    if (!ch) return;
    ch.name = newName;
  }
  saveState();
  closeModal('modal-rename');
  renameTarget = null;
  renderSidebar(); renderLibrary();
  toast('已重命名');
}

/* ============ 练习 ============ */

/** 题型 / 题况（提醒）筛选的文案 */
const PRACTICE_FLAG_LABEL = {
  'no-answer': '⚠ 无答案',
  'no-explain': '⚠ 无解析',
  'both-missing': '❌ 答案解析都缺',
  'unpracticed': '未练习过',
  'wrong': '错题',
};

/** 题况筛选：与题库页 ⚠/❌ 标记同一口径 */
function matchPracticeFlag(q, flag) {
  if (!flag || flag === 'all') return true;
  const noAns = !(q.answer || '').trim();
  const noExp = !(q.explanation || '').trim();
  if (flag === 'no-answer') return noAns;
  if (flag === 'no-explain') return noExp;
  if (flag === 'both-missing') return noAns && noExp;
  if (flag === 'unpracticed') return !q.attempts;
  if (flag === 'wrong') return !!q.isWrong;
  return true;
}

/** 当前筛选条件下的题池（不含 range：range 在 startPractice 里先算基池） */
function filterPracticePool(pool, qtypeFilter, flagFilter) {
  let out = pool;
  if (qtypeFilter && qtypeFilter !== 'all') {
    out = out.filter(q => resolveQtypeRaw(q) === qtypeFilter);
  }
  if (flagFilter && flagFilter !== 'all') {
    out = out.filter(q => matchPracticeFlag(q, flagFilter));
  }
  return out;
}

/** 刷新练习栏筛选下拉的计数（题型 / 题况各多少题）。数据没变就直接跳过，避免无谓重建 DOM */
let _practiceFilterSig = '';
function refreshPracticeFilters() {
  const qtypeSel = $('#practice-qtype');
  const flagSel = $('#practice-flag');
  if (!qtypeSel && !flagSel) return;
  const all = state.questions || [];
  const sig = [all.length,
    all.filter(q => q.isWrong).length,
    all.filter(q => q.attempts).length,
    all.filter(q => !(q.answer || '').trim()).length].join('|');
  if (_practiceFilterSig === sig) return;
  _practiceFilterSig = sig;
  if (qtypeSel) {
    const keep = qtypeSel.value || 'all';
    const opts = [['all', '全部题型']].concat(
      ['single', 'multi', 'judge', 'calc', 'essay'].map(t => [t, qtypeInfo(t).text]));
    qtypeSel.innerHTML = opts.map(([v, label]) => {
      const n = v === 'all' ? all.length : all.filter(q => resolveQtypeRaw(q) === v).length;
      return `<option value="${v}">${escapeHTML(label)}（${n}）</option>`;
    }).join('');
    qtypeSel.value = keep;
    if (!qtypeSel.value) qtypeSel.value = 'all';
  }
  if (flagSel) {
    const keep = flagSel.value || 'all';
    const opts = [['all', '全部题况']]
      .concat(Object.keys(PRACTICE_FLAG_LABEL).map(k => [k, PRACTICE_FLAG_LABEL[k]]));
    flagSel.innerHTML = opts.map(([v, label]) => {
      const n = v === 'all' ? all.length : all.filter(q => matchPracticeFlag(q, v)).length;
      return `<option value="${v}">${escapeHTML(label)}（${n}）</option>`;
    }).join('');
    flagSel.value = keep;
    if (!flagSel.value) flagSel.value = 'all';
  }
}

/**
 * 组装并开始一次练习。
 * @returns {boolean} true = 真的组卷成功（练习卡片已渲染）；false = 题池为空 / 被筛选清空，只弹了提示
 */
function startPractice() {
  const range = $('#practice-range').value;
  const mode = $('#practice-mode').value;
  const qtypeFilter = ($('#practice-qtype') || {}).value || 'all';
  const flagFilter = ($('#practice-flag') || {}).value || 'all';
  const chapSel = $('#practice-chapter-pick');
  let pool = [];
  if (range === 'all') pool = state.questions.slice();
  else if (range === 'chapter') {
    const cid = chapSel?.value || currentChapterId;
    if (!cid) { toast('请先选择章节', 'danger'); return false; }
    pool = questionsOfChapter(cid);
  }
  else if (range === 'wrong') pool = state.questions.filter(q => q.isWrong);
  else if (range === 'fav') pool = state.questions.filter(q => q.isFav);
  else if (range === 'unfav') pool = state.questions.filter(q => !q.isFav);
  else if (range === 'unwrong') pool = state.questions.filter(q => !q.isWrong);

  if (!pool.length) {
    toast(range === 'wrong' ? '错题本是空的，先去做几道题吧' : '没有可练习的题目', 'danger');
    return false;
  }

  // 二次筛选：题型 + 题况提醒
  const beforeFilter = pool.length;
  pool = filterPracticePool(pool, qtypeFilter, flagFilter);
  if (!pool.length) {
    toast(`筛选后没有题目（原范围 ${beforeFilter} 题）`, 'danger');
    return false;
  }

  // 乱序：复制题库，洗牌
  if (mode === 'shuffle') {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }

  state.practice = {
    active: true,
    set: pool.map(q => q.id),
    idx: 0,
    mode,
    range,
    qtypeFilter,
    flagFilter,
    chapterId: chapSel?.value || null,
    _answers: [],
  };
  // 总分预览：让用户开始前就知道这一套卷子多少分
  const totalScore = round2(pool.reduce((s, q) => s + fullScoreOf(q, resolveQtypeRaw(q)), 0));
  const filterDesc = []
    .concat(qtypeFilter !== 'all' ? [qtypeInfo(qtypeFilter).text] : [])
    .concat(flagFilter !== 'all' ? [PRACTICE_FLAG_LABEL[flagFilter]] : [])
    .join(' · ');
  toast(`${pool.length} 题 · 共 ${fmtScore(totalScore)} 分${filterDesc ? '（' + filterDesc + '）' : ''}`);
  saveState();
  renderPracticeCard();
  return true;
}

function renderPracticeCard() {
  const p = state.practice;
  const area = $('#practice-area');
  if (!p.active || !p.set.length) {
    area.innerHTML = emptyHTML('选择范围后点击「开始练习」', 'target');
    return;
  }
  if (p.idx >= p.set.length) {
    const cnt = p._answers || [];
    // 「待核对」的手动判定题（计算分析题/综合题）不计入正确率与得分
    const pendingList = cnt.filter(a => a.pending);
    const judged = cnt.filter(a => !a.pending);
    const right = judged.filter(a => a.isCorrect).length;
    const total = judged.length;
    const pct = total ? Math.round(right * 100 / total) : 0;
    const gotScore = round2(judged.reduce((s, a) => s + (Number(a.score) || 0), 0));
    const maxScore = round2(judged.reduce((s, a) => s + (Number(a.fullScore) || 0), 0));
    const scorePct = maxScore ? Math.round(gotScore * 100 / maxScore) : 0;
    // 分题型小计
    const ORDER = ['single', 'multi', 'judge', 'calc', 'essay'];
    const byType = {};
    judged.forEach(a => {
      const t = a.typeKey || 'single';
      const b = byType[t] || (byType[t] = { got: 0, max: 0, right: 0, n: 0 });
      b.got += Number(a.score) || 0;
      b.max += Number(a.fullScore) || 0;
      b.n++;
      if (a.isCorrect) b.right++;
    });
    const breakdown = ORDER.filter(t => byType[t]).map(t => {
      const b = byType[t];
      const w = b.max ? Math.round(b.got * 100 / b.max) : 0;
      return `
        <div class="fb-row">
          <span class="fb-name">${escapeHTML(qtypeInfo(t).text)}</span>
          <span class="fb-bar"><i style="width:${w}%"></i></span>
          <span class="fb-score">${fmtScore(round2(b.got))} / ${fmtScore(round2(b.max))}</span>
          <span class="fb-meta">${b.right}/${b.n} 题</span>
        </div>`;
    }).join('');
    const firstPendingQid = pendingList.length ? pendingList[0].qid : null;
    const firstPendingPos = firstPendingQid ? p.set.indexOf(firstPendingQid) : -1;
    area.innerHTML = `
      <div class="practice-finish">
        <div style="display:flex;align-items:center;justify-content:center;gap:10px">
          <h2 style="margin:0">本次练习结束</h2>
          ${icon('celebrate', 'icon icon-lg icon-warn')}
        </div>
        <div class="score">${fmtScore(gotScore)}<span class="score-sub">/ ${fmtScore(maxScore)} 分</span></div>
        <p class="muted">得分率 ${scorePct}% · 答对 ${right} / ${total} 题（正确率 ${pct}%）${pendingList.length ? ` · 另有 ${pendingList.length} 题待核对（未计入）` : ''}</p>
        ${breakdown ? `<div class="finish-breakdown">${breakdown}</div>` : ''}
        ${pendingList.length ? `
          <div class="finish-pending">
            ${icon('bulb', 'icon icon-sm icon-warn')}
            <span>有 ${pendingList.length} 道计算分析题需要你手动判定得分，判定后会计入得分与正确率。</span>
          </div>` : ''}
        <div style="display:flex;gap:10px;justify-content:center;margin-top:20px;flex-wrap:wrap">
          ${pendingList.length && firstPendingPos >= 0
            ? `<button class="btn warn" id="btn-goto-pending">${icon('edit', 'icon')}<span>去核对这 ${pendingList.length} 题</span></button>`
            : ''}
          <button class="btn" id="btn-restart">${icon('refresh', 'icon')}<span>再来一次</span></button>
          <button class="btn primary" id="btn-to-stats">${icon('chart', 'icon')}<span>查看统计</span></button>
        </div>
      </div>
    `;
    area.querySelector('#btn-restart').addEventListener('click', () => { p.idx = 0; p._answers = []; saveState(); renderPracticeCard(); });
    area.querySelector('#btn-to-stats').addEventListener('click', () => {
      $$('.tab').find(b => b.dataset.tab === 'stats').click();
    });
    const gp = area.querySelector('#btn-goto-pending');
    if (gp) gp.addEventListener('click', () => { p.idx = firstPendingPos; saveState(); renderPracticeCard(); });
    return;
  }
  const q = state.questions.find(x => x.id === p.set[p.idx]);
  if (!q) { p.idx++; return renderPracticeCard(); }

  const options = q.options && q.options.length
    ? q.options
    : guessOptionsFromStem(q.stem);
  const answered = q._practiceAnswer;
  const hasOptions = options.length > 0;
  // 题型：single / multi / judge / calc / essay（唯一入口，保证控件与判分规则一致）
  const typeKey = resolveQtypeRaw(q);
  const questionType = qtypeToInputMode(typeKey);      // choice / tf / essay
  const isMulti = typeKey === 'multi';
  const fullScore = fullScoreOf(q, typeKey);
  const correctKeys = hasOptions ? normalizeAnswerKeys(q.answer, options) : [];
  const userKeys = answered ? selectedKeysOf(answered.userKeys) : selectedKeysOf(q._practiceSelected);
  const userAns = answered
    ? answered.userAnswer
    : (questionType === 'choice' ? (userKeys.join('') || null) : null);

  // 题型标签（顶部右上角）
  const qt = qtypeInfo(typeKey);

  // 顶部状态：待核对 / 部分得分 / 正确 / 错误
  let statusHTML = '';
  if (answered) {
    if (isPendingJudgement(answered)) {
      statusHTML = `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--warn)">${icon('bulb', 'icon icon-sm')} 待核对</span>`;
    } else if (answered.level === 'partial') {
      statusHTML = `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--warn)">${icon('bulb', 'icon icon-sm')} 部分得分 ${fmtScore(answered.score)} 分</span>`;
    } else if (answered.isCorrect) {
      statusHTML = `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--success)">${icon('check', 'icon icon-sm')} 正确 ${fmtScore(answered.score)} 分</span>`;
    } else {
      statusHTML = `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--danger)">${icon('x', 'icon icon-sm')} 错误 0 分</span>`;
    }
  }
  // 当前生效的筛选（提醒用户这套题是怎么筛出来的）
  const filterDesc = []
    .concat(p.qtypeFilter && p.qtypeFilter !== 'all' ? [qtypeInfo(p.qtypeFilter).text] : [])
    .concat(p.flagFilter && p.flagFilter !== 'all' ? [PRACTICE_FLAG_LABEL[p.flagFilter]] : [])
    .join(' · ');

  area.innerHTML = `
    <div class="practice-card">
      <div class="practice-progress">
        <span>第 ${p.idx + 1} / ${p.set.length} 题${filterDesc ? ` · ${escapeHTML(filterDesc)}` : ''}${q._practiceAnswer ? ' · 已作答' : ''}</span>
        <span>${statusHTML}</span>
      </div>
      <div class="progress-bar"><div style="width:${(p.idx / p.set.length) * 100}%"></div></div>
      <div class="practice-stem-wrap">
        <span class="qtype-tag ${qt.cls}" title="${escapeHTML(qt.text)} · 本题满分 ${fmtScore(fullScore)} 分">${icon(qt.icon, 'icon icon-sm')} ${escapeHTML(qt.text)} · ${fmtScore(fullScore)}分</span>
        <div class="practice-stem">${escapeHTML(q.stem || '')}</div>
      </div>
      ${hasOptions && questionType === 'choice' ? renderChoiceOptions(options, userKeys, correctKeys, q, isMulti) : ''}
      ${questionType === 'tf' ? renderTrueFalse(userAns, q.answer) : ''}
      ${questionType === 'essay' ? renderEssayInput(userAns, q.answer) : ''}
      ${userAns ? renderFeedback(q, userAns, correctKeys, options, questionType, typeKey) : ''}
      ${renderNoteArea(q, !!userAns)}
      <div class="practice-actions">
        <div class="left">
          ${p.idx > 0 ? `<button class="btn" id="btn-prev">${icon('arrowLeft', 'icon icon-sm')}<span>上一题</span></button>` : ''}
          <button class="btn ghost" id="btn-skip">${icon('skip', 'icon icon-sm')}<span>跳过</span></button>
        </div>
        <div class="right">
          ${userAns ? `<button class="btn primary" id="btn-next">${icon('arrowRight', 'icon icon-sm')}<span>下一题</span></button>`
                   : `<button class="btn primary" id="btn-submit">${icon('check', 'icon icon-sm')}<span>提交</span></button>`}
        </div>
      </div>
    </div>
  `;

  if (!userAns) {
    // 选择题 + 判断题：点击选项按钮
    //   多选题：点一次选中、再点取消，可同时选中多个（这是原先的 bug：无论题型都强制单选）
    const syncMultiCount = () => {
      const el = area.querySelector('#multi-count');
      if (el) el.textContent = `已选 ${selectedKeysOf(q._practiceSelected).length} 项`;
    };
    area.querySelectorAll('.practice-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (isMulti) {
          const cur = new Set(selectedKeysOf(q._practiceSelected));
          if (cur.has(key)) cur.delete(key); else cur.add(key);
          q._practiceSelected = [...cur].sort();
          btn.classList.toggle('selected', cur.has(key));
          syncMultiCount();
        } else {
          area.querySelectorAll('.practice-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          q._practiceSelected = [key];
        }
      });
    });
    syncMultiCount();
    const submitBtn = area.querySelector('#btn-submit');
    if (submitBtn) submitBtn.addEventListener('click', () => submitPracticeAnswer(q));
  } else {
    area.querySelector('#btn-next').addEventListener('click', () => goNext());
    // 计算分析题 / 综合题：手动判定得分（覆盖自动比对结果）
    const judgeBar = area.querySelector('.judge-bar');
    if (judgeBar) {
      judgeBar.querySelectorAll('[data-judge]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.dataset.judge === 'score') {
            const input = judgeBar.querySelector('#judge-score');
            judgeEssayAnswer(q, 'score', input ? input.value : null);
          } else {
            judgeEssayAnswer(q, btn.dataset.judge);
          }
        });
      });
      const undoBtn = judgeBar.querySelector('[data-undojudge]');
      if (undoBtn) undoBtn.addEventListener('click', () => judgeEssayAnswer(q, 'pending'));
    }
  }
  const prevBtn = area.querySelector('#btn-prev');
  if (prevBtn) prevBtn.addEventListener('click', () => { p.idx--; saveState(); renderPracticeCard(); });
  area.querySelector('#btn-skip').addEventListener('click', () => goNext());
  const noteEl = area.querySelector('#note-input');
  if (noteEl) {
    let noteTimer;
    noteEl.addEventListener('input', () => {
      q.note = noteEl.value;
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => saveState(), 400);
    });
  }
}

/**
 * 练习卡片里的「我的笔记」区
 *
 * 作答前不展示笔记内容 —— 笔记里往往写着要点、结论甚至答案，边做边看等于抄答案；
 * 但纯隐藏会让人以为笔记丢了，所以只要该题确实记过笔记，就留一条提示占位。
 * 作答后（含跳过不算、必须是真提交过）再完整展示，并可以继续编辑（自动保存）。
 */
function renderNoteArea(q, answered) {
  const note = String(q.note || '');
  if (!answered) {
    if (!note.trim()) return '';
    return `
      <div class="note-area locked">
        <div class="note-locked-hint">
          ${icon('note', 'icon icon-sm icon-olive')}
          <span>本题你记过笔记，作答后会显示在这里</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="note-area">
      <label>我的思考（自动保存）</label>
      <textarea id="note-input" placeholder="记录解题思路、记忆点、错因...">${escapeHTML(note)}</textarea>
    </div>
  `;
}

function submitPracticeAnswer(q) {
  const options = q.options && q.options.length ? q.options : guessOptionsFromStem(q.stem);
  const hasOptions = options.length > 0;
  const typeKey = resolveQtypeRaw(q);
  const questionType = qtypeToInputMode(typeKey);
  const fullScore = fullScoreOf(q, typeKey);
  let ans = null;              // 记录到 userAnswer 的展示值
  let userKeys = [];           // 选择题：已选选项键
  let isEssay = false;

  if (questionType === 'choice') {
    userKeys = selectedKeysOf(q._practiceSelected);
    if (!userKeys.length) { toast('请先选择选项', 'danger'); return; }
    if (typeKey === 'multi' && userKeys.length === 1) {
      // 多选题只选一个：多半是误操作，确认一下（少选只能拿部分分值）
      if (!confirm('本题为多项选择题（两个或以上正确答案），你只选了 1 项。\n\n确定要提交吗？少选只能得相应分值。')) return;
    }
    ans = userKeys.join('');
  } else if (questionType === 'essay') {
    const essayEl = document.getElementById('essay-input');
    isEssay = true;
    ans = essayEl ? essayEl.value.trim() : '';
    if (!ans) { toast('请先填写你的答案', 'danger'); return; }
  } else {
    // 判断题
    userKeys = selectedKeysOf(q._practiceSelected);
    if (!userKeys.length) { toast('请先选择 √ 或 ×', 'danger'); return; }
    ans = userKeys[0];
  }

  const correctKeys = hasOptions ? normalizeAnswerKeys(q.answer, options) : [];
  let graded = { level: 'zero', score: 0, wrongKeys: [], missKeys: [] };
  if (questionType === 'choice') {
    graded = gradeChoiceAnswer(userKeys, correctKeys, typeKey, fullScore);
  } else if (questionType === 'tf') {
    const normCorrect = /错|错误|×|f|false/i.test(String(q.answer || '')) ? '×' : '√';
    graded = gradeChoiceAnswer([ans], [normCorrect], 'judge', fullScore);
  } else {
    // 计算分析题 / 综合题：归一化比较 + 关键短语包含（结果仅供参考，默认落到「待核对」）
    const autoCorrect = compareEssayAnswer(ans, q.answer, q.explanation);
    graded = { level: autoCorrect ? 'full' : 'zero', score: autoCorrect ? fullScore : 0, wrongKeys: [], missKeys: [], autoCorrect };
  }

  const isFull = graded.level === 'full';
  q._practiceAnswer = {
    userAnswer: ans,
    userKeys,
    correctKeys,
    isCorrect: isFull,
    score: graded.score,
    fullScore,
    level: graded.level,
    typeKey,
    at: Date.now(),
    // 选择题 / 判断题由系统判定；主观题匹配不上 → 待核对，由用户手动判定
    judged: isEssay ? (isFull ? 'correct' : 'pending') : (isFull ? 'correct' : (graded.level === 'partial' ? 'partial' : 'wrong')),
    autoCorrect: isEssay ? isFull : undefined,
  };
  q.attempts = (q.attempts || 0) + 1;
  q.lastAt = Date.now();

  const pending = isEssay && !isFull;
  // 「待核对」的题未判定对错，不计入累计正确数与得分
  const countedCorrect = !!q._practiceAnswer.isCorrect && !pending;
  if (countedCorrect) q.correct = (q.correct || 0) + 1;

  q.history = q.history || [];
  q.history.push({
    at: Date.now(), userAnswer: ans, isCorrect: countedCorrect,
    judged: q._practiceAnswer.judged, score: pending ? 0 : graded.score, fullScore,
  });

  // 错题本：只有满分才算掌握
  //   主观题待核对的先不收，等用户手动判定；部分得分（多选少选）算未掌握，收进错题本
  if (pending) q.isWrong = false;
  else q.isWrong = !isFull;

  state.practice._answers = state.practice._answers || [];
  state.practice._answers.push({
    qid: q.id, isCorrect: countedCorrect, pending,
    score: pending ? 0 : graded.score, fullScore, typeKey,
  });

  saveState();
  scheduleSync();   // 自动同步：答题 5 秒后上传
  updateBadges();
  renderPracticeCard();
}

/** 计算分析题 / 综合题：是否处于「待核对」（用户尚未手动判定） */
function isPendingJudgement(pa) {
  if (!pa) return false;
  if (typeof pa.judged === 'string') return pa.judged === 'pending';
  return false;   // 老数据没有 judged 字段 → 按已有 isCorrect 处理
}

/**
 * 计算分析题 / 综合题：手动判定得分
 * @param {object} q      题目对象
 * @param {'correct'|'wrong'|'pending'|'score'} verdict 判定结果；'score' 表示按传入分数部分得分
 * @param {number|string} [manualScore] verdict='score' 时的得分
 *
 * 判定会同步修正：本次练习得分、题目累计正确数 q.correct、错题本 q.isWrong、history 末条记录。
 */
function judgeEssayAnswer(q, verdict, manualScore) {
  const pa = q._practiceAnswer;
  if (!pa) return;
  const full = Number(pa.fullScore) || fullScoreOf(q, pa.typeKey || resolveQtypeRaw(q));
  pa.fullScore = full;
  const prevJudged = isPendingJudgement(pa) ? 'pending' : (pa.isCorrect ? 'correct' : (pa.level === 'partial' ? 'partial' : 'wrong'));
  if (prevJudged === verdict && verdict !== 'score') return;   // 重复点同一个按钮，无需处理

  let score;
  if (verdict === 'correct') score = full;
  else if (verdict === 'wrong') score = 0;
  else if (verdict === 'pending') score = 0;
  else {   // score：手动部分得分
    const v = Number(manualScore);
    if (!isFinite(v)) { toast('请输入 0 ~ ' + fmtScore(full) + ' 之间的分数', 'danger'); return; }
    score = round2(Math.min(Math.max(v, 0), full));
  }

  const nowFull = verdict === 'correct' || (verdict === 'score' && round2(score) >= round2(full) && full > 0);
  const nowPending = verdict === 'pending';
  const nowCounted = nowFull;   // 只有满分才计入「答对」
  const prevCounted = prevJudged === 'correct';

  pa.judged = nowPending ? 'pending' : (nowFull ? 'correct' : (score > 0 ? 'partial' : 'wrong'));
  pa.level = nowPending ? 'zero' : (nowFull ? 'full' : (score > 0 ? 'partial' : 'zero'));
  pa.isCorrect = !nowPending && nowFull;
  pa.score = nowPending ? 0 : score;
  pa.manual = true;
  pa.judgedAt = Date.now();

  // 1) 修正累计正确数（只在「计入/不计入正确」发生翻转时调整）
  if (prevCounted !== nowCounted) {
    q.correct = Math.max(0, (q.correct || 0) + (nowCounted ? 1 : -1));
  }

  // 2) history 末条同步
  const h = q.history && q.history[q.history.length - 1];
  if (h) { h.isCorrect = nowCounted; h.judged = pa.judged; h.manual = true; h.score = pa.score; h.fullScore = full; }

  // 3) 错题本：没拿到满分 → 进错题本；满分/撤销 → 移出
  q.isWrong = nowPending ? false : !nowFull;

  // 4) 本次练习计分同步
  const list = state.practice._answers || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].qid === q.id) {
      list[i].isCorrect = nowCounted;
      list[i].pending = nowPending;
      list[i].judged = pa.judged;
      list[i].score = pa.score;
      list[i].fullScore = full;
      list[i].typeKey = pa.typeKey || list[i].typeKey;
      break;
    }
  }

  saveState();
  scheduleSync();
  updateBadges();
  renderPracticeCard();

  const label = {
    correct: `已判为满分（${fmtScore(full)} 分）`,
    wrong: '已判为 0 分',
    pending: '已撤销判定，回到「待核对」',
    score: `已记为 ${fmtScore(pa.score)} 分`,
  }[verdict] || '已更新判定';
  toast(label + (!nowPending && !nowFull ? '，已加入错题本' : ''), (!nowPending && !nowFull) ? 'danger' : '');
}

/**
 * 计算分析题 / 综合题文字作答比较规则
 * 1. 归一化（去空格、标点、全/半角）后完全相等 → 正确
 * 2. 用户输入包含标准答案关键短语 → 正确
 * 3. 标准答案为「参见解析」时，从 explanation 第一句话提取关键词做包含比对
 */
function compareEssayAnswer(userInput, correctAnswer, explanation) {
  const norm = s => String(s || '').replace(/\s+/g, '').replace(/[，。；：、,.;:!?！?"""''「」『』（）()【】\[\]·\-]/g, '').toLowerCase();
  const u = norm(userInput);
  let c = norm(correctAnswer);
  // 兜底答案为「参见解析」时：从 explanation 第一句话提取关键
  if (!c || /^(参见解析|见解析|详见解析)$/i.test(c)) {
    const firstSentence = String(explanation || '').split(/[。\n]/)[0].slice(0, 30);
    c = norm(firstSentence);
    if (!c) return false;  // 完全没东西可对比
  }
  if (!u) return false;
  if (u === c) return true;
  // 用户输入包含答案（或答案包含用户输入）→ 正确（按短的一方判断）
  if (u.includes(c) || c.includes(u)) return true;
  return false;
}

function goNext() {
  const p = state.practice;
  const q = state.questions.find(x => x.id === p.set[p.idx]);
  if (q) { delete q._practiceAnswer; delete q._practiceSelected; }
  p.idx++;
  saveState();
  renderPracticeCard();
}

function renderFeedback(q, userAns, correctKeys, options, questionType = 'choice', typeKey = 'single') {
  if (questionType === 'choice') {
    const pa = q._practiceAnswer || {};
    const full = round2(pa.fullScore != null ? pa.fullScore : fullScoreOf(q, typeKey));
    const got = round2(pa.score != null ? pa.score : (pa.isCorrect ? full : 0));
    const level = pa.level || (pa.isCorrect ? 'full' : 'zero');
    const corKeys = (pa.correctKeys && pa.correctKeys.length) ? pa.correctKeys : (correctKeys || []);
    const uKeys = (pa.userKeys && pa.userKeys.length)
      ? pa.userKeys
      : selectedKeysOf(userAns);
    const explain = (q.explanation || '').trim();
    const labelOf = k => {
      const o = options.find(x => x.key === k);
      return k + (o && o.text ? ' ' + o.text : '');
    };
    const cls = level === 'full' ? 'correct' : (level === 'partial' ? 'pending' : 'wrong');
    const glyph = level === 'full' ? icon('check', 'icon') : icon(level === 'partial' ? 'bulb' : 'x', 'icon');
    const headText = level === 'full'
      ? `${icon('check', 'icon icon-sm')} 回答正确 · 得 ${fmtScore(got)} 分`
      : level === 'partial'
        ? `${icon('bulb', 'icon icon-sm')} 少选 · 得 ${fmtScore(got)} 分（满分 ${fmtScore(full)} 分）`
        : `${icon('x', 'icon icon-sm')} 回答错误 · 得 0 分（满分 ${fmtScore(full)} 分）`;
    return `
      <div class="feedback ${cls}">
        <div class="feedback-head"><span class="icon icon-circle ${level === 'full' ? 'ok' : (level === 'partial' ? 'pending' : 'wrong')}">${glyph}</span><span>${headText}</span></div>
        <div class="correct-answer-display">
          <span class="ca-label">正确答案</span>
          <span class="ca-key">${escapeHTML(corKeys.join('') || '?')}</span>
          <span class="ca-text">${corKeys.length ? escapeHTML(corKeys.map(labelOf).join('；')) : '(未识别到正确选项文本)'}</span>
        </div>
        <div class="feedback-line your-answer">
          <span class="label">你的作答</span>
          <span class="answer">${escapeHTML(uKeys.join('') || userAns || '未作答')}${uKeys.length ? ' · ' + escapeHTML(uKeys.map(labelOf).join('；')) : ''}</span>
        </div>
        ${level === 'partial' ? `
          <div class="partial-hint">
            ${icon('bulb', 'icon icon-sm icon-warn')}
            <span>漏选：${escapeHTML(corKeys.filter(k => !uKeys.includes(k)).join('、'))}。多项选择题少选得相应分值，多选、错选或不答不得分。</span>
          </div>` : ''}
        ${explain ? `<div class="explanation">${escapeHTML(explain)}</div>` : ''}
      </div>
    `;
  }
  // 判断题 / 简答题 / 计算分析题 / 综合题
  const pa = q._practiceAnswer || {};
  const isEssay = questionType === 'essay';
  const pending = isEssay && isPendingJudgement(pa);
  const ok = pending ? false : !!pa.isCorrect;
  const full = round2(pa.fullScore != null ? pa.fullScore : fullScoreOf(q, typeKey));
  const got = pending ? 0 : round2(pa.score != null ? pa.score : (ok ? full : 0));
  const partial = !pending && !ok && got > 0;
  const explain = (q.explanation || '').trim();
  // 计算分析题 / 综合题的 q.answer 大多是「参见解析」占位符,真正答案在 explanation 里。
  //   这里把 explanation 的前 200 字提到「参考答案」位,避免用户看到一行无意义的"参见解析"。
  const isPlaceholderAnswer = !q.answer || /^(参见解析|见解析|详见解析)$/i.test(String(q.answer).trim());
  const correctDisplay = (isEssay && isPlaceholderAnswer && explain)
    ? explain.split(/\r?\n/)[0].slice(0, 200) + (explain.length > 200 ? '…' : '')
    : (q.answer || '（未设置）');
  const stateCls = pending ? 'pending' : (ok ? 'correct' : (partial ? 'pending' : 'wrong'));
  const headText = pending
    ? `${icon('bulb', 'icon icon-sm')} 待核对 · 自动比对未匹配，请自行判定得分`
    : !isEssay
      ? (ok ? `${icon('check', 'icon icon-sm')} 回答正确 · 得 ${fmtScore(got)} 分` : `${icon('x', 'icon icon-sm')} 回答错误 · 得 0 分（满分 ${fmtScore(full)} 分）`)
      : (ok ? `${icon('check', 'icon icon-sm')} 已判为满分 · ${fmtScore(got)} 分`
            : (partial ? `${icon('bulb', 'icon icon-sm')} 已判为部分得分 · ${fmtScore(got)} 分`
                       : `${icon('x', 'icon icon-sm')} 已判为 0 分（满分 ${fmtScore(full)} 分）`));
  const headGlyph = pending ? icon('bulb', 'icon') : (ok ? icon('check', 'icon') : (partial ? icon('bulb', 'icon') : icon('x', 'icon')));
  return `
    <div class="feedback ${stateCls}">
      <div class="feedback-head"><span class="icon icon-circle ${pending ? 'pending' : (ok ? 'ok' : (partial ? 'pending' : 'wrong'))}">${headGlyph}</span><span>${headText}</span></div>
      <div class="feedback-line your-answer">
        <span class="label">你的作答</span>
        <span class="answer">${escapeHTML(userAns || '未作答')}</span>
      </div>
      <div class="feedback-line correct-answer">
        <span class="label">参考答案</span>
        <span class="answer">${escapeHTML(correctDisplay)}</span>
      </div>
      ${isEssay ? `<div class="feedback-line score-line">
        <span class="label">本题得分</span>
        <span class="answer"><strong>${fmtScore(got)}</strong> / ${fmtScore(full)} 分</span>
      </div>` : ''}
      ${explain ? `<div class="explanation">${escapeHTML(explain)}</div>` : ''}
      ${isEssay ? judgeBarHTML(pending, ok, pa, full) : ''}
    </div>
  `;
}

/**
 * 计算分析题 / 综合题的人工判分条
 * 自动比对只能做「归一化 + 包含」的粗略匹配，表述不同就会落到待核对，
 * 因此给用户一个直接判分的口子（满分 / 0 分 / 任意部分得分），判定结果写回统计与错题本。
 */
function judgeBarHTML(pending, ok, pa, fullScore) {
  const full = round2(fullScore != null ? fullScore : (pa && pa.fullScore) || 0);
  const cur = pending ? '' : fmtScore(round2(pa && pa.score != null ? pa.score : (ok ? full : 0)));
  const partialActive = !pending && !ok && cur !== '' && Number(cur) > 0;
  const autoHint = pa && pa.autoCorrect === true ? '（自动比对：匹配）' : '（自动比对：未匹配）';
  return `
    <div class="judge-bar">
      <div class="judge-hint">
        ${icon('bulb', 'icon icon-sm icon-warn')}
        <span>本题满分 ${fmtScore(full)} 分。计算分析题按步骤给分（科目错误整笔分录不得分），自动比对仅供参考${autoHint}，请对照参考答案判定得分：</span>
      </div>
      <div class="judge-actions">
        <button type="button" class="judge-btn ok ${ok ? 'active' : ''}" data-judge="correct">
          ${icon('checkOutline', 'icon icon-sm')}<span>答对了 · ${fmtScore(full)} 分</span>
        </button>
        <button type="button" class="judge-btn no ${!pending && !ok && !partialActive ? 'active' : ''}" data-judge="wrong">
          ${icon('xOutline', 'icon icon-sm')}<span>答错了 · 0 分</span>
        </button>
        ${pending ? '' : `<button type="button" class="judge-btn undo" data-undojudge="1" title="撤销判定，回到待核对">${icon('refresh', 'icon icon-sm')}<span>撤销</span></button>`}
      </div>
      ${full >= 2 ? `
      <div class="judge-partial">
        <span class="judge-partial-label">部分得分</span>
        <input type="number" id="judge-score" min="0" max="${full}" step="0.5"
          value="${partialActive ? escapeHTML(cur) : ''}" placeholder="0 ~ ${fmtScore(full)}" />
        <button type="button" class="btn small" data-judge="score">
          ${icon('checkOutline', 'icon icon-sm')}<span>按此分计</span>
        </button>
      </div>` : ''}
    </div>
  `;
}

function renderChoiceOptions(options, userKeys, correctKeys, q, isMulti) {
  const pa = q._practiceAnswer;
  const submitted = !!pa;
  // 老数据（本次改动前作答的）只有 userAnswer 字符串，没有 userKeys 数组 → 兜底解析
  const pickedRaw = pa ? (pa.userKeys && pa.userKeys.length ? pa.userKeys : pa.userAnswer) : null;
  const picked = new Set(submitted ? selectedKeysOf(pickedRaw) : (userKeys || []));
  const cor = new Set(correctKeys || []);
  const selectedNow = selectedKeysOf(q._practiceSelected);
  return `
    <div class="practice-options${isMulti ? ' is-multi' : ''}">
      ${isMulti ? `
        <div class="multi-hint">
          ${icon('checkOutline', 'icon icon-sm')}
          <span>多项选择题：两个或以上正确答案，可点多个选项（再点一次取消）</span>
          <span class="multi-count" id="multi-count">已选 ${selectedNow.length} 项</span>
        </div>` : ''}
      ${options.map(o => {
        const cls = ['practice-option'];
        if (submitted) {
          cls.push('disabled');
          if (cor.has(o.key)) {
            cls.push('correct');
            if (isMulti && !picked.has(o.key)) cls.push('missed');   // 漏选的正确项
          } else if (picked.has(o.key)) {
            cls.push('wrong');
          }
        } else if (selectedNow.includes(o.key)) {
          cls.push('selected');
        }
        return `<button class="${cls.join(' ')}" data-key="${o.key}">
          <span class="letter">${o.key}</span>
          <span class="practice-option-text">${escapeHTML(o.text)}</span>
        </button>`;
      }).join('')}
    </div>
  `;
}

function renderTrueFalse(userAns, correctAns) {
  // 判断题：√ / ×
  // 正确答案可能是 "对"/"错"/"正确"/"错误"/"√"/"×"/"T"/"F"
  const normCorrect = /错|错误|×|f|false/i.test(correctAns || '') ? '×' : '√';
  return `
    <div class="practice-options">
      <button class="practice-option ${userAns === '√' ? (userAns === normCorrect ? 'correct' : 'wrong') : ''}${userAns ? ' disabled' : ''}" data-key="√">
        <span class="letter">√</span>
        <span>正确</span>
      </button>
      <button class="practice-option ${userAns === '×' ? (userAns === normCorrect ? 'correct' : 'wrong') : ''}${userAns ? ' disabled' : ''}" data-key="×">
        <span class="letter">×</span>
        <span>错误</span>
      </button>
    </div>
  `;
}

function renderEssayInput(userAns, correctAns) {
  return `
    <div style="margin-top:8px">
      <textarea id="essay-input" placeholder="在此输入你的答案…"
        style="width:100%;min-height:120px;padding:10px 12px;border:1px solid var(--border-2);border-radius:6px;font:inherit;background:var(--bg-2);color:var(--fg);resize:vertical"
      >${escapeHTML(userAns || '')}</textarea>
    </div>
  `;
}

// 题干里猜选项（兜底）
// 兼容：A./B./C./D. 或 A、B、C、D、 或 A:B 或 A：B（A的全角冒号）
// 还兼容（A  xxx）这种括号开头但不太规范
function guessOptionsFromStem(stem) {
  if (!stem) return [];
  // 把全角字母、数字空格也归一
  const normalized = String(stem)
    .replace(/[：]/g, ':')
    .replace(/[．]/g, '.')
    .replace(/[、]/g, ',');
  // 匹配 A.xxxx B.xxxx ...（用前瞻，避免吃掉下一选项）
  const re = /(^|[\s\n,])([A-Ha-h])\s*[.:,]\s*([^\n]+?)(?=(?:[\s\n,]?)[A-Ha-h][\s]*[.:,]|$)/g;
  const opts = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const key = m[2].toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    opts.push({ key, text: m[3].trim() });
    if (opts.length >= 8) break;  // 最多 8 个选项
  }
  return opts;
}

/* ============ 错题本 / 收藏 ============ */
function renderWrongBook() {
  const list = state.questions.filter(q => q.isWrong);
  $('#wrong-meta').textContent = `共 ${list.length} 道错题 · 答对后将自动从错题本移除`;
  $('#wrong-list').innerHTML = list.length
    ? list.map(q => questionCardHTML(q)).join('')
    : emptyHTML('还没有错题，做题时答错会自动加入', 'celebrate');
  bindQuestionCards($('#wrong-list'));
}
function renderFavorites() {
  const list = state.questions.filter(q => q.isFav);
  $('#fav-meta').textContent = `共 ${list.length} 道收藏题`;
  $('#fav-list').innerHTML = list.length
    ? list.map(q => questionCardHTML(q)).join('')
    : emptyHTML('点击题目标记为收藏', 'star');
  bindQuestionCards($('#fav-list'));
}
function clearWrong() {
  if (!confirm('确定清空错题本吗？')) return;
  state.questions.forEach(q => q.isWrong = false);
  saveState(); updateBadges();
  renderWrongBook(); renderLibrary(); renderStats();
  toast('已清空错题本');
}
function clearFav() {
  if (!confirm('确定清空收藏吗？')) return;
  state.questions.forEach(q => q.isFav = false);
  saveState(); updateBadges();
  renderFavorites(); renderLibrary();
  toast('已清空收藏');
}

/* ============ 统计 ============ */
function renderStats() {
  const total = state.questions.length;
  const practiced = state.questions.filter(q => q.attempts > 0);
  const totalAttempts = practiced.reduce((s, q) => s + q.attempts, 0);
  const totalCorrect = practiced.reduce((s, q) => s + q.correct, 0);
  const accuracy = totalAttempts ? Math.round(totalCorrect * 100 / totalAttempts) : 0;

  const today = new Date(); today.setHours(0,0,0,0);
  const todayAttempts = state.questions.reduce((s, q) =>
    s + (q.history || []).filter(h => h.at >= today.getTime()).length, 0);
  const wrongCount = state.questions.filter(q => q.isWrong).length;
  const favCount = state.questions.filter(q => q.isFav).length;

  // 主统计用 bento grid（大小对比：核心指标大卡 + 辅助指标小卡）
  $('#stats-grid').innerHTML = `
    <div class="bento-grid">
      <div class="bento-card feature purple span-2 row-2" data-go="wrong">
        <div>
          <div class="label">${icon('chart', 'icon icon-mauve')}<span>学习情况</span></div>
          <div class="value">${accuracy}<span style="font-size:20px;color:var(--fg-3)">%</span></div>
        </div>
        <div class="desc">总正确率 · 共 ${totalAttempts} 次作答</div>
      </div>
      <div class="bento-card feature olive" data-go="library">
        <div>
          <div class="label">${icon('note', 'icon icon-olive')}<span>题库</span></div>
          <div class="value">${total}</div>
        </div>
        <div class="desc">${state.books.length} 本教材 · ${state.chapters.length} 章</div>
      </div>
      <div class="bento-card feature sand" data-go="practice">
        <div>
          <div class="label">${icon('bolt', 'icon icon-sand')}<span>今日</span></div>
          <div class="value">${todayAttempts}</div>
        </div>
        <div class="desc">已刷题数</div>
      </div>
      <div class="bento-card feature rose" data-go="wrong">
        <div>
          <div class="label">${icon('x', 'icon icon-rose')}<span>错题</span></div>
          <div class="value">${wrongCount}</div>
        </div>
        <div class="desc">${total ? Math.round(100 * wrongCount / total) + '% 错误率' : '尚未作答'}</div>
      </div>
      <div class="bento-card feature slate" data-go="fav">
        <div>
          <div class="label">${icon('star', 'icon icon-slate')}<span>收藏</span></div>
          <div class="value">${favCount}</div>
        </div>
        <div class="desc">${favCount ? '常回顾' : '尚无收藏'}</div>
      </div>
    </div>
  `;
  // 给所有可点击的 bento 卡绑跳转
  $('#stats-grid').querySelectorAll('[data-go]').forEach(card => {
    card.addEventListener('click', () => {
      const tabBtn = $$('.tab').find(b => b.dataset.tab === card.dataset.go);
      if (tabBtn) tabBtn.click();
    });
  });

  const chapters = state.chapters.map(c => {
    const qs = questionsOfChapter(c.id).filter(q => q.attempts > 0);
    const att = qs.reduce((s, q) => s + q.attempts, 0);
    const cor = qs.reduce((s, q) => s + q.correct, 0);
    return { name: c.name, att, cor, pct: att ? Math.round(cor * 100 / att) : 0 };
  }).filter(c => c.att > 0).sort((a, b) => a.pct - b.pct);

  $('#chart-chapter').innerHTML = chapters.length
    ? chapters.map(c => {
        const cls = c.pct < 50 ? 'low' : c.pct < 75 ? 'mid' : 'high';
        return `<div class="bar-row">
          <span class="name" title="${escapeHTML(c.name)}">${escapeHTML(c.name)}</span>
          <span class="bar ${cls}"><div style="width:${c.pct}%"></div></span>
          <span class="pct">${c.pct}% (${c.cor}/${c.att})</span>
        </div>`;
      }).join('')
    : '<p class="muted">做些题后再来看章节掌握度</p>';

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - i);
    const start = d.getTime();
    const end = start + 86400000;
    const count = state.questions.reduce((s, q) =>
      s + (q.history || []).filter(h => h.at >= start && h.at < end).length, 0);
    days.push({ label: ['日','一','二','三','四','五','六'][d.getDay()], count });
  }
  const maxCount = Math.max(1, ...days.map(d => d.count));
  $('#chart-trend').innerHTML = `
    <div class="trend-chart">
      ${days.map(d => `<div class="trend-day">
        <div class="count">${d.count}</div>
        <div class="col" style="height:${(d.count / maxCount) * 100}%"></div>
        <div class="label">${d.label}</div>
      </div>`).join('')}
    </div>
  `;
}

/* ============ 模态框 ============ */
function openModal(id) { $('#' + id).hidden = false; }
function closeModal(id) { $('#' + id).hidden = true; }

/* ============ 导入 / 导出 ============ */
function exportData() {
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `tiku-backup-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('已导出');
}
function importData(file) {
  if (!file) return;
  if (!confirm('导入会覆盖当前题库，确定继续吗？')) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!s || typeof s !== 'object' || !Array.isArray(s.questions)) throw new Error('数据格式不正确');
      state = { ...defaultState(), ...s, version: APP_VERSION };
      saveState();
      renderSidebar(); renderLibrary(); renderWrongBook(); renderFavorites(); renderStats(); updateBadges();
      toast('已导入');
    } catch (e) {
      toast('导入失败：' + e.message, 'danger');
    }
  };
  reader.readAsText(file);
}

/* ============ GitHub Gist 云同步 ============ */
const SYNC_KEY = 'qb-sync-config';
let syncConfig = {};
try { syncConfig = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}'); } catch { syncConfig = {}; }
function saveSyncConfig() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(syncConfig)); } catch {}
}

// ===== Gist API（fetch 直连，无需后端）=====
async function gistTest(token) {
  if (!token) throw new Error('请填 GitHub Token');
  const r = await fetch('https://api.github.com/gists?per_page=1', {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  if (r.status === 401) throw new Error('Token 无效或权限不足（需要勾选 Gists 读写）');
  if (r.status === 403) throw new Error('GitHub 限流，稍后重试');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return true;
}

async function gistCreate(token, content, description) {
  const r = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description,
      public: false,
      files: { 'qb-library-sync.json': { content } },
    })
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error('创建失败：' + text.slice(0, 200));
  }
  const j = await r.json();
  return j.id;
}

/** 文本是否是「完整可解析」的 JSON —— 用来判断云端内容有没有被截断 */
function isCompleteJSON(text) {
  if (typeof text !== 'string' || !text.length) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

/** 走 raw_url 取完整内容（gist 的 raw 地址带 commit sha，不会命中旧缓存） */
async function gistFetchRawByUrl(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

/** 走 API 的 raw 媒体类型取完整内容（带 Token，一定不会被 CORS 拦） */
async function gistFetchRawByApi(token, gistId) {
  const r = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.raw' }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

/**
 * 取云端内容。
 *
 * ⚠️ GitHub Gist API 对**单个文件只返回前 1MB**，并在文件对象里置 `truncated: true`。
 *    题库超过 1MB 时，如果直接用 files[...].content，拿到的是被砍掉一半的 JSON，
 *    解析就会报 “Unterminated string in JSON at position N”（N 约等于 1MB 处的字符位置）。
 *    所以这里必须判断 truncated，改从 raw_url / API raw 取完整内容。
 */
async function gistGet(token, gistId) {
  const r = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const file = j.files && j.files['qb-library-sync.json'];
  if (!file) return null;

  // 快路径：没被截断，直接可用
  if (!file.truncated && file.content != null) return file.content;

  // 慢路径：被截断，换完整来源
  const errs = [];
  if (file.raw_url) {
    try {
      const t = await gistFetchRawByUrl(file.raw_url);
      if (isCompleteJSON(t)) return t;
      errs.push(`raw 地址内容不完整（${t.length} 字符）`);
    } catch (e) { errs.push('raw 地址：' + e.message); }
  }
  try {
    const t = await gistFetchRawByApi(token, gistId);
    if (isCompleteJSON(t)) return t;
    errs.push(`API 原始内容不完整（${t.length} 字符）`);
  } catch (e) { errs.push('API 原始内容：' + e.message); }

  if (file.content != null && isCompleteJSON(file.content)) return file.content;

  const mb = file.size ? (file.size / 1048576).toFixed(2) + 'MB' : '未知大小';
  throw new Error(
    `云端文件 ${mb} 超过 GitHub 接口单文件 1MB 的返回上限，完整内容取回失败（${errs.join('；')}）。` +
    `可在「同步设置」里查看体积明细，必要时清理教材原文后再试。`
  );
}

async function gistUpdate(token, gistId, content) {
  const r = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: { 'qb-library-sync.json': { content } },
    })
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error('上传失败：' + text.slice(0, 200));
  }
}

// ===== Payload 构建 + 应用 =====
const GIST_FILE_LIMIT = 1048576;   // GitHub Gist 接口单文件只返回前 1MB

function buildSyncPayload() {
  return {
    _meta: {
      v: APP_VERSION,
      device: syncConfig.device || 'unknown',
      lastModified: Date.now(),
    },
    state: { ...state, _meta: undefined },
  };
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < GIST_FILE_LIMIT) return (n / 1024).toFixed(1) + ' KB';
  return (n / GIST_FILE_LIMIT).toFixed(2) + ' MB';
}

/** 同步体积统计（含各部分拆解），用来解释「为什么会被截断」 */
function syncPayloadStats(content) {
  let text = content;
  if (text == null) {
    try { text = JSON.stringify(buildSyncPayload()); } catch { text = ''; }
  }
  const enc = new TextEncoder();
  const bytes = text ? enc.encode(text).length : 0;
  let sourceBytes = 0;
  (state.books || []).forEach(b => {
    if (b && b.sourceText) sourceBytes += enc.encode(String(b.sourceText)).length;
  });
  return {
    bytes,
    sourceBytes,
    books: (state.books || []).length,
    questions: (state.questions || []).length,
    over: bytes > GIST_FILE_LIMIT,
    near: bytes > GIST_FILE_LIMIT * 0.85,
  };
}

/** 同步面板里的体积明细 */
function renderSyncSize(force) {
  const el = $('#sync-size-hint');
  if (!el) return;
  // 只在同步面板打开时计算（要序列化整个题库，就别在后台白跑）
  const modal = $('#modal-sync');
  if (!force && (!modal || modal.hidden)) return;
  const s = syncPayloadStats();
  const pct = Math.max(2, Math.min(100, Math.round(s.bytes / GIST_FILE_LIMIT * 100)));
  el.className = 'sync-size' + (s.over ? ' danger' : (s.near ? ' warn' : ''));
  el.hidden = false;

  const breakdown =
    `${s.books} 本教材 / ${s.questions} 道题` +
    (s.sourceBytes ? `，其中教材原文占 ${formatBytes(s.sourceBytes)}` : '');

  let note;
  if (s.over) {
    note = `⚠️ 已超过 GitHub 接口单文件 1MB 的返回上限。上传不受影响，拉取时已自动改走完整地址下载；` +
           `若体积超过约 10MB（GitHub 完整下载的上限）就需要清理教材原文了。`;
  } else if (s.near) {
    note = `接近 GitHub 接口单文件 1MB 的返回上限，超过后拉取会自动改走完整地址下载（已自动处理）。`;
  } else {
    note = `距离 GitHub 接口单文件 1MB 的返回上限还有 ${formatBytes(GIST_FILE_LIMIT - s.bytes)}。`;
  }

  el.innerHTML = `
    <div class="sync-size-head">
      <span>同步体积 <strong>${formatBytes(s.bytes)}</strong></span>
      <span class="sync-size-breakdown">${breakdown}</span>
    </div>
    <div class="sync-size-bar"><i style="width:${pct}%"></i></div>
    <div class="sync-size-note">${note}</div>
  `;
}

function applySyncPayload(payload) {
  if (!payload || !payload.state || typeof payload.state !== 'object') {
    throw new Error('同步数据格式不正确');
  }
  state = { ...defaultState(), ...payload.state, version: APP_VERSION };
  state._meta = payload._meta || { lastModified: Date.now() };
  saveState();
}

// ===== 状态显示 =====
function updateSyncStatus(level, msg) {
  const box = $('#sync-status-box');
  if (!box) return;
  box.hidden = false;
  box.className = 'sync-status level-' + level;
  const m = box.querySelector('.sync-msg');
  if (m) m.textContent = msg;
  renderSyncIndicator();
}

function renderSyncIndicator() {
  const el = $('#sync-indicator');
  if (!el) return;
  if (!syncConfig.token) { el.hidden = true; return; }
  el.hidden = false;
  if (!syncConfig.lastSync) {
    el.innerHTML = '<span class="sync-dot"></span>未同步';
    el.title = syncConfig.gist ? `Gist ${syncConfig.gist.slice(0,8)}…` : '点击同步设置';
    el.className = 'sync-indicator level-idle';
    return;
  }
  const minutes = Math.round((Date.now() - syncConfig.lastSync) / 60000);
  const label = minutes < 1 ? '刚刚同步' : (minutes < 60 ? `${minutes} 分钟前同步` : `${Math.round(minutes/60)} 小时前同步`);
  el.innerHTML = '<span class="sync-dot"></span>' + label;
  el.title = `Gist ${syncConfig.gist ? syncConfig.gist.slice(0,8) + '…' : ''}\n最后同步：${new Date(syncConfig.lastSync).toLocaleString()}`;
  el.className = 'sync-indicator level-ok';
}

// ===== 拉取 / 上传 =====
async function syncPull(force) {
  if (!syncConfig.token || !syncConfig.gist) {
    toast('请先在「同步设置」里配置 Token + Gist ID', 'warn');
    return false;
  }
  updateSyncStatus('syncing', '正在从云端拉取…');
  try {
    const text = await gistGet(syncConfig.token, syncConfig.gist);
    if (!text) {
      updateSyncStatus('idle', '云端无数据');
      return false;
    }
    let remote;
    try {
      remote = JSON.parse(text);
    } catch (err) {
      // 正常情况不会走到这里（gistGet 已处理 1MB 截断），留作兜底
      const kb = (new TextEncoder().encode(text).length / 1024).toFixed(0);
      throw new Error(
        `云端数据不完整（收到 ${kb}KB）：${err.message}。` +
        `请先在「设置 → 导出题库」备份本机数据，再点「立即上传」覆盖云端后重试。`
      );
    }
    const remoteTs = (remote._meta && remote._meta.lastModified) || 0;
    const localTs = (state._meta && state._meta.lastModified) || 0;

    if (!force && remoteTs <= localTs) {
      updateSyncStatus('ok', '已是最新（云端 ' + new Date(remoteTs).toLocaleString() + '）');
      syncConfig.lastSync = Date.now();
      saveSyncConfig();
      return true;
    }

    const remoteQ = (remote.state && remote.state.questions || []).length;
    if (state.questions.length && remoteQ && !force) {
      const ok = confirm(`云端有 ${remoteQ} 道题（${new Date(remoteTs).toLocaleString()}），当前本地有 ${state.questions.length} 道题。\n\n确定用云端覆盖本地吗？`);
      if (!ok) { updateSyncStatus('idle', '已取消'); return false; }
    }

    applySyncPayload(remote);
    renderSidebar(); renderLibrary(); renderWrongBook(); renderFavorites(); renderStats(); updateBadges();
    syncConfig.lastSync = Date.now();
    saveSyncConfig();
    renderSyncSize();
    updateSyncStatus('ok', `已拉取 · ${remoteQ} 题`);
    toast('已从云端拉取');
    return true;
  } catch (e) {
    updateSyncStatus('error', '拉取失败：' + e.message);
    toast('拉取失败：' + e.message, 'danger');
    return false;
  }
}

// 记录上一次成功上传的 state 指纹，避免无改动的重复上传（体积大时尤其划算）
let _lastPushedState = null;

async function syncPush({ silent = false } = {}) {
  if (!syncConfig.token) {
    if (!silent) toast('请先在「同步设置」里配置 GitHub Token', 'warn');
    return false;
  }
  try {
    const payload = buildSyncPayload();
    const content = JSON.stringify(payload);
    const stateStr = JSON.stringify(payload.state);
    const stats = syncPayloadStats(content);

    // 没有实际改动就不重复上传（但首次建 Gist 一定要传）
    if (syncConfig.gist && stateStr === _lastPushedState) {
      updateSyncStatus('ok', `无改动，跳过上传 · ${formatBytes(stats.bytes)}`);
      return true;
    }

    updateSyncStatus('syncing', stats.over
      ? `正在上传 ${formatBytes(stats.bytes)}（超过 GitHub 1MB 接口上限，拉取会自动走完整地址）…`
      : `正在上传到云端 ${formatBytes(stats.bytes)}…`);

    if (!syncConfig.gist) {
      const id = await gistCreate(syncConfig.token, content, 'qb-library-sync（题库同步）');
      syncConfig.gist = id;
      saveSyncConfig();
      const gistEl = $('#sync-gist');
      if (gistEl) gistEl.value = id;
    } else {
      await gistUpdate(syncConfig.token, syncConfig.gist, content);
    }
    _lastPushedState = stateStr;
    state._meta = payload._meta;
    saveState();
    syncConfig.lastSync = Date.now();
    saveSyncConfig();
    updateSyncStatus('ok', `已上传 · ${state.questions.length} 题 · ${formatBytes(stats.bytes)}`);
    renderSyncSize();
    if (!silent) toast(syncConfig.gist ? '已上传到云端' : '已创建 Gist');
    return true;
  } catch (e) {
    updateSyncStatus('error', '上传失败：' + e.message);
    if (!silent) toast('上传失败：' + e.message, 'danger');
    return false;
  }
}

// ===== 自动同步（debounced） =====
let _syncDebounce = null;
function scheduleSync() {
  if (!syncConfig.auto || !syncConfig.token) return;
  clearTimeout(_syncDebounce);
  _syncDebounce = setTimeout(() => syncPush({ silent: true }), 5000);
}

// ===== 同步 modal =====
function openSyncModal() {
  $('#sync-token').value = syncConfig.token || '';
  $('#sync-gist').value = syncConfig.gist || '';
  $('#sync-device').value = syncConfig.device || (navigator.platform + ' · ' + (navigator.userAgent.match(/\b(Chrome|Edg|Firefox|Safari)\b/) || ['浏览器'])[0]);
  $('#sync-auto').checked = !!syncConfig.auto;
  openModal('modal-sync');
  renderSyncSize(true);
  if (syncConfig.lastSync) {
    updateSyncStatus('ok', '上次同步：' + new Date(syncConfig.lastSync).toLocaleString());
  } else {
    updateSyncStatus('idle', '尚未同步');
  }
}

function saveSyncForm() {
  syncConfig.token = ($('#sync-token').value || '').trim();
  syncConfig.gist  = ($('#sync-gist').value  || '').trim();
  syncConfig.device = ($('#sync-device').value || '').trim();
  syncConfig.auto  = $('#sync-auto').checked;
  saveSyncConfig();
}

function initSync() {
  $('#btn-sync-create').addEventListener('click', async () => {
    saveSyncForm();
    if (!syncConfig.token) return toast('请先填 GitHub Token', 'warn');
    updateSyncStatus('syncing', '正在创建 Gist…');
    try {
      const content = JSON.stringify(buildSyncPayload());
      const id = await gistCreate(syncConfig.token, content, 'qb-library-sync（题库同步）');
      syncConfig.gist = id;
      saveSyncConfig();
      $('#sync-gist').value = id;
      updateSyncStatus('ok', 'Gist 已创建');
      toast('已创建 Gist：' + id);
      renderSyncIndicator();
    } catch (e) {
      updateSyncStatus('error', e.message);
      toast('创建失败：' + e.message, 'danger');
    }
  });

  $('#btn-sync-test').addEventListener('click', async () => {
    saveSyncForm();
    if (!syncConfig.token) return toast('请先填 GitHub Token', 'warn');
    updateSyncStatus('syncing', '正在测试连接…');
    try {
      await gistTest(syncConfig.token);
      updateSyncStatus('ok', '✓ Token 有效');
      toast('Token 有效，连接成功');
    } catch (e) {
      updateSyncStatus('error', e.message);
      toast('测试失败：' + e.message, 'danger');
    }
  });

  $('#btn-sync-push').addEventListener('click', () => { saveSyncForm(); syncPush(); });
  $('#btn-sync-pull').addEventListener('click', () => { saveSyncForm(); syncPull(true); });

  // 「同步设置」入口已统一由 popover handler 处理（见 line ~2848 的 sync 分支）
  // 这里不再单独绑 listener，否则会调用 e.stopPropagation() 阻止冒泡，导致 popover 收不到点击

  // 顶部状态条点击也打开 modal
  const indicator = $('#sync-indicator');
  if (indicator) {
    indicator.addEventListener('click', openSyncModal);
  }

  // 启动时自动拉取
  if (syncConfig.auto && syncConfig.token && syncConfig.gist) {
    setTimeout(() => syncPull(), 2000);
  }

  renderSyncIndicator();
  setInterval(renderSyncIndicator, 60000);
}

/* ============ 初始化 ============ */
function init() {
  initTabs();

  const rangeSel = $('#practice-range');
  const chapPick = $('#practice-chapter-pick');
  function refreshChapPick() {
    if (!chapPick) return;
    chapPick.hidden = rangeSel.value !== 'chapter';
    let html = '';
    state.books.forEach(b => {
      const chs = chaptersOfBook(b.id);
      if (!chs.length) return;
      html += `<optgroup label="${icon('book', 'icon icon-sm icon-mauve')} ${escapeHTML(b.name)}">`;
      chs.forEach(c => { html += `<option value="${c.id}">${escapeHTML(c.name)}</option>`; });
      html += `</optgroup>`;
    });
    chapPick.innerHTML = html || '<option>(暂无章节)</option>';
  }
  rangeSel.addEventListener('change', refreshChapPick);
  refreshChapPick();
  // 练习栏筛选：题型 / 题况（下拉里直接带数量）
  refreshPracticeFilters();

  $('#file-pdf').addEventListener('change', e => handlePDFUpload(e.target.files[0]));
  $('#file-import').addEventListener('change', e => importData(e.target.files[0]));

  $('#btn-new-chapter').addEventListener('click', addNewChapter);
  $('#btn-add-question').addEventListener('click', () => openQuestionModal());
  $('#btn-delete-chapter').addEventListener('click', deleteChapter);
  $('#btn-delete-book').addEventListener('click', deleteBook);
  $('#btn-rename-chapter').addEventListener('click', () => {
    if (currentChapterId) openRenameChapterModal(currentChapterId);
    else if (currentBookId) openRenameBookModal(currentBookId);
  });
  $('#btn-save-question').addEventListener('click', saveQuestionFromModal);

  // 双击 #lib-title 触发重命名
  $('#lib-title').addEventListener('dblclick', () => {
    if (currentChapterId) openRenameChapterModal(currentChapterId);
    else if (currentBookId) openRenameBookModal(currentBookId);
  });

  // ============ 注入 SVG 图标到各占位元素 ============
  function _fill(id, html) { const el = $('#' + id); if (el) el.innerHTML = html; }
  _fill('brand-logo', icon('book', 'icon-lg icon-mauve'));
  _fill('btn-settings', icon('settings', 'icon icon-muted') + '<span style="margin-left:6px">设置</span>');
  _fill('btn-clear-all', icon('trash', 'icon icon-danger') + '<span style="margin-left:6px">清空题库</span>');
  // 设置下拉里各 item 的图标
  function _ic(selector, name, cls) {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = icon(name, cls || 'icon-mauve');
  }
  _ic('.ic-export', 'download');
  _ic('.ic-import', 'upload', 'icon-olive');
  _ic('.ic-sync', 'sync', 'icon-info');
  _ic('.ic-guide', 'bookOpen');
  _ic('.ic-shortcuts', 'keyboard', 'icon-slate');
  _ic('.ic-about', 'info', 'icon-muted');
  _fill('btn-new-chapter', icon('plus', 'icon icon-mauve') + '<span style="margin-left:4px">章节</span>');
  // 上传 label 里必须保留 <input type="file">，否则 label 点击不会触发文件选择
  // 这里先把 input 取出来暂存，再覆盖 innerHTML 写入图标，最后再把 input 塞回去
  const uploadLabel = $('#btn-upload-label');
  if (uploadLabel) {
    const fileInput = uploadLabel.querySelector('input[type="file"]');
    uploadLabel.innerHTML = icon('upload', 'icon') + '<span style="margin-left:6px">上传文件</span>';
    if (fileInput) uploadLabel.appendChild(fileInput);
  }
  _fill('btn-add-question', icon('plus', 'icon icon-mauve') + '<span style="margin-left:6px">手动录入</span>');
  _fill('btn-rename-chapter', icon('edit', 'icon icon-muted') + '<span style="margin-left:6px">重命名</span>');
  _fill('btn-delete-chapter', icon('trash', 'icon icon-danger') + '<span style="margin-left:6px">删除本章</span>');
  _fill('btn-delete-book', icon('trash', 'icon icon-danger') + '<span style="margin-left:6px">删除整本</span>');
  _fill('btn-start-practice', icon('target', 'icon') + '<span style="margin-left:6px">开始练习</span>');
  _fill('btn-practice-wrong', icon('refresh', 'icon') + '<span style="margin-left:6px">重做错题</span>');
  _fill('btn-clear-wrong', icon('trash', 'icon icon-danger') + '<span style="margin-left:6px">清空错题本</span>');
  _fill('btn-practice-fav', icon('target', 'icon') + '<span style="margin-left:6px">练习收藏题</span>');
  _fill('btn-clear-fav', icon('starOutline', 'icon icon-muted') + '<span style="margin-left:6px">清空收藏</span>');
  _fill('btn-save-question', icon('check', 'icon') + '<span style="margin-left:6px">保存</span>');
  _fill('btn-rename-confirm', icon('check', 'icon') + '<span style="margin-left:6px">保存</span>');
  _fill('btn-clear-confirm', icon('trash', 'icon') + '<span style="margin-left:6px">清空</span>');
  _fill('lib-search-icon', icon('search', 'icon icon-muted'));
  _fill('modal-clear-title', icon('warn', 'icon icon-warn') + '<span style="margin-left:6px">清空题库</span>');
  _fill('modal-rename-title', icon('edit', 'icon icon-mauve') + '<span style="margin-left:6px">重命名</span>');
  _fill('modal-parse-title', icon('book', 'icon icon-mauve') + '<span style="margin-left:6px">解析预览</span>');
  _fill('modal-ocr-title', icon('camera', 'icon icon-mauve') + '<span style="margin-left:6px">扫描件识别中（OCR）</span>');
  // 给模态框的关闭按钮、取消按钮加图标
  $$('[data-close]').forEach(b => {
    if (!b.querySelector('.icon')) b.innerHTML = b.tagName === 'BUTTON' && b.classList.contains('btn')
      ? (icon('close', 'icon icon-muted') + '<span style="margin-left:4px">' + (b.textContent || '取消').trim() + '</span>')
      : icon('close', 'icon icon-muted');
  });
  // tabs 加上图标
  _fill('tab-library-text', icon('folder', 'icon') + '<span style="margin-left:6px">题库</span>');
  _fill('tab-practice-text', icon('target', 'icon') + '<span style="margin-left:6px">练习</span>');
  _fill('tab-stats-text', icon('chart', 'icon') + '<span style="margin-left:6px">统计</span>');
  // sidebar 标题
  $('#sidebar-title').innerHTML = icon('folder', 'icon icon-mauve') + '<span style="margin-left:6px">教材 / 章节</span>';
  // 错误/收藏页标题
  $('#wrong-title').innerHTML = icon('x', 'icon icon-danger') + '<span style="margin-left:6px">错题本</span>';
  $('#fav-title').innerHTML = icon('star', 'icon icon-warn') + '<span style="margin-left:6px">收藏</span>';
  // 统计标题 + 章节标题 + 趋势标题
  $('#stats-title').innerHTML = icon('chart', 'icon icon-mauve') + '<span style="margin-left:6px">学习情况</span>';
  $('#stats-chapter-title').innerHTML = icon('note', 'icon icon-mauve') + '<span style="margin-left:6px">章节掌握度（正确率）</span>';
  $('#stats-trend-title').innerHTML = icon('trend', 'icon icon-olive') + '<span style="margin-left:6px">最近 7 天刷题量</span>';

  $('#lib-search').addEventListener('input', e => { libSearchQuery = e.target.value; renderLibrary(); });
  $('#lib-search').addEventListener('keydown', e => {
    if (e.key === 'Enter' && libSearchQuery && state.questions.length) {
      const t = libSearchQuery.toLowerCase();
      const ids = state.questions
        .filter(q =>
          (q.stem || '').toLowerCase().includes(t) ||
          (q.answer || '').toLowerCase().includes(t) ||
          (q.explanation || '').toLowerCase().includes(t))
        .map(q => q.id);
      if (ids.length) {
        $$('.tab').find(b => b.dataset.tab === 'practice').click();
        state.practice = { active: true, set: ids, idx: 0, mode: 'sequential', range: 'all', _answers: [] };
        saveState();
        renderPracticeCard();
      } else {
        toast('没有匹配的题', 'danger');
      }
    }
  });

  // 题库筛选 chip
  const filterBar = $('#lib-filter-bar');
  if (filterBar) {
    filterBar.addEventListener('click', e => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      filterBar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      window._libFilterMode = chip.dataset.filter;
      renderLibrary();
    });
  }

  $('#btn-start-practice').addEventListener('click', () => startPractice());
  // 「重做错题 / 练习收藏题」是错题本 / 收藏页上的快捷入口 → 顺手复位题型/题况筛选，
  //   并且组卷成功后**切到练习页**，否则练习卡片渲染在隐藏视图里，用户看着就是「点了没反应」。
  function quickPractice(range) {
    $('#practice-range').value = range;
    const qt = $('#practice-qtype'), fl = $('#practice-flag');
    if (qt) qt.value = 'all';
    if (fl) fl.value = 'all';
    if (startPractice() !== false) switchTab('practice');
  }
  $('#btn-practice-wrong').addEventListener('click', () => quickPractice('wrong'));
  $('#btn-practice-fav').addEventListener('click', () => quickPractice('fav'));
  $('#btn-clear-wrong').addEventListener('click', clearWrong);
  $('#btn-clear-fav').addEventListener('click', clearFav);

  $$('[data-close]').forEach(b => b.addEventListener('click', e => {
    const m = e.target.closest('.modal');
    if (m) m.hidden = true;
  }));
  $$('.modal').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m) m.hidden = true;
    });
  });
  $('#btn-confirm-parse').addEventListener('click', confirmParseImport);

  // ============ 设置下拉（popover） ============
  const settingsBtn = $('#btn-settings');
  const settingsPopover = $('#settings-popover');
  function toggleSettings(force) {
    const willOpen = force === undefined ? settingsPopover.hidden : !!force;
    settingsPopover.hidden = !willOpen;
    settingsBtn?.classList.toggle('active', willOpen);
  }
  if (settingsBtn) {
    settingsBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleSettings();
    });
    // 点击外部或按 Esc 自动关闭
    document.addEventListener('click', e => {
      if (!settingsPopover.hidden && !e.target.closest('#settings-popover') && !e.target.closest('#btn-settings')) {
        toggleSettings(false);
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !settingsPopover.hidden) toggleSettings(false);
    });
  }
  // popover 内部 5 个动作
  settingsPopover?.addEventListener('click', e => {
    const item = e.target.closest('.popover-item');
    if (!item) return;
    const action = item.dataset.action;
    if (action === 'export') { exportData(); }
    else if (action === 'import') { /* label 形式，无 action；input change 已绑定 */ $('#file-import').click(); }
    else if (action === 'sync') { openSyncModal(); }   // 兜底：之前漏了 sync 分支，导致点击无反应
    else if (action === 'guide') { openHelpModal('guide'); }
    else if (action === 'shortcuts') { openHelpModal('shortcuts'); }
    else if (action === 'about') { openHelpModal('about'); }
    toggleSettings(false);
  });

  // OCR 取消/关闭按钮
  const cancelOcrBtn = document.getElementById('btn-ocr-cancel');
  if (cancelOcrBtn) cancelOcrBtn.addEventListener('click', () => {
    ocrCancelled = true;
  });
  const closeOcrBtn = document.getElementById('btn-ocr-close');
  if (closeOcrBtn) closeOcrBtn.addEventListener('click', () => {
    closeModal('modal-ocr');
  });

  // 清空题库
  const clearInput = document.getElementById('clear-confirm-input');
  const clearBtn = document.getElementById('btn-clear-confirm');
  const btnClearAll = document.getElementById('btn-clear-all');
  if (btnClearAll) btnClearAll.addEventListener('click', () => {
    // 摘要提示
    const total = state.questions.length;
    const bkCount = state.books.length;
    const chapCount = state.chapters.length;
    $('#clear-summary').textContent = `将删除 ${bkCount} 本教材、${chapCount} 章、${total} 道题，以及所有练习记录与笔记。`;
    $('#clear-confirm-input').value = '';
    if (clearBtn) clearBtn.disabled = true;
    openModal('modal-clear');
    setTimeout(() => clearInput?.focus(), 50);
  });
  if (clearInput && clearBtn) {
    clearInput.addEventListener('input', () => {
      clearBtn.disabled = clearInput.value.trim() !== '确认清空';
    });
    clearInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !clearBtn.disabled) clearAllLibrary();
    });
    clearBtn.addEventListener('click', clearAllLibrary);
  }

  // 重命名模态框
  const renameInput = document.getElementById('rename-input');
  const renameBtn = document.getElementById('btn-rename-confirm');
  if (renameInput && renameBtn) {
    renameBtn.addEventListener('click', confirmRename);
    renameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') confirmRename();
    });
  }

  renderSidebar(); renderLibrary(); renderWrongBook(); renderFavorites(); renderStats(); updateBadges();

  initSync();   // 初始化云同步
  bindPickerModal();  // 「从教材划取」modal 事件绑定（只绑一次）

  // #demo 模式下切到练习页展示答错反馈
  if (location.hash === '#demo' && state.practice.active && state.practice._answers) {
    const practiceTab = $$('.tab').find(b => b.dataset.tab === 'practice');
    if (practiceTab) {
      $$('.tab').forEach(b => b.classList.toggle('active', b === practiceTab));
      $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'practice'));
      renderPracticeCard();
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// 调试用：URL 包含 #demo 时注入演示数据，#clear 时清空
if ((location.hash === '#demo' || location.hash === '#demo-stats' || location.hash === '#demo-modal' || location.hash === '#demo-library' || location.hash === '#demo-settings' || location.hash === '#demo-help' || location.hash === '#demo-sync') && !state.books.length) {
  injectDemoData(location.hash);
} else if (location.hash === '#clear') {
  localStorage.removeItem(STORAGE_KEY);
  location.replace(location.pathname);
}

function injectDemoData(mode = '#demo') {
  const now = Date.now();
  const mkBook = (name, order, off = 0) => ({
    id: uid(), name, createdAt: now - off * 86400000, order
  });
  const mkChap = (bookId, name, off = 0) => ({
    id: uid(), bookId, name, createdAt: now - off * 3600000
  });
  const mkQ = (chapterId, stem, options, answer, explanation, off = 0) => ({
    id: uid(), chapterId, stem, options, answer, explanation,
    note: '', isWrong: false, isFav: false,
    attempts: 0, correct: 0, lastAt: null, history: [],
    createdAt: now - off * 60000,
  });
  const b1 = mkBook('2026 轻一 · 中级会计实务', 0);
  const b2 = mkBook('2026 轻一 · 经济法', 1, 30);
  const b3 = mkBook('2026 轻一 · 财务管理', 2, 60);
  state.books.push(b1, b2, b3);
  const c1 = mkChap(b1.id, '第一章 总论', 10);
  const c2 = mkChap(b1.id, '第二章 存货', 9);
  const c3 = mkChap(b1.id, '第三章 固定资产', 8);
  const c4 = mkChap(b2.id, '第一章 总论', 7);
  state.chapters.push(c1, c2, c3, c4);
  state.questions.push(
    mkQ(c1.id, '会计基本假设不包括下列哪一项？',
      [{key:'A',text:'会计主体'},{key:'B',text:'持续经营'},{key:'C',text:'会计分期'},{key:'D',text:'重要性'}],
      'D', '会计基本假设包括：会计主体、持续经营、会计分期、货币计量。重要性属于会计信息质量要求。', 5),
    mkQ(c1.id, '下列各项中，属于流动资产的是？',
      [{key:'A',text:'长期股权投资'},{key:'B',text:'固定资产'},{key:'C',text:'应收账款'},{key:'D',text:'无形资产'}],
      'C', '流动资产是指企业可以在一年或者超过一年的一个营业周期内变现或者运用的资产。', 4),
    mkQ(c2.id, '存货的初始计量应采用？',
      [{key:'A',text:'公允价值'},{key:'B',text:'历史成本'},{key:'C',text:'可变现净值'},{key:'D',text:'重置成本'}],
      'B', '存货应当按照成本进行初始计量。', 3),
    mkQ(c3.id, '固定资产折旧方法不包括？',
      [{key:'A',text:'年限平均法'},{key:'B',text:'工作量法'},{key:'C',text:'双倍余额递减法'},{key:'D',text:'直线摊销法'}],
      'D', '直线摊销法是无形资产的摊销方法。', 2),
    mkQ(c4.id, '经济法的调整对象不包括？',
      [{key:'A',text:'市场规制关系'},{key:'B',text:'宏观调控关系'},{key:'C',text:'平等主体之间的财产关系'},{key:'D',text:'社会分配关系'}],
      'C', '平等主体之间的财产关系由民商法调整，不属于经济法范畴。', 1),
  );
  // 给第1题设置答错状态以便展示
  state.questions[0].isWrong = true;
  saveState();
  // 默认展开第一本教材
  currentBookId = b1.id;
  currentChapterId = null;
  // 开始练习并模拟第一题答错，用于展示反馈样式
  state.practice.active = true;
  state.practice.set = state.questions.slice(0, 5).map(q => q.id);
  state.practice.idx = 0;
  state.practice.mode = 'sequential';
  state.practice.range = 'all';
  state.practice.chapterId = null;
  state.practice._answers = [{ qid: state.questions[0].id, isCorrect: false }];
  const q = state.questions[0];
  q._practiceAnswer = { userAnswer: 'A', isCorrect: false, at: Date.now() };
  q._practiceSelected = 'A';
  q.attempts = 1; q.correct = 0; q.lastAt = Date.now();
  q.history = [{ at: Date.now(), userAnswer: 'A', isCorrect: false }];
  q.isWrong = true;
  saveState();
  renderSidebar(); renderLibrary(); updateBadges();

  if (mode === '#demo-library') {
    // 切到题库页展示 bento strip + 教材折叠
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'library'));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'library'));
    renderSidebar();
    renderLibrary();
  } else if (mode === '#demo-stats') {
    // 切到统计页展示 bento grid
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'stats'));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'stats'));
    renderStats();
  } else if (mode === '#demo-modal') {
    // 打开录入弹窗展示 glassmorphism
    openQuestionModal();
  } else if (mode === '#demo-settings') {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'library'));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'library'));
    renderSidebar();
    renderLibrary();
    setTimeout(() => { $('#settings-popover').hidden = false; $('#btn-settings')?.classList.add('active'); }, 100);
  } else if (mode === '#demo-help') {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'library'));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'library'));
    renderSidebar();
    renderLibrary();
    setTimeout(() => openHelpModal('guide'), 100);
  } else if (mode === '#demo-sync') {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'library'));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'library'));
    renderSidebar();
    renderLibrary();
    setTimeout(() => openSyncModal(), 100);
  } else {
    // 默认切到练习页展示答错反馈
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'practice'));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === 'practice'));
    startPractice();
  }
  toast('已注入演示数据 · 试试拖动教材 / 右滑删除');
}
