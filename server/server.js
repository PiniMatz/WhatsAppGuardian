require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const { analyzeHebrewText } = require('./hebrew_analysis');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Port
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
let db = null;
const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');

if (fs.existsSync(serviceAccountPath)) {
  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Firestore initialized successfully via Service Account.");
  } catch (err) {
    console.error("Error initializing Firebase Admin with service account:", err.message);
  }
} else {
  console.warn("WARNING: firebase-service-account.json not found.");
  console.warn("Please download your Service Account JSON from Firebase Console and save it as server/firebase-service-account.json");
  console.warn("Running in local mock database mode.");
}

// In-memory mock database for fallback
const mockAlerts = [];
let mockKeywords = [
  // Physical violence & Threats
  "מכות", "להרוג", "נדקור", "סכין", "לרצוח", "אשבור לך", "נביא לך", 
  "לפוצץ אותך", "ניפגש בחוץ", "נרביץ", "אגרוף", "כאפה", "כאפות", "לכסח",
  // Bullying & Social Exclusion (חרם)
  "חרם", "אל תדברו", "להעיף", "נעיף", "מנודה", "אף אחד לא אוהב", "סרטן", "תמות", "תתאבד",
  // Swears & Slurs (common among ages 9-12)
  "הומו", "מפגר", "מפגרת", "סתומה", "סתום", "טיפש", "טיפשה", "זונה", "שרמוטה", "קוקסינל", 
  "מכוער", "מכוערת", "שמן", "שמנה", "אוטיסט", "נכה", "כלבה", "כלב"
];

// Default keywords
const DEFAULT_KEYWORDS = [...mockKeywords];

// API: Receive a flagged message from kid's phone
app.post('/api/alerts', async (req, res) => {
  console.log("Incoming alert request:", req.body);
  const { kid_name, target_text, context } = req.body;
  
  if (!kid_name || !target_text) {
    return res.status(400).json({ error: "Missing kid_name or target_text" });
  }

  console.log(`Received flagged text from ${kid_name}: "${target_text}"`);

  // Analyze text using Gemini LLM
  const analysis = await analyzeHebrewText(target_text, context || []);
  console.log("Analysis Result:", analysis);

  const alertData = {
    kid_name,
    target_text,
    context: context || [],
    is_threat: analysis.is_threat || false,
    category: analysis.category || "none",
    confidence: analysis.confidence || 0,
    explanation_hebrew: analysis.explanation_hebrew || "לא זוהה איום",
    timestamp: new Date().toISOString()
  };

  // Save Alert to database
  if (db) {
    try {
      // Add serverTimestamp
      alertData.timestamp = admin.firestore.FieldValue.serverTimestamp();
      const docRef = await db.collection('alerts').add(alertData);
      console.log(`Alert saved to Firestore with ID: ${docRef.id}`);
    } catch (err) {
      console.error("Failed to save alert to Firestore:", err.message);
      mockAlerts.push(alertData);
    }
  } else {
    mockAlerts.push(alertData);
    console.log("Saved alert to local mock database (Firebase is offline).");
  }

  res.json({ success: true, analysis });
});

// API: Get alerts list (for Dashboard fallback/query)
app.get('/api/alerts', async (req, res) => {
  if (db) {
    try {
      const snapshot = await db.collection('alerts').orderBy('timestamp', 'desc').limit(50).get();
      const alerts = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        // Convert Firestore timestamp to ISO string
        if (data.timestamp && typeof data.timestamp.toDate === 'function') {
          data.timestamp = data.timestamp.toDate().toISOString();
        }
        alerts.push({ id: doc.id, ...data });
      });
      return res.json(alerts);
    } catch (err) {
      console.error("Failed to fetch alerts from Firestore:", err.message);
    }
  }
  
  // Fallback to mock data sorted by timestamp desc
  res.json([...mockAlerts].reverse());
});

// API: Get Hebrew keywords for clients to download/sync
app.get('/api/config/keywords', async (req, res) => {
  if (db) {
    try {
      const doc = await db.collection('config').doc('keywords').get();
      if (doc.exists) {
        return res.json({ keywords: doc.data().list || DEFAULT_KEYWORDS });
      } else {
        // Seed default document in Firestore
        await db.collection('config').doc('keywords').set({ list: DEFAULT_KEYWORDS });
        return res.json({ keywords: DEFAULT_KEYWORDS });
      }
    } catch (err) {
      console.error("Failed to fetch keywords from Firestore:", err.message);
    }
  }
  
  res.json({ keywords: mockKeywords });
});

// API: Update Hebrew keywords list (from Parent Dashboard)
app.post('/api/config/keywords', async (req, res) => {
  const { keywords } = req.body;
  if (!keywords || !Array.isArray(keywords)) {
    return res.status(400).json({ error: "Missing or invalid keywords array" });
  }

  console.log("Updating Hebrew keywords list to:", keywords);

  if (db) {
    try {
      await db.collection('config').doc('keywords').set({ list: keywords });
      console.log("Keywords saved to Firestore.");
    } catch (err) {
      console.error("Failed to save keywords to Firestore:", err.message);
      mockKeywords = keywords;
    }
  } else {
    mockKeywords = keywords;
  }

  res.json({ success: true, keywords });
});

// Serve the Dashboard dashboard page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`WhatsApp Guardian backend listening on port ${PORT}`);
});
