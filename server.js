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

// 1.5 Data Deletion Instructions Page (GET)
app.get('/data-deletion', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ST Dance Studio — Data Deletion Instructions</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #0f0f13;
      color: #e0e0e0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .container {
      background-color: #1a1a24;
      border: 1px solid #2d2d3d;
      border-radius: 12px;
      max-width: 600px;
      padding: 40px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    h1 {
      color: #d4af37;
      font-size: 1.8rem;
      margin-top: 0;
      margin-bottom: 20px;
      border-bottom: 1px solid #2d2d3d;
      padding-bottom: 15px;
    }
    p {
      line-height: 1.7;
      font-size: 1.05rem;
      color: #cccccc;
      margin-bottom: 20px;
    }
    a {
      color: #d4af37;
      text-decoration: none;
      font-weight: 500;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>ST Dance Studio — Data Deletion Instructions</h1>
    <p>If you would like to request deletion of your personal data collected through our Instagram messaging service, please contact us at <a href="mailto:stdancestudio13@gmail.com">stdancestudio13@gmail.com</a> or call <a href="tel:+995514199966">+995 514 19 99 66</a>.</p>
    <p>We will process your data deletion request within 30 days and confirm once completed.</p>
    <p>For more information, see our Privacy Policy: <a href="https://stdance.ge/en/privacy" target="_blank" rel="noopener noreferrer">https://stdance.ge/en/privacy</a></p>
  </div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
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
    return;
  }

  for (let i = 0; i < body.entry.length; i++) {
    const entry = body.entry[i];

    if (!entry.messaging || !Array.isArray(entry.messaging)) {
      continue;
    }

    for (let j = 0; j < entry.messaging.length; j++) {
      const event = entry.messaging[j];

      let senderId = event.sender?.id;
      let messageText = event.message?.text;
      const isEcho = event.message?.is_echo;
      const messageEditMid = event.message_edit?.mid;

      console.log(`🔍 EVENT: senderId=${senderId}, messageText="${messageText || ''}", messageEditMid=${messageEditMid}, isEcho=${isEcho}`);

      // Fallback for message_edit events
      if (!messageText && messageEditMid && !isEcho) {
        try {
          console.log(`🔍 BACKGROUND: Fallback condition met for message_edit. Fetching details for mid: ${messageEditMid}`);
          const details = await fetchMessageDetails(messageEditMid);
          messageText = details.text;
          senderId = details.senderId;
          console.log(`🔧 FETCHED DETAILS: "${messageText}" FROM: ${senderId}`);
        } catch (fetchErr) {
          console.log("❌ FALLBACK FETCH ERROR:", fetchErr.message);
        }
      }

      // Respond to text messages from users (ignore bot echos)
      if (senderId && messageText && !isEcho) {
        console.log("🎯 REAL MESSAGE RECEIVED:", messageText, "FROM:", senderId);

        try {
          // 1. Call Gemini API
          console.log(`🤖 Requesting Gemini API for: "${messageText}"`);
          const replyText = await getGeminiResponse(messageText);
          console.log("🤖 GEMINI RESPONSE:", replyText);

          // 2. Send reply to Instagram
          console.log(`📤 Sending reply to Instagram user: ${senderId}`);
          const igRes = await sendInstagramMessage(senderId, replyText);
          console.log("📤 SENT TO INSTAGRAM, status:", igRes.status);
        } catch (apiErr) {
          console.log("❌ ERROR processing message:", apiErr.stack || apiErr.message);
        }
      } else {
        console.log(`ℹ️ Skipping non-text or echo event.`);
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
  let pageAccessToken = process.env.PAGE_ACCESS_TOKEN;
  if (!pageAccessToken) {
    throw new Error('PAGE_ACCESS_TOKEN is not defined');
  }
  pageAccessToken = pageAccessToken.replace(/['"]/g, '').trim();

  // Instagram Login tokens use graph.instagram.com
  const url = `https://graph.instagram.com/v21.0/me/messages?access_token=${pageAccessToken}`;
  console.log(`🔍 SENDING to graph.instagram.com`);

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

async function fetchMessageDetails(mid) {
  let pageAccessToken = process.env.PAGE_ACCESS_TOKEN;
  if (!pageAccessToken) {
    throw new Error('PAGE_ACCESS_TOKEN is not defined');
  }
  pageAccessToken = pageAccessToken.replace(/['"]/g, '').trim();

  const host = 'graph.instagram.com';

  // 1. Try direct mid query on graph.instagram.com
  const midUrl = `https://${host}/v21.0/${mid}?fields=id,message,from,to&access_token=${pageAccessToken}`;
  console.log(`🌐 REQUEST URL: ${midUrl}`);

  try {
    const res1 = await axios.get(midUrl, { timeout: 8000 });
    console.log(`📡 HTTP STATUS: ${res1.status} FROM: ${midUrl}`);
    console.log(`📦 RESPONSE BODY:`, JSON.stringify(res1.data));

    let text = res1.data?.message?.text || (typeof res1.data?.message === 'string' ? res1.data.message : '');
    let senderId = res1.data?.from?.id;

    if (text && senderId) {
      return { text, senderId };
    }
  } catch (err1) {
    if (err1.response) {
      console.log(`📡 HTTP STATUS: ${err1.response.status} FROM: ${midUrl}`);
      console.log(`📦 ERROR BODY:`, JSON.stringify(err1.response.data));
    } else {
      console.log(`❌ ERROR: ${err1.message} FROM: ${midUrl}`);
    }
  }

  // 2. Alternative: Conversations endpoint query on graph.instagram.com
  const convUrl = `https://${host}/v21.0/me/conversations?platform=instagram&fields=messages{id,message,from}&access_token=${pageAccessToken}`;
  console.log(`🌐 REQUEST URL (conversations): ${convUrl}`);

  try {
    const res2 = await axios.get(convUrl, { timeout: 8000 });
    console.log(`📡 HTTP STATUS: ${res2.status} FROM: ${convUrl}`);
    console.log(`📦 RESPONSE BODY:`, JSON.stringify(res2.data));

    const conversations = res2.data?.data;
    if (Array.isArray(conversations) && conversations.length > 0) {
      for (const conv of conversations) {
        const messages = conv.messages?.data;
        if (Array.isArray(messages) && messages.length > 0) {
          const lastMsg = messages[0];
          let text = lastMsg.message?.text || (typeof lastMsg.message === 'string' ? lastMsg.message : '');
          let senderId = lastMsg.from?.id;
          if (text && senderId) {
            console.log(`✅ Extracted message from conversations: "${text}" from ${senderId}`);
            return { text, senderId };
          }
        }
      }
    }
  } catch (err2) {
    if (err2.response) {
      console.log(`📡 HTTP STATUS: ${err2.response.status} FROM: ${convUrl}`);
      console.log(`📦 ERROR BODY:`, JSON.stringify(err2.response.data));
    } else {
      console.log(`❌ ERROR: ${err2.message} FROM: ${convUrl}`);
    }
  }

  throw new Error(`Could not fetch message details for mid: ${mid} via graph.instagram.com endpoints.`);
}

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
