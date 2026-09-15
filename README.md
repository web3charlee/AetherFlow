# Aether Flow — rebuilt clean

This replaces your whole aetherflowapp folder. Delete your local copy and
use this one, to make sure there's no leftover broken edit from earlier.

## What's confirmed working (tested before sending this to you)
- Server boots with no syntax errors
- `/` — landing page — HTTP 200
- `/demo` — live demo page — HTTP 200
- `/img/mark.png` — logo asset — HTTP 200
- `/api/schedules` — backend API — HTTP 200

## What I could NOT test from my side
- Any call that actually reaches Interlink's server (`/api/agent`, wallet
  auth, balance, sending). My environment can't reach their domain. This
  will work from your machine and from Render — both have normal internet
  access — but it's the first thing to verify yourself.

## Deploy steps

1. Delete your local `aetherflowapp` folder entirely (or rename it) so
   nothing old lingers.
2. Unzip this in its place.
3. Terminal: `npm install`, then `npm start`.
4. Open `http://localhost:3000/` — should show the landing page.
5. Click "Live Demo" or go to `http://localhost:3000/demo`.
6. Click "Connect Wallet" (MetaMask) or "Generate a demo one instead."
7. Watch the Live RPC console: you should see exactly ONE `/auth/challenge`
   call and ONE `/auth/verify` call — not a repeating loop. If it succeeds,
   the Auth pill turns green.
8. Fund the shown address via the faucet, click Refresh — balance should
   update.
9. Try "check my balance" and a small transfer in the command box.
10. Scroll to "Recurring transfers" — confirm it shows an agent address
    and balance.

## Once local testing passes

```
git add .
git commit -m "clean rebuild: fixed routes, auth fields, retry loop"
git push
```

Then check Render's Deploys tab for a NEW deploy (different commit hash
than before), wait for "Live", and re-run the same checklist against your
actual Render URL before sending it anywhere.
