// Terminal demo: chat with the receptionist without Twilio.
// Urgent alerts print to the console instead of sending an SMS.
import 'dotenv/config';
import readline from 'readline/promises';
import { respond } from './server.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('AI Receptionist demo. Type "quit" to exit.\n');

while (true) {
  const text = (await rl.question('You: ')).trim();
  if (text === 'quit') break;
  if (!text) continue;
  const reply = await respond('demo', 'text', '+910000000000', text);
  console.log(`Bot: ${reply.replace('[END]', '').trim()}\n`);
}
rl.close();
