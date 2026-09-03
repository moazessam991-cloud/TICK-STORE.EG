'use strict';

/*
 * TICK. Meta Pixel
 * Public storefront Meta Pixel tracking.
 * No customer fields, checkout data, or admin routes are sent here.
 */
(function () {
  const PIXEL_ID = '1550216229722393';
  let lastPath = null;
  let lastViewContentKey = null;
  let initialized = false;

  function canTrack() {
    try {
      const protocol = window.location.protocol;
      const host = window.location.hostname;

      return (
        (protocol === 'https:' || protocol === 'http:') &&
        !!host &&
        host !== 'localhost' &&
        host !== '127.0.0.1' &&
        host !== '0.0.0.0'
      );
    } catch (_) {
      return false;
    }
  }

  function initPixel() {
    if (initialized) return true;
    if (!canTrack()) return false;

    try {
      if (!window.fbq) {
        !function(f,b,e,v,n,t,s)
        {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};
        if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
        n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s)}(
          window,
          document,
          'script',
          'https://connect.facebook.net/en_US/fbevents.js'
        );
      }

      window.fbq('init', PIXEL_ID);
      initialized = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  window.tickMetaPageView = function (path) {
    try {
      const p = String(path || '/');

      /* A real route change starts a fresh content-view scope. */
      if (p !== lastPath) lastViewContentKey = null;

      /* Never include the private admin area in storefront analytics. */
      if (p.startsWith('/admin')) {
        lastPath = p;
        return;
      }

      /* Prevent duplicate PageViews from internal re-renders. */
      if (p === lastPath) return;

      if (!initPixel()) return;

      lastPath = p;
      window.fbq('track', 'PageView');
    } catch (_) {
      /* Analytics must never break the storefront. */
    }
  };

  window.tickMetaViewContent = function (product) {
    try {
      if (!product || typeof product !== 'object') return;

      const id = String(product.id ?? '').trim();
      const name = String(product.name ?? '').trim();
      const value = Number(product.value);

      if (!id || !Number.isFinite(value) || value < 0) return;

      /* One ViewContent per product route visit, not per internal re-render. */
      if (lastViewContentKey === id) return;

      if (!initPixel()) return;

      lastViewContentKey = id;
      window.fbq('track', 'ViewContent', {
        content_ids: [id],
        content_name: name || id,
        content_type: 'product',
        value,
        currency: 'EGP'
      });
    } catch (_) {
      /* Analytics must never break the storefront. */
    }
  };
})();
