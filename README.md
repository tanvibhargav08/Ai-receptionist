# AI Receptionist

Answers calls and text DMs, handles FAQs, takes messages, and texts you instantly when something is urgent.

## Quick demo (no phone account needed)

```bash
npm install
cp .env.example .env     # only ANTHROPIC_API_KEY is required for the demo
npm run demo
```

Try: "What are your hours?", "Can you take a message for the owner?", "My pipe burst, this is an emergency!" Urgent alerts print as `[OWNER ALERT]` in the terminal; with Twilio configured they are sent as real SMS.

## How it works

Twilio webhook (call or text) -> Express server -> Claude with tool use (`take_message`, `flag_urgent`) -> reply as speech (TwiML) or text. Business info lives in `business.json`, so it can be adapted to any small business without code changes.

## Full setup with real phone calls (about 20 minutes)

1. **Edit `business.json`**: your name, hours, FAQs, and what counts as urgent. This is the only "training" it needs.
2. `cp .env.example .env` and fill it in (Anthropic key, Twilio credentials, your own mobile for alerts).
3. `npm install && npm start`
4. **Host it** somewhere with a public HTTPS URL (Render, Railway, Fly.io, or a VPS). For local testing use `ngrok http 3000`. Put that URL in `PUBLIC_URL`.
5. **Twilio console** → your phone number:
   - *Voice, "A call comes in"* → Webhook, POST, `PUBLIC_URL/voice`
   - *Messaging, "A message comes in"* → Webhook, POST, `PUBLIC_URL/sms`
   (The same `/sms` endpoint works for WhatsApp via Twilio's WhatsApp sender.)
6. Call your number and test it. Say "this is an emergency" to check the urgent alert reaches your phone.

## Where things go
- **Urgent**: instant SMS to `OWNER_PHONE`.
- **Messages**: saved to `messages.jsonl`; view at `PUBLIC_URL/messages?token=ADMIN_TOKEN`.
- **If the AI errors out**: the caller gets a polite fallback and you get a text.

## Before going live
- Sessions are held in memory (reset on restart). Fine for a small business.
- Many places require telling callers they're talking to an AI; the greeting already does. Don't enable call recording without checking local consent rules.
- To forward calls from your existing number, set call-forwarding to your Twilio number (e.g. "when busy / no answer").
- **Instagram / Facebook DMs**: add a Meta webhook route that calls `respond(senderId, 'text', senderId, text)` and sends the reply via the Graph API. The agent logic is unchanged.
