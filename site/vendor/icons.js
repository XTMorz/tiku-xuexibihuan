/* ============================================================================
 * vendor/icons.js — 莫兰迪色系 SVG 图标库
 *
 * 设计原则：
 *   · 24×24 viewBox
 *   · stroke-width 1.6（视觉权重中等）
 *   · stroke-linecap / linejoin 全部 round（柔和）
 *   · fill: none（线稿式）
 *   · stroke="currentColor"（颜色由 CSS .icon 的 color 控制）
 *   · 不使用任何 emoji，保持风格统一
 *
 * 用法：
 *   `<span class="icon icon-mauve">${icon('book')}</span>`
 *   `<button class="btn">${icon('upload', 'icon-mauve')}上传 Word</button>`
 *
 *   icon(name)：返回 <svg> 字符串
 *   icon(name, cls)：返回带 class 的 <svg class="icon cls">
 *
 * 颜色类（styles.css 配）：
 *   .icon { color: var(--fg); }          默认灰
 *   .icon.icon-mauve  { color: #a594b3 }  主紫
 *   .icon.icon-olive  { color: #9fb3a8 }  灰绿
 *   .icon.icon-sand   { color: #c9b8a0 }  米黄
 *   .icon.icon-rose   { color: #c4a59a }  灰玫瑰
 *   .icon.icon-slate  { color: #a8a4b3 }  灰蓝
 *   .icon.icon-muted  { color: #8a8392 }  弱化灰
 *   .icon.icon-danger { color: #c79696 }  灰玫瑰深
 *   .icon.icon-warn   { color: #d8b97f }  莫兰迪黄
 *   .icon.icon-success{ color: #95b09a }  莫兰迪绿
 * ========================================================================== */
(function (root) {
  const WRAP = (inner) =>
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${inner}</svg>`;

  const ICONS = {
    /* —— 主页 / 导航 —— */
    // 📚 教材（书本）
    book: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4.5A1.5 1.5 0 0 0 18.5 3h-13A1.5 1.5 0 0 0 4 4.5z"/>
           <path d="M4 19.5V21h12.5A2.5 2.5 0 0 0 19 18.5V17H6.5A2.5 2.5 0 0 0 4 19.5z"/>
           <path d="M8 7h8M8 11h6"/>`,

    // 📂 / 📁 所有题库（文件夹）
    folder: `<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3l2 2.5h8A2.5 2.5 0 0 1 21 10v8.5A2.5 2.5 0 0 1 18.5 21h-13A2.5 2.5 0 0 1 3 18.5z"/>
             <path d="M3 10h18"/>`,

    // 📝 题目（笔记 + 笔触）
    note: `<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9"/>
           <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/>
           <path d="M9 13h2M9 17h4"/>`,

    // 🎯 练习（靶心）
    target: `<circle cx="12" cy="12" r="9"/>
             <circle cx="12" cy="12" r="5"/>
             <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>
             <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>`,

    // ✗ 错题（叉 / 错对号）
    x: `<circle cx="12" cy="12" r="9.5"/>
       <path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>`,

    // ★ 收藏（实心五角星）
    star: `<path d="M12 3.2l2.7 5.5 6 .9-4.4 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.6l6-.9z" fill="currentColor" stroke="currentColor"/>`,

    // ☆ 未收藏（线稿五角星）
    starOutline: `<path d="M12 3.2l2.7 5.5 6 .9-4.4 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.6l6-.9z"/>`,

    // ⚡ 今日（闪电）
    bolt: `<path d="M13 2L4.5 13.5h6L11 22l8.5-11.5h-6z"/>`,

    // ✓ 正确
    check: `<circle cx="12" cy="12" r="9.5"/>
            <path d="M7.5 12.5l3 3 6-6"/>`,

    // —— 操作 ——

    // ⤴ 上传（箭头入盒）
    upload: `<path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>
             <path d="M12 4v12"/>
             <path d="M7 9l5-5 5 5"/>`,

    // ⤓ 导出（向下箭头）
    export: `<path d="M12 3v13"/>
             <path d="M7 11l5 5 5-5"/>
             <path d="M4 19h16"/>`,

    // ⤒ 导入（向上箭头）
    import: `<path d="M12 21V8"/>
             <path d="M7 13l5-5 5 5"/>
             <path d="M4 5h16"/>`,

    // 🗑 删除（垃圾桶）
    trash: `<path d="M3 6h18"/>
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>
            <path d="M5.5 6l1.3 13a2 2 0 0 0 2 1.8h6.4a2 2 0 0 0 2-1.8l1.3-13"/>
            <path d="M10 11v6M14 11v6"/>`,

    // ✎ 编辑（铅笔）
    edit: `<path d="M17 3.5a2.121 2.121 0 1 1 3 3L8 18.5l-4 1 1-4z"/>
           <path d="M14 6l4 4"/>`,

    // ✕ 关闭（小叉）
    close: `<path d="M6 6l12 12M18 6L6 18"/>`,

    // + 加号
    plus: `<path d="M12 5v14M5 12h14"/>`,

    // —— 反馈 ——

    // ⚠️ 警告（三角）
    warn: `<path d="M12 3l10 17H2z"/>
           <path d="M12 10v5"/>
           <circle cx="12" cy="17.5" r="0.7" fill="currentColor" stroke="none"/>`,

    // 🎉 庆祝（彩带）
    celebrate: `<path d="M3 21l5-9M21 21l-5-9"/>
               <path d="M12 3v6"/>
               <circle cx="6" cy="9" r="0.7" fill="currentColor" stroke="none"/>
               <circle cx="18" cy="9" r="0.7" fill="currentColor" stroke="none"/>
               <circle cx="9" cy="6" r="0.7" fill="currentColor" stroke="none"/>
               <circle cx="15" cy="6" r="0.7" fill="currentColor" stroke="none"/>
               <circle cx="12" cy="11.5" r="0.7" fill="currentColor" stroke="none"/>`,

    // 📷 OCR / 相机
    camera: `<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l1.5-2.5h7L17 7h2.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>
             <circle cx="12" cy="13" r="3.5"/>`,

    // 📊 统计（柱状）
    chart: `<path d="M4 21V4M4 21h16"/>
           <rect x="7" y="13" width="3" height="6"/>
           <rect x="12" y="9" width="3" height="10"/>
           <rect x="17" y="6" width="3" height="13"/>`,

    // 📈 趋势（折线）
    trend: `<path d="M3 18l5-5 4 3 9-10"/>
            <path d="M14 6h7v7"/>`,

    // 🏠 首页
    home: `<path d="M3 12l9-8 9 8"/>
           <path d="M5 10v10h14V10"/>
           <path d="M10 20v-6h4v6"/>`,

    // ⌕ 搜索
    search: `<circle cx="11" cy="11" r="7"/>
             <path d="M21 21l-5-5"/>`,

    // ✓ 答案对（线稿）
    checkOutline: `<circle cx="12" cy="12" r="9"/>
                  <path d="M8 12.5l3 3 5-5.5"/>`,

    // ✗ 答案错（线稿）
    xOutline: `<circle cx="12" cy="12" r="9"/>
              <path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>`,

    // ▾ 收起（向下小箭头）
    caretDown: `<path d="M6 9l6 6 6-6"/>`,

    // ▸ 展开（向右小箭头）
    caretRight: `<path d="M9 6l6 6-6 6"/>`,

    // 🔄 重做
    refresh: `<path d="M3 12a9 9 0 1 0 3-6.7"/>
             <path d="M3 4v5h5"/>`,

    // ☁ 同步（云朵 + 双向箭头）
    sync: `<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.5A4 4 0 0 1 18 14H7z"/>
           <path d="M9 12l3 3 3-3"/>
           <path d="M9 9l3-3 3 3"/>`,

    // → 箭头（下一页）
    arrowRight: `<path d="M5 12h14"/>
                <path d="M13 6l6 6-6 6"/>`,

    // ← 箭头（上一页）
    arrowLeft: `<path d="M19 12H5"/>
               <path d="M11 6l-6 6 6 6"/>`,

    // ⏭ 跳过
    skip: `<path d="M5 5v14l9-7z"/>
           <path d="M17 5v14"/>`,

    // ？空状态
    empty: `<circle cx="12" cy="12" r="9"/>
           <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5"/>
           <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none"/>`,

    /* —— 设置 / 帮助 —— */
    // ⚙ 齿轮
    settings: `<circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,

    // ⌨ 键盘
    keyboard: `<rect x="2" y="6" width="20" height="12" rx="2"/>
              <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4"/>`,

    // 💡 灯泡
    bulb: `<path d="M9 18h6"/>
          <path d="M10 22h4"/>
          <path d="M12 2a7 7 0 0 0-4 12.7c.7.6 1 1.4 1 2.3v1h6v-1c0-.9.3-1.7 1-2.3A7 7 0 0 0 12 2z"/>`,

    // 📥 下载
    download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <path d="M7 10l5 5 5-5"/>
              <path d="M12 15V3"/>`,

    // ℹ 信息
    info: `<circle cx="12" cy="12" r="9"/>
          <path d="M12 8h.01M11 12h1v5h1"/>`,

    // 📖 翻开的书
    bookOpen: `<path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z"/>
              <path d="M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/>`,
  };

  root.icons = ICONS;
  root.iconHTML = function (name, extraClass = '') {
    const inner = ICONS[name];
    if (!inner) return '';
    const cls = extraClass ? ` ${extraClass}` : '';
    return WRAP(inner).replace('class="icon"', `class="icon${cls}"`);
  };
  root.icon = root.iconHTML;
})(window);
