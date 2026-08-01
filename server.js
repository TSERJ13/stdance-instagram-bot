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

      let senderId = event.sender?.id;
      let messageText = event.message?.text;
      const isEcho = event.message?.is_echo;
      const messageEditMid = event.message_edit?.mid;

      console.log(`🔍 BACKGROUND: senderId=${senderId}, messageText=${messageText}, messageEditMid=${messageEditMid}, isEcho=${isEcho}`);

      // Fallback for message_edit events (senderId can be missing in webhook body, fetch details instead)
      if (!messageText && messageEditMid && !isEcho) {
        try {
          console.log(`🔍 BACKGROUND: Fallback condition met. Fetching details for mid: ${messageEditMid}`);
          const details = await fetchMessageDetails(messageEditMid);
          messageText = details.text;
          senderId = details.senderId;
          console.log(`🔧 FETCHED TEXT FROM EDIT EVENT: "${messageText}" FROM: ${senderId}`);
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
  let pageAccessToken = process.env.PAGE_ACCESS_TOKEN;
  if (!pageAccessToken) {
    throw new Error('PAGE_ACCESS_TOKEN is not defined');
  }
  // Sanitize the token (strip quotes and whitespace from copy-paste mistakes)
  pageAccessToken = pageAccessToken.replace(/['"]/g, '').trim();

  // IGA tokens use graph.instagram.com; EAA tokens use graph.facebook.com
  const apiHost = pageAccessToken.startsWith('IGA') ? 'graph.instagram.com' : 'graph.facebook.com';
  const url = `https://${apiHost}/v21.0/me/messages?access_token=${pageAccessToken}`;
  console.log(`🔍 SENDING to ${apiHost}`);

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
  // Sanitize the token (strip quotes and whitespace from copy-paste mistakes)
  pageAccessToken = pageAccessToken.replace(/['"]/g, '').trim();

  console.log("🔍 DEBUG Token length:", pageAccessToken.length);
  console.log("🔍 DEBUG Token starts with:", pageAccessToken.substring(0, 15));

  // IGA tokens use graph.instagram.com; EAA tokens use graph.facebook.com
  const apiHost = pageAccessToken.startsWith('IGA') ? 'graph.instagram.com' : 'graph.facebook.com';
  
  // Request all possible field names for message text and sender across Instagram and Facebook Graph APIs
  const url = `https://${apiHost}/v21.0/${mid}?fields=id,text,message,from,sender&access_token=${pageAccessToken}`;
  console.log(`🔍 BACKGROUND: Fetching mid details from ${apiHost} with multi-field query`);

  try {
    let response = await axios.get(url, { timeout: 8000 });
    let data = response.data;

    // Fallback: If returned data is empty object {}, try querying without fields parameter
    if (!data || Object.keys(data).length === 0) {
      console.log(`⚠️ Multi-field query returned empty object, trying without fields param...`);
      const fallbackUrl = `https://${apiHost}/v21.0/${mid}?access_token=${pageAccessToken}`;
      response = await axios.get(fallbackUrl, { timeout: 8000 });
      data = response.data;
    }

    console.log("🔍 BACKGROUND: Raw API response:", JSON.stringify(data));

    if (!data || Object.keys(data).length === 0) {
      throw new Error(`Graph API returned empty object for mid: ${mid}`);
    }

    // Extract message text (supports 'text' and 'message' formats)
    let text = '';
    if (data.text) {
      text = typeof data.text === 'string' ? data.text : data.text.text;
    } else if (data.message) {
      text = typeof data.message === 'string' ? data.message : data.message.text;
    }

    // Extract sender ID (supports 'from', 'sender', or object/string formats)
    let senderId = '';
    if (data.from) {
      senderId = typeof data.from === 'object' ? data.from.id : data.from;
    } else if (data.sender) {
      senderId = typeof data.sender === 'object' ? data.sender.id : data.sender;
    }

    if (!text) {
      throw new Error(`Could not extract message text from: ${JSON.stringify(data)}`);
    }
    if (!senderId) {
      throw new Error(`Could not extract sender ID from: ${JSON.stringify(data)}`);
    }

    return { text, senderId };
  } catch (err) {
    console.log("🔍 DEBUG Token length on failure:", pageAccessToken ? pageAccessToken.length : 'none');
    console.log("🔍 DEBUG Token starts with on failure:", pageAccessToken ? pageAccessToken.substring(0, 15) : 'none');
    if (err.response) {
      console.log("❌ GRAPH API ERROR RESPONSE:", JSON.stringify(err.response.data, null, 2));
    }
    throw err;
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
