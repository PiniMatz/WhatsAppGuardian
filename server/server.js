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

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Firestore initialized successfully via Environment Variable.");
  } catch (err) {
    console.error("Error initializing Firebase Admin with env variable:", err.message);
  }
} else if (fs.existsSync(serviceAccountPath)) {
  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Firestore initialized successfully via Service Account file.");
  } catch (err) {
    console.error("Error initializing Firebase Admin with service account file:", err.message);
  }
} else {
  console.warn("WARNING: Firebase credentials not found.");
  console.warn("Please add FIREBASE_SERVICE_ACCOUNT env var or place server/firebase-service-account.json");
  console.warn("Running in local mock database mode.");
}

// In-memory mock database for fallback
const mockAlerts = [];
let mockKeywords = [
  // Physical violence & Threats
  "מכות", "להרוג", "נדקור", "סכין", "לרצוח", "אשבור לך", "נביא לך", 
  "לפוצץ אותך", "ניפגש בחוץ", "נרביץ", "אגרוף", "כאפה", "כאפות", "לכסח",
  
  // Bullying & Social Exclusion (חרם ונידוי חברתי - לשני המינים)
  "חרם", "מוחרם", "מוחרמת", "אל תדברו איתו", "אל תדברו איתה", "אל תדברו איתם",
  "נעיף אותו", "נעיף אותה", "להעיף אותו", "להעיף אותה", "אל תזמינו אותו", "אל תזמינו אותה",
  "לא משתפים אותו", "לא משתפות אותה", "מנודה", "מנודת", "לא רוצים אותך", "שונאים אותך", "שונאות אותך",
  "מחוץ לקבוצה", "קבוצה בלעדיו", "קבוצה בלעדיה",
  
  // Cognitive / Disability Shaming (לשני המינים)
  "מפגר", "מפגרת", "אוטיסט", "אוטיסטית", "נכה", "נכה בראש", "סתומה", "סתום", 
  "טיפש", "טיפשה", "חולה נפש", "פיגור",
  
  // Body Shaming (שיימינג מראה גופני)
  "מכוער", "מכוערת", "שמן", "שמנה", "דוב", "דובה", "חזיר", "חזירה", "קוף", "קופה", "אנורקסית",
  
  // Loser / Poverty Shaming
  "עני", "ענייה", "קמצן", "קמצנית", "לוזר", "לוזרית", "מסכן", "מסכנה", "הומלס", "הומלסית",
  
  // Death Wishes / Severe Harassment (משאלות מוות והטרדה קשה)
  "תמות", "תמותי", "תחנק", "תחנקי", "תתאבד", "תתאבדי", "תישרף", "תישרפי", 
  "שתקבל סרטן", "שתקבלי סרטן", "עוף מפה", "עופי מפה", "תחפף", "תחפפי",
  
  // Gender-specific Slurs & Swears (קללות מגדריות)
  "הומו", "קוקסינל", "לסבית", "זונה", "שרמוטה", "בן זונה", "בת זונה", "כלבה", "כלב"
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
  const analysis = await analyzeHebrewText(target_text, context || [], db);
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

// API: Delete a specific alert warning
app.delete('/api/alerts/:id', async (req, res) => {
  const alertId = req.params.id;
  console.log(`Request to delete alert: ${alertId}`);
  if (db) {
    try {
      await db.collection('alerts').doc(alertId).delete();
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting from Firestore:", err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    const idx = mockAlerts.findIndex(a => a.id === alertId);
    if (idx !== -1) {
      mockAlerts.splice(idx, 1);
    }
    res.json({ success: true });
  }
});

// API: Dismiss warning as a false positive (System Learning)
app.post('/api/alerts/:id/dismiss', async (req, res) => {
  const alertId = req.params.id;
  console.log(`Request to dismiss alert as false positive: ${alertId}`);
  if (db) {
    try {
      const docRef = db.collection('alerts').doc(alertId);
      const doc = await docRef.get();
      if (doc.exists) {
        const alertData = doc.data();
        // Save to false_positives collection for prompt-based machine learning
        await db.collection('false_positives').add({
          target_text: alertData.target_text,
          context: alertData.context || [],
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Saved text "${alertData.target_text}" to false_positives for learning.`);
        // Delete from active alerts list so it disappears from UI
        await docRef.delete();
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Error dismissing alert:", err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    const idx = mockAlerts.findIndex(a => a.id === alertId);
    if (idx !== -1) {
      const alertData = mockAlerts[idx];
      console.log(`Mock learning: Saved false positive: "${alertData.target_text}"`);
      mockAlerts.splice(idx, 1);
    }
    res.json({ success: true });
  }
});

// API: Remove kid's name from monitoring (delete all their alerts)
app.post('/api/kids/delete', async (req, res) => {
  const { kid_name } = req.body;
  console.log(`Request to remove kid from monitoring: ${kid_name}`);
  if (!kid_name) {
    return res.status(400).json({ error: "Missing kid_name" });
  }

  if (db) {
    try {
      const snapshot = await db.collection('alerts').where('kid_name', '==', kid_name).get();
      if (!snapshot.empty) {
        const batch = db.batch();
        snapshot.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
        console.log(`Deleted all ${snapshot.size} alerts for kid: ${kid_name}`);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Error removing kid alerts from Firestore:", err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    for (let i = mockAlerts.length - 1; i >= 0; i--) {
      if (mockAlerts[i].kid_name === kid_name) {
        mockAlerts.splice(i, 1);
      }
    }
    res.json({ success: true });
  }
});

// API: Reset keywords list to default code configurations (Dynamic seeding overwrite)
app.post('/api/config/keywords/reset', async (req, res) => {
  console.log("Resetting keywords list to default configurations");
  if (db) {
    try {
      await db.collection('config').doc('keywords').set({ list: DEFAULT_KEYWORDS });
      console.log("Default keywords seeded in Firestore.");
    } catch (err) {
      console.error("Failed to seed keywords in Firestore:", err.message);
    }
  }
  mockKeywords = [...DEFAULT_KEYWORDS];
  res.json({ success: true, keywords: DEFAULT_KEYWORDS });
});

// Serve the Dashboard dashboard page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`WhatsApp Guardian backend listening on port ${PORT}`);
  });
}

module.exports = app;
