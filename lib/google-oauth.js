// One refresh token backs every Google integration (Gmail, Calendar). It is minted once
// in the OAuth playground with every scope ticked at the same time — a token only carries
// the scopes selected when it was created, so re-authorizing for Calendar alone silently
// breaks the Gmail sync.

// Trade the long-lived refresh token for a short-lived access token. Refresh tokens
// don't expire on their own; the caveat is the app's publishing status, below.
export async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN || "",
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();

  if (!res.ok) {
    // While the OAuth app sits in "Testing", Google expires the refresh token after 7
    // days and every later refresh comes back invalid_grant. That reads like a generic
    // auth failure, so say plainly what it is and how to fix it — otherwise the syncs
    // just stop producing tasks and nothing explains why.
    if (text.includes("invalid_grant")) {
      throw new Error(
        "GOOGLE_REFRESH_TOKEN is dead (invalid_grant). If the OAuth app is still in " +
        "Testing status, Google expires the token after 7 days: mint a new one in the " +
        "OAuth playground with every scope ticked and update the Vercel env var. " +
        "Publishing the app to production stops the expiry for good."
      );
    }
    throw new Error(`google token ${res.status}: ${text.slice(0, 200)}`);
  }

  const tok = JSON.parse(text).access_token;
  if (!tok) throw new Error("google returned no access_token");
  return tok;
}

// Thin wrapper over a Google REST API. Throws with the response body included, since a
// bare status code has cost hours of guessing on this project before.
export async function googleApi(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`google ${res.status} on ${url.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}
