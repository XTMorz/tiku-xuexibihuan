// vendor/jszip-loader.js
// 把 JSZip 挂到 window 上，供 app.js 用
// 用普通 <script> 引入（非 module），最简单

(function () {
  // jszip.min.js 内部用 UMD/CommonJS 检测：浏览器下会直接挂 window.JSZip
  if (window.JSZip) return;
  // jszip.min.js 是 IIFE，自挂 window.JSZip，这里只需确保已加载
  if (typeof window.JSZip === 'undefined') {
    console.warn('[jszip-loader] window.JSZip 仍未定义，请检查 vendor/jszip/jszip.min.js 是否已加载');
  }
})();