// Content-Security-Policy builder. The base policy is deliberately strict
// (no inline/remote scripts beyond the X embed helper). Google Analytics 4 is
// opt-in: when a measurement ID is configured we widen exactly the directives
// GA needs — the googletagmanager script origin (plus a per-request nonce for
// the inline gtag bootstrap), the google-analytics beacon endpoints, and the
// fallback tracking pixel. With GA off the returned string is byte-identical to
// the original strict policy.

export interface CspOptions {
  /** GA4 measurement ID; empty/undefined keeps the strict (GA-free) policy. */
  gaMeasurementId?: string;
  /** Per-request nonce authorizing the inline gtag bootstrap script. */
  nonce?: string;
}

export function buildContentSecurityPolicy(opts: CspOptions = {}): string {
  const ga = Boolean(opts.gaMeasurementId);

  const imgSrc = ["'self'", "data:", "https://pbs.twimg.com"];
  const scriptSrc = ["'self'", "https://platform.twitter.com"];

  if (ga) {
    imgSrc.push("https://www.google-analytics.com");
    scriptSrc.push("https://www.googletagmanager.com");
    if (opts.nonce) scriptSrc.push(`'nonce-${opts.nonce}'`);
  }

  const directives = [
    "default-src 'self'",
    `img-src ${imgSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `script-src ${scriptSrc.join(" ")}`,
  ];

  if (ga) {
    // GA4 sends hits via fetch/beacon to regional google-analytics endpoints.
    directives.push(
      "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com",
    );
  }

  directives.push(
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://platform.twitter.com",
    "frame-ancestors 'self'",
  );

  return directives.join("; ");
}
