# Runbook: a recipient can't sign in

**When:** a recipient says the code never arrives, the code is refused, they are locked out, or they changed or lost their phone number.

## What the system does

- **Codes** are 6 digits and valid for 10 minutes. Only the newest code for a number works, and each code works once.
- **Limits:**
  - 3 codes per number per hour;
  - `RATE_LIMIT_AUTH_PER_HOUR` code requests per client per hour (default 10), and three times that many verifications;
  - 5 wrong codes lock the number for 15 minutes.
- **The code request always answers "sent".** It never reveals whether the number has an account.
- **Delivery** is pretend until a messaging provider is approved (D-08). Codes and links appear in the development inbox (`/dev/inbox`, API `GET /v1/dev/inbox`), which exists only with `MESSAGING_PROVIDER=mock` and is refused in production.

## Steps

1. **"The code never came":**
   - Check the number format. Local numbers ("0803 123 4567") are read as Nigerian.
   - In development, look in the pretend inbox. Messages show only the last four digits.
   - If the number asked for 3 codes in the last hour, it must wait.
2. **"The code is refused":**
   - Note: anyone who knows a number can lock it this way (known limitation; it clears after 15 minutes).
   - Only the newest code works, for 10 minutes.
   - After 5 wrong tries the number is locked for 15 minutes. That clears by itself; there is no manual unlock.
3. **"I lost my number":** if the recipient verified an email, they use **Sign in → Lost your number? → Recover your account**.
   - The link (30 minutes) plus a code sent to the new number schedules the move for **24 hours later**.
   - The old number and the email are warned. Any signed-in device can cancel it in Settings.
   - After 24 hours, signing in with the new number completes the move and ends every other session. Before that, the new number answers "waiting to be moved".
   - Without a verified email there is no self-service recovery yet. Do not move a number by hand without identity checks (D-06).
4. **"Someone else has my old number":** the owner can sign in on any device and use **Settings → Devices → Sign out of all other devices**, then change the number (**Settings → Phone and email**).

## Never

- Read, log or share codes, session tokens or full phone numbers. Logs never contain them.
- Change `users.phone_e164` directly in the database. It bypasses the code check and the session revocation.
