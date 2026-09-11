'use strict';

/*
 * TICK. Google Analytics 4
 * Public storefront SPA page-view tracking only.
 * No customer fields, checkout form data, or admin routes are sent here.
 */
(function () {
  const MEASUREMENT_ID = 'G-R1RMH4JQ8S';
  let initialized = false;
  let lastPath = null;

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

  function initGA() {
    if (initialized) return true;
    if (!canTrack()) return false;

    try {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () {
        window.dataLayer.push(arguments);
      };

      window.gtag('js', new Date());

      /*
       * TICK is an SPA. Page views are sent manually below so route changes
       * are counted once and internal re-renders do not create duplicates.
       */
      window.gtag('config', MEASUREMENT_ID, {
        send_page_view: false
      });

      const script = document.createElement('script');
      script.async = true;
      script.src =
        'https://www.googletagmanager.com/gtag/js?id=' +
        encodeURIComponent(MEASUREMENT_ID);

      const firstScript = document.getElementsByTagName('script')[0];

      if (firstScript && firstScript.parentNode) {
        firstScript.parentNode.insertBefore(script, firstScript);
      } else if (document.head) {
        document.head.appendChild(script);
      } else {
        return false;
      }

      initialized = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  window.tickGaPageView = function (path) {
    try {
      const p = String(path || '/');

      /* Never include the private admin area in storefront analytics. */
      if (p.startsWith('/admin')) {
        lastPath = p;
        return;
      }

      /* Prevent duplicate page views caused by internal SPA re-renders. */
      if (p === lastPath) return;

      if (!initGA()) return;

      lastPath = p;

      window.gtag('event', 'page_view', {
        page_location: window.location.href
      });
    } catch (_) {
      /* Analytics must never break the storefront. */
    }
  };
})();
