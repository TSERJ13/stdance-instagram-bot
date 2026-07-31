import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// 1. Health Check
app.get('/', (req, res) => {
  res.send('OK');
});

// 2. Webhook Verification (GET)
// Meta sends a GET request to verify the webhook URL
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed. Token mismatch.');
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

// 3. Receive Webhook Events (POST)
// Instagram sends POST requests when someone messages the page
app.post('/webhook', (req, res) => {
  const body = req.body;

  // Check if this is an event from an instagram page subscription
  if (body.object === 'instagram') {
    body.entry.forEach((entry) => {
      // messaging contains array of message objects
      const webhookEvent = entry.messaging ? entry.messaging[0] : null;
      if (webhookEvent) {
        console.log('📬 Received Instagram Event:', JSON.stringify(webhookEvent, null, 2));

        const senderId = webhookEvent.sender.id;
        const messageText = webhookEvent.message?.text;

        if (messageText) {
          console.log(`💬 Message from ${senderId}: "${messageText}"`);
          // AI response logic will go here later
        }
      }
    });

    return res.status(200).send('EVENT_RECEIVED');
  }

  // Return a '404 Not Found' if event is not from an instagram subscription
  return res.sendStatus(404);
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`🔗 Webhook verification endpoint: http://localhost:${PORT}/webhook`);
});
