/* ============================================================================
 * mupdf-loader.js
 * 把 mupdf.js (ESM + WASM) 动态加载到浏览器，挂到 window.mupdfLib 上
 * 加载成功后 app.js 就可以用 window.mupdfLib 解析 PDF
 * 解决 PDF.js 抽不出 Identity-H 无 ToUnicode CMap 的 PDF 的问题
 * ========================================================================== */

let _mupdfPromise = null;

export function loadMupdf() {
  if (window.mupdfLib) return Promise.resolve(window.mupdfLib);
  if (_mupdfPromise) return _mupdfPromise;

  _mupdfPromise = import('./vendor/mupdf/mupdf.js')
    .then(mod => {
      // mupdf 导出方式因版本而异，统一挂一个 namespace
      const lib = mod.default || mod.mupdf || mod;
      window.mupdfLib = lib;
      console.log('[mupdf] 已加载', Object.keys(lib).slice(0, 10));
      return lib;
    })
    .catch(err => {
      _mupdfPromise = null;
      console.error('[mupdf] 加载失败:', err);
      throw err;
    });
  return _mupdfPromise;
}

// 立即开始加载（不等用户上传 PDF）
loadMupdf();