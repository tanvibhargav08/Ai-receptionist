import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import twilio from 'twilio';

const biz = JSON.parse(fs.readFileSync('business.json', 'utf8'));
const claude = new Anthropic(); // reads ANTHROPIC_API_KEY
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, OWNER_PHONE, PUBLIC_URL, ADMIN_TOKEN } = process.env;
const sms = TWILIO_ACCOUNT_SID ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null; // null = demo mode
const VOICE = 'Polly.Joanna';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public')); // the front page

// Reject requests that don't really come from Twilio
const verify = (req, res, next) =>
  twilio.validateRequest(TWILIO_AUTH_TOKEN, req.get('X-Twilio-Signature') || '', PUBLIC_URL + req.originalUrl, req.body)
    ? next()
    : res.sendStatus(403);

// ---------- Agent ----------
const tools = [
  {
    name: 'take_message',
    description: 'Save a non-urgent message for the owner. Call once you have the sender name, a contact, and the message.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, contact: { type: 'string' }, message: { type: 'string' } },
      required: ['name', 'contact', 'message'],
    },
  },
  {
    name: 'flag_urgent',
    description: 'Instantly text the owner. Use for anything matching the urgent rules.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' }, name: { type: 'string' }, contact: { type: 'string' } },
      required: ['reason'],
    },
  },
];

const system = (s) => `You are the receptionist for ${biz.name}, ${biz.description}.
Be warm, brief and natural. If asked, say you're the business's AI assistant.
Hours: ${biz.hours}
FAQs:
${biz.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n')}
Rules:
- Answer only from the info above. If unsure, never guess; offer to take a message.
- To take a message, get their name and best contact (their number is ${s.contact}; offer to use it), then call take_message.
- URGENT means: ${biz.urgentRules}. Call flag_urgent immediately, then tell them the owner has been alerted.
- Never promise prices, bookings, refunds or anything not listed above.
${s.channel === 'voice'
    ? '- This is a phone call: max 2 short sentences, no lists or emoji. When the conversation is finished, end your reply with [END].'
    : '- This is a text/DM: keep replies short and friendly.'}`;

const sessions = new Map();

function runTool(u, s) {
  const rec = { time: new Date().toISOString(), channel: s.channel, from: s.contact, type: u.name, ...u.input };
  fs.appendFileSync('messages.jsonl', JSON.stringify(rec) + '\n');
  (s.events ??= []).push(rec);
  if (u.name === 'flag_urgent') alertOwner(`URGENT (${biz.name}): ${u.input.reason}. ${u.input.name || ''} ${u.input.contact || s.contact}`);
  return 'Done.';
}

function alertOwner(body) {
  if (!sms) { console.log(`\n🚨 [OWNER ALERT] ${body}\n`); return Promise.resolve(); }
  return sms.messages.create({ to: OWNER_PHONE, from: TWILIO_NUMBER, body }).catch(console.error);
}

// Mock mode: scripted, rule-based replies (no API call). Enable with MOCK_MODE=true in .env
const STOP = new Set(['what', 'your', 'does', 'have', 'that', 'with', 'this', 'when', 'will']);
const words = (str) => (str.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w));

function mockRespond(s, text) {
  const t = text.toLowerCase();
  const m = (s.mock ??= { step: null, data: {} });
  if (m.step === 'name') { m.data.name = text; m.step = 'contact'; return `Thanks ${text}! What's the best phone number or email to reach you?`; }
  if (m.step === 'contact') { m.data.contact = text; m.step = 'msg'; return 'Got it. What message should I pass on to the owner?'; }
  if (m.step === 'msg') {
    runTool({ name: 'take_message', input: { ...m.data, message: text } }, s);
    m.step = null; m.data = {};
    return "Done! I've saved your message and the owner will get back to you soon.";
  }
  if (/emergenc|urgent|asap|right now|immediately|burst|fire|flood|accident/.test(t)) {
    runTool({ name: 'flag_urgent', input: { reason: text } }, s);
    return "I've alerted the owner right away, and they'll contact you as soon as possible.";
  }
  if (/message|call me back|callback|leave/.test(t)) { m.step = 'name'; return "Sure, I can take a message. What's your name?"; }
  if (/^(hi|hello|hey)\b/.test(t)) return 'Hi! How can I help you today?';
  const userWords = words(t);
  let best = null, score = 0;
  for (const f of [{ q: 'hours open close timing', a: `We're open ${biz.hours}.` }, ...biz.faqs]) {
    const fw = new Set(words(f.q));
    const sc = userWords.filter((w) => fw.has(w)).length;
    if (sc > score) { score = sc; best = f; }
  }
  return best ? best.a : "I'm not sure about that one. Would you like me to take a message for the owner?";
}

export async function respond(id, channel, contact, text) {
  const s = sessions.get(id) ?? { channel, contact, history: [] };
  sessions.set(id, s);
  if (process.env.MOCK_MODE === 'true') return mockRespond(s, text);
  s.history.push({ role: 'user', content: text });
  for (let i = 0; i < 5; i++) {
    const r = await claude.messages.create({
      model: 'claude-sonnet-5-5', max_tokens: 400, system: system(s), tools, messages: s.history,
    });
    s.history.push({ role: 'assistant', content: r.content });
    const uses = r.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return r.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    s.history.push({
      role: 'user',
      content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: runTool(u, s) })),
    });
  }
  return 'Let me have the owner follow up with you directly.';
}

// ---------- Phone ----------
function listen(t, text) {
  const g = t.gather({ input: 'speech', speechTimeout: 'auto', action: '/voice/turn', method: 'POST' });
  g.say({ voice: VOICE }, text);
  t.redirect({ method: 'POST' }, '/voice/silence');
}

app.post('/voice', verify, (req, res) => {
  const t = new twilio.twiml.VoiceResponse();
  listen(t, biz.greeting);
  res.type('text/xml').send(t.toString());
});

app.post('/voice/silence', verify, (req, res) => {
  const t = new twilio.twiml.VoiceResponse();
  t.say({ voice: VOICE }, "I didn't catch anything. Please call back anytime. Goodbye.");
  t.hangup();
  res.type('text/xml').send(t.toString());
});

app.post('/voice/turn', verify, async (req, res) => {
  const t = new twilio.twiml.VoiceResponse();
  let reply;
  try {
    reply = await respond(req.body.CallSid, 'voice', req.body.From, req.body.SpeechResult || '(no speech)');
  } catch (e) {
    console.error(e);
    alertOwner(`Receptionist error on a call from ${req.body.From}. Please call them back.`);
    reply = "I'm having a technical problem, so I've alerted the owner to call you back. Goodbye. [END]";
  }
  const end = reply.includes('[END]');
  reply = reply.replace('[END]', '').trim();
  if (end) { t.say({ voice: VOICE }, reply); t.hangup(); } else listen(t, reply);
  res.type('text/xml').send(t.toString());
});

// ---------- Text / WhatsApp DMs ----------
app.post('/sms', verify, async (req, res) => {
  const r = new twilio.twiml.MessagingResponse();
  const reply = await respond(req.body.From, 'text', req.body.From, req.body.Body).catch((e) => {
    console.error(e);
    alertOwner(`Receptionist error on a DM from ${req.body.From}.`);
    return 'Thanks for your message! The owner will get back to you soon.';
  });
  r.message(reply);
  res.type('text/xml').send(r.toString());
});

// ---------- Web chat (front page) ----------
app.get('/api/info', (req, res) => res.json({ name: biz.name, greeting: biz.greeting, hours: biz.hours, mock: process.env.MOCK_MODE === 'true' }));

app.post('/chat', async (req, res) => {
  const { id, text } = req.body;
  if (!id || !text) return res.status(400).json({ error: 'Missing id or text' });
  try {
    const reply = await respond('web-' + id, 'web', 'unknown, so ask for a phone number or email', text);
    const s = sessions.get('web-' + id);
    const events = s.events ?? [];
    s.events = [];
    res.json({ reply, events });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Inbox: /messages?token=ADMIN_TOKEN ----------
app.get('/messages', (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.sendStatus(401);
  const lines = fs.existsSync('messages.jsonl') ? fs.readFileSync('messages.jsonl', 'utf8').trim().split('\n') : [];
  res.json(lines.filter(Boolean).map((l) => JSON.parse(l)).reverse());
});

if (process.argv[1].endsWith('server.js')) {
  app.listen(process.env.PORT || 3000, () => console.log('Receptionist running'));
}
