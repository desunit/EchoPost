// Cloudflare Turnstile server-side check for the public subscribe form.
// Without it, anyone (or any bot) can type a stranger's address into the form,
// and the stranger gets a confirmation mail they never asked for — they click
// "Report spam", and the complaint lands on the shared SES account (2026-11-12,
// a Yahoo complaint). See docs/newsletter.md.

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * True when Cloudflare accepts the token. A missing token, a network error or
 * a non-200 answer all count as "not verified" (fail closed).
 */
export async function verifyTurnstile(
  secret: string,
  token: string | undefined,
  remoteIp?: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  if (!token) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
