#!/usr/bin/env node
// One-off FPL sign-in for the fpl-agent executor.
// Runs on your own computer. Your password goes only to premierleague.com in your browser;
// this script never sees it. It exchanges the one-time code for a long-lived refresh token
// and stores it as the GitHub secret FPL_REFRESH_TOKEN (via the gh CLI if installed).
//
// Usage:  node fpl-login.mjs
// Needs Node 18 or later.

import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';

const AUTHORITY = 'https://account.premierleague.com/as';
const CLIENT_ID = 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';
const REDIRECT_URI = 'https://fantasy.premierleague.com/';
const REPO = 'killua-9/fpl-agent';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(64));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));

const url = `${AUTHORITY}/authorize?` + new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: 'openid profile email offline_access',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
});

console.log(`
1. Open a NEW private/incognito window (close any other private windows first).
2. Paste this link into it and sign in to FPL as normal:

${url}

3. When you land on the FPL site, copy the FULL address from the address bar
   (it contains "code=" and "state="), then CLOSE the private window immediately.
   Do not browse FPL in that window: revisiting the site in that session cancels the token.
`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question('4. Paste the address here and press Enter: ')).trim();
rl.close();

// Accept the address with or without "https://" (Chrome often drops it when copying),
// or just the part from "?code=" onwards.
const query = pasted.includes('?') ? pasted.slice(pasted.indexOf('?')) : pasted;
const params = new URLSearchParams(query);
if (params.get('state') !== state) throw new Error('State mismatch: run the script again and use the new link.');
const code = params.get('code');
if (!code) throw new Error(`No code in the address (error: ${params.get('error') ?? 'unknown'}).`);

const resp = await fetch(`${AUTHORITY}/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }),
});
const body = await resp.json().catch(() => ({}));
if (!resp.ok || !body.refresh_token) {
  throw new Error(`Token exchange failed (${resp.status}): ${JSON.stringify(body).slice(0, 300)}`);
}

// Quick check that the token really belongs to an FPL account.
const me = await fetch('https://fantasy.premierleague.com/api/me/', {
  headers: { 'X-API-Authorization': `Bearer ${body.access_token}`, 'User-Agent': 'fpl-agent' },
}).then((r) => r.json()).catch(() => ({}));
const entry = me?.player?.entry;
console.log(`\nSigned in. FPL team ID on this account: ${entry ?? 'not shown'} (expected 531300).`);

const gh = spawnSync('gh', ['secret', 'set', 'FPL_REFRESH_TOKEN', '-R', REPO], {
  input: body.refresh_token,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (gh.status === 0) {
  console.log(`Saved as secret FPL_REFRESH_TOKEN in ${REPO}. Nothing else to do.`);
} else {
  console.log(`
GitHub CLI not available, so save it by hand:
  github.com/${REPO} > Settings > Secrets and variables > Actions > New repository secret
  Name:  FPL_REFRESH_TOKEN
  Value: the line below (it gives control of your FPL team: paste it nowhere else)

${body.refresh_token}
`);
}
