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
app.post('/webhook', (req, res) => {
  console.log("📥 POST /webhook ROUTE ENTERED!");
  try {
    const body = req.body;

    console.log('📬 Received Webhook Body:', JSON.stringify(body, null, 2));

    // Immediately respond to Meta to prevent timeout and retries
    res.status(200).send('EVENT_RECEIVED');

    if (body && body.object === 'instagram') {
      // Process in background
      processWebhookBackground(body).catch(err => {
        console.log("❌ BACKGROUND ERROR:", err.stack || err.message);
      });
    }
  } catch (err) {
    console.log("❌ ERROR:", err.stack || err.message);
  }
});

async function processWebhookBackground(body) {
  console.log("🔍 BACKGROUND: Starting processing...");
  if (!body.entry || !Array.isArray(body.entry)) {
    console.log("🔍 BACKGROUND: body.entry is not an array or is missing");
    return;
  }

  console.log(`🔍 BACKGROUND: body.entry has ${body.entry.length} entries`);

  for (let i = 0; i < body.entry.length; i++) {
    const entry = body.entry[i];
    console.log(`🔍 BACKGROUND: Entry [${i}] keys:`, Object.keys(entry));

    if (!entry.messaging || !Array.isArray(entry.messaging)) {
      console.log(`🔍 BACKGROUND: Entry [${i}].messaging is not an array or is missing`);
      continue;
    }

    console.log(`🔍 BACKGROUND: Entry [${i}].messaging has ${entry.messaging.length} events`);

    for (let j = 0; j < entry.messaging.length; j++) {
      const event = entry.messaging[j];
      console.log(`🔍 BACKGROUND: Event [${i}][${j}] keys:`, Object.keys(event));

      const senderId = event.sender?.id;
      let messageText = event.message?.text;
      const isEcho = event.message?.is_echo;
      const messageEditMid = event.message_edit?.mid;

      console.log(`🔍 BACKGROUND: senderId=${senderId}, messageText=${messageText}, messageEditMid=${messageEditMid}, isEcho=${isEcho}`);

      // Fallback for message_edit events
      if (senderId && !messageText && messageEditMid && !isEcho) {
        try {
          console.log(`🔍 BACKGROUND: Fallback condition met. Fetching text for mid: ${messageEditMid}`);
          messageText = await fetchMessageTextByMid(messageEditMid);
          console.log("🔧 FETCHED TEXT FROM EDIT EVENT:", messageText);
        } catch (fetchErr) {
          console.log("❌ ERROR:", fetchErr.stack || fetchErr.message);
        }
      }

      // Only respond to messages that contain text and are not bot echos
      if (senderId && messageText && !isEcho) {
        console.log("🎯 REAL MESSAGE RECEIVED:", messageText, "FROM:", senderId);

        try {
          // Call Gemini 2.0 Flash
          console.log(`🔍 BACKGROUND: Requesting Gemini API for: "${messageText}"`);
          const replyText = await getGeminiResponse(messageText);
          console.log("🤖 GEMINI RESPONSE:", replyText);

          // Send reply to Instagram
          console.log(`🔍 BACKGROUND: Sending reply to Instagram for: ${senderId}`);
          const igRes = await sendInstagramMessage(senderId, replyText);
          console.log("📤 SENT TO INSTAGRAM, status:", igRes.status);
        } catch (apiErr) {
          console.log("❌ ERROR:", apiErr.stack || apiErr.message);
        }
      } else {
        console.log(`🔍 BACKGROUND: Skipping response. Conditions not met. (hasText=${!!messageText}, isNotEcho=${!isEcho})`);
      }
    }
  }
  console.log("🔍 BACKGROUND: Processing completed.");
}

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
  }, { timeout: 8000 }); // 8 seconds timeout

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
  }, { timeout: 8000 }); // 8 seconds timeout

  return response;
}

async function fetchMessageTextByMid(mid) {
  const pageAccessToken = process.env.PAGE_ACCESS_TOKEN;
  if (!pageAccessToken) {
    throw new Error('PAGE_ACCESS_TOKEN is not defined');
  }

  // Try graph.instagram.com first
  try {
    const url = `https://graph.instagram.com/v21.0/${mid}?fields=message&access_token=${pageAccessToken}`;
    const response = await axios.get(url, { timeout: 8000 }); // 8 seconds timeout
    return extractText(response.data);
  } catch (err) {
    console.log(`⚠️ graph.instagram.com failed, trying graph.facebook.com: ${err.message}`);
    const url = `https://graph.facebook.com/v21.0/${mid}?fields=message&access_token=${pageAccessToken}`;
    const response = await axios.get(url, { timeout: 8000 }); // 8 seconds timeout
    return extractText(response.data);
  }
}

function extractText(fetchedData) {
  let fetchedText = '';
  if (fetchedData && fetchedData.message) {
    if (typeof fetchedData.message === 'string') {
      fetchedText = fetchedData.message;
    } else if (fetchedData.message.text) {
      fetchedText = fetchedData.message.text;
    }
  }
  if (!fetchedText) {
    throw new Error(`Could not extract message text from: ${JSON.stringify(fetchedData)}`);
  }
  return fetchedText;
}

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
