// [CUSTOM-BEGIN] CUSTOM-20260928-097 - 图片点击放大（lightbox）：新增客户端模块。
// 记录区 content-image 与输入框 attachment-thumb 里的图片，点击后全屏放大查看。
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260928-097
export const lightboxClient = `
(function (NS) {
  'use strict';

  var overlay = null;
  var img = null;

  function open(src, alt) {
    if (!overlay || !img) { return; }
    img.setAttribute('src', src);
    img.setAttribute('alt', alt || '');
    overlay.hidden = false;
  }

  function close() {
    if (overlay) { overlay.hidden = true; }
  }

  function isZoomable(node) {
    if (!node || node.tagName !== 'IMG') { return false; }
    var cls = String(node.className || '');
    return cls.indexOf('content-image') >= 0
      || cls.indexOf('content-thumb') >= 0
      || cls.indexOf('attachment-thumb') >= 0;
  }

  /**
   * [CUSTOM-20260928-102] What to enlarge for a click, or null.
   *
   * An image chip ('.content-image-chip') carries the source itself, so the WHOLE
   * chip is a hit target — clicking the filename must work as well as the thumbnail.
   * A bare image is still zoomable on its own (the input-box thumbnail).
   */
  function zoomTarget(node) {
    var current = node;
    while (current && current !== document.body) {
      if (current.getAttribute && current.getAttribute('data-zoom-src')) {
        return {
          src: current.getAttribute('data-zoom-src'),
          alt: current.getAttribute('data-zoom-alt') || ''
        };
      }
      if (isZoomable(current)) {
        return {
          src: current.getAttribute('src') || current.src || '',
          alt: current.getAttribute('alt') || ''
        };
      }
      current = current.parentNode;
    }
    return null;
  }

  function install() {
    overlay = NS.dom.qs('imageLightbox');
    if (!overlay) { return; }
    img = overlay.querySelector('.image-lightbox-img');
    var closeBtn = overlay.querySelector('.image-lightbox-close');
    if (closeBtn) { closeBtn.addEventListener('click', close); }
    // 点背景（不是图本身）就关。
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) { close(); }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { close(); }
    });
    document.body.addEventListener('click', function (event) {
      var hit = zoomTarget(event.target);
      if (hit && hit.src) {
        event.preventDefault();
        open(hit.src, hit.alt);
      }
    });
  }

  NS.lightbox = { install: install };
})(window.__acpc = window.__acpc || {});
`;
