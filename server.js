import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';

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
app.post('/webhook', async (req, res) => {
  const body = req.body;

  console.log('📬 Received Webhook Body:', JSON.stringify(body, null, 2));

  if (body.object === 'instagram') {
    try {
      for (const entry of body.entry) {
        if (entry.messaging) {
          for (const event of entry.messaging) {
            const senderId = event.sender?.id;
            const messageText = event.message?.text;
            const isEcho = event.message?.is_echo;

            // Only respond to messages that contain text and are not bot echos
            if (senderId && messageText && !isEcho) {
              console.log(`💬 Incoming message from ${senderId}: "${messageText}"`);

              try {
                // Call Gemini 2.0 Flash
                const replyText = await getGeminiResponse(messageText);
                console.log(`🤖 Gemini response: "${replyText}"`);

                // Send reply to Instagram
                await sendInstagramMessage(senderId, replyText);
                console.log(`✅ Reply sent successfully to ${senderId}`);
              } catch (apiErr) {
                console.error(`❌ Error in Gemini or Instagram API for ${senderId}:`, apiErr.message);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('❌ Error parsing webhook event:', err.message);
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.sendStatus(404);
});

// Helpers
async function getGeminiResponse(userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not defined');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await axios.post(url, {
    contents: [
      {
        role: 'user',
        parts: [{ text: userText }]
      }
    ],
    systemInstruction: {
      parts: [{
        text: "შენ ხარ ST Dance Studio-ს (ბათუმის ცეკვების სტუდია) მეგობრული ასისტენტი Instagram-ზე. უპასუხე ქართულად, მოკლედ და თავაზიანად."
      }]
    }
  });

  const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) {
    throw new Error('Invalid response structure from Gemini API');
  }

  return reply.trim();
}

async function sendInstagramMessage(recipientId, textMessage) {
  const pageAccessToken = process.env.PAGE_ACCESS_TOKEN;
  if (!pageAccessToken) {
    throw new Error('PAGE_ACCESS_TOKEN is not defined');
  }

  const url = `https://graph.instagram.com/v21.0/me/messages?access_token=${pageAccessToken}`;

  const response = await axios.post(url, {
    recipient: {
      id: recipientId
    },
    message: {
      text: textMessage
    }
  });

  return response.data;
}

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
