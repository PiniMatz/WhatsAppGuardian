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

function isContextEqual(ctx1, ctx2) {
  if (!ctx1 || !ctx2) return ctx1 === ctx2;
  if (ctx1.length !== ctx2.length) return false;
  for (let i = 0; i < ctx1.length; i++) {
    if (ctx1[i].sender !== ctx2[i].sender || ctx1[i].text !== ctx2[i].text) {
      return false;
    }
  }
  return true;
}

// API: Receive a flagged message from kid's phone
app.post('/api/alerts', async (req, res) => {
  console.log("Incoming alert request:", req.body);
  const { kid_name, chat_name, sender, target_text, context } = req.body;
  
  if (!kid_name || !target_text) {
    return res.status(400).json({ error: "Missing kid_name or target_text" });
  }

  // Deduplication & Evolving Context Update Logic:
  // If an alert with the same target_text and kid_name already exists, we update it rather than creating a new card.
  if (db) {
    try {
      const existingAlerts = await db.collection('alerts')
        .where('target_text', '==', target_text)
        .get();
      
      const duplicateDoc = existingAlerts.docs.find(doc => doc.data().kid_name === kid_name);

      if (duplicateDoc) {
        const existingData = duplicateDoc.data();
        const contextChanged = !isContextEqual(existingData.context, context);

        if (contextChanged) {
          console.log(`Alert context evolved for ${kid_name}: "${target_text}". Re-analyzing with new context.`);
          const analysis = await analyzeHebrewText(target_text, context || [], db);
          
          await duplicateDoc.ref.update({
            chat_name: chat_name || existingData.chat_name || "וואטסאפ",
            sender: sender || existingData.sender || "לא ידוע",
            context: context || [],
            is_threat: analysis.is_threat || false,
            category: analysis.category || "none",
            confidence: analysis.confidence || 0,
            explanation_hebrew: analysis.explanation_hebrew || "לא זוהה איום",
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          return res.json({ success: true, updated: true, analysis });
        } else {
          console.log(`Duplicate alert event for ${kid_name}: "${target_text}". Context unchanged, extending time window.`);
          await duplicateDoc.ref.update({
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          return res.json({ success: true, duplicate: true });
        }
      }
    } catch (err) {
      console.error("Error updating duplicate/evolving alert in Firestore:", err.message);
    }
  } else {
    const duplicate = mockAlerts.find(a => a.kid_name === kid_name && a.target_text === target_text);
    if (duplicate) {
      const contextChanged = !isContextEqual(duplicate.context, context);
      if (contextChanged) {
        console.log(`Mock alert context evolved for ${kid_name}: "${target_text}". Re-analyzing in-memory.`);
        const analysis = await analyzeHebrewText(target_text, context || [], db);
        duplicate.context = context || [];
        duplicate.is_threat = analysis.is_threat || false;
        duplicate.category = analysis.category || "none";
        duplicate.confidence = analysis.confidence || 0;
        duplicate.explanation_hebrew = analysis.explanation_hebrew || "לא זוהה איום";
        duplicate.timestamp = new Date().toISOString();
        return res.json({ success: true, updated: true, analysis });
      } else {
        console.log(`Duplicate mock alert event for ${kid_name}: "${target_text}". Context unchanged.`);
        duplicate.timestamp = new Date().toISOString();
        return res.json({ success: true, duplicate: true });
      }
    }
  }

  console.log(`Received flagged text from ${kid_name}: "${target_text}"`);

  // Analyze text using Gemini LLM
  const analysis = await analyzeHebrewText(target_text, context || [], db);
  console.log("Analysis Result:", analysis);

  const alertData = {
    id: 'alert_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    kid_name,
    chat_name: chat_name || "וואטסאפ",
    sender: sender || "לא ידוע",
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
        alerts.push({ ...data, id: doc.id });
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

// API: Remove alert from saved archive
app.post('/api/alerts/:id/unsave', async (req, res) => {
  const alertId = req.params.id;
  console.log(`Request to unsave alert: ${alertId}`);
  if (db) {
    try {
      await db.collection('alerts').doc(alertId).update({ saved: false });
      res.json({ success: true });
    } catch (err) {
      console.error("Error unsaving from Firestore:", err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    const alert = mockAlerts.find(a => a.id === alertId);
    if (alert) {
      alert.saved = false;
    }
    res.json({ success: true });
  }
});

// API: Bulk Save alerts (star / save to keep them from being auto-deleted)
app.post('/api/alerts/bulk-save', async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ error: "Missing or invalid ids array" });
  }
  console.log(`Request to bulk save ${ids.length} alerts.`);
  
  if (db) {
    try {
      const batch = db.batch();
      ids.forEach(id => {
        const docRef = db.collection('alerts').doc(id);
        batch.update(docRef, { saved: true });
      });
      await batch.commit();
      res.json({ success: true });
    } catch (err) {
      console.error("Error bulk updating alerts in Firestore:", err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    ids.forEach(id => {
      const alert = mockAlerts.find(a => a.id === id);
      if (alert) alert.saved = true;
    });
    res.json({ success: true });
  }
});

// API: Bulk Delete alerts
app.post('/api/alerts/bulk-delete', async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ error: "Missing or invalid ids array" });
  }
  console.log(`Request to bulk delete ${ids.length} alerts.`);
  
  if (db) {
    try {
      const batch = db.batch();
      ids.forEach(id => {
        const docRef = db.collection('alerts').doc(id);
        batch.delete(docRef);
      });
      await batch.commit();
      res.json({ success: true });
    } catch (err) {
      console.error("Error bulk deleting alerts from Firestore:", err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    for (let i = mockAlerts.length - 1; i >= 0; i--) {
      if (ids.includes(mockAlerts[i].id)) {
        mockAlerts.splice(i, 1);
      }
    }
    res.json({ success: true });
  }
});

// API: Delete all unsaved alerts
app.post('/api/alerts/delete-unsaved', async (req, res) => {
  console.log("Request to delete all unsaved alerts.");
  if (db) {
    try {
      const snapshot = await db.collection('alerts').get();
      const batch = db.batch();
      let count = 0;
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.saved !== true) {
          batch.delete(doc.ref);
          count++;
        }
      });
      if (count > 0) {
        await batch.commit();
      }
      console.log(`Deleted all ${count} unsaved alerts.`);
      res.json({ success: true, count });
    } catch (err) {
      console.error("Error deleting unsaved alerts from Firestore:", err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    const originalCount = mockAlerts.length;
    let count = 0;
    for (let i = mockAlerts.length - 1; i >= 0; i--) {
      if (mockAlerts[i].saved !== true) {
        mockAlerts.splice(i, 1);
        count++;
      }
    }
    console.log(`Deleted all ${count} unsaved mock alerts.`);
    res.json({ success: true, count });
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

app.listen(PORT, () => {
  console.log(`WhatsApp Guardian backend listening on port ${PORT}`);
});
