const { GoogleGenAI } = require('@google/genai');

/**
 * Analyzes a Hebrew chat message using Gemini API to identify violence, threats, cyberbullying, or self-harm.
 * @param {string} targetText - The text of the message to analyze.
 * @param {Array<{sender: string, text: string}>} contextLines - Previous messages for context.
 * @param {Object} db - Firestore database instance.
 * @returns {Promise<{is_threat: boolean, category: string, confidence: number, explanation_hebrew: string}>}
 */
async function analyzeHebrewText(targetText, contextLines, db) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not defined in environment variables.");
    return {
      is_threat: false,
      category: "none",
      confidence: 0,
      explanation_hebrew: "מפתח API חסר בשרת"
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  
  // Fetch false positives from Firestore to enable dynamic system learning
  let falsePositivesStr = "";
  if (db) {
    try {
      const fpSnapshot = await db.collection('false_positives').orderBy('timestamp', 'desc').limit(5).get();
      if (!fpSnapshot.empty) {
        falsePositivesStr = "\n\nדוגמאות להודעות שסומנו בעבר בטעות כהתרעות שווא (נא ללמוד מהן ולא להתריע על סגנון הודעות אלו):\n";
        fpSnapshot.forEach(doc => {
          const data = doc.data();
          const fpContext = data.context && data.context.length > 0 
            ? data.context.map(c => `${c.sender}: ${c.text}`).join(' | ')
            : "אין הקשר";
          falsePositivesStr += `* הודעה: "${data.target_text}" | הקשר: [${fpContext}] -> סומנה כהתרעת שווא בטעות.\n`;
        });
      }
    } catch (e) {
      console.warn("Could not read false positives for context learning:", e.message);
    }
  }
  
  const contextStr = contextLines && contextLines.length > 0 
    ? contextLines.map(line => `- ${line.sender}: ${line.text}`).join('\n')
    : "אין הודעות קודמות";

  const prompt = `אתה עוזר הגנה על ילדים. תפקידך לנתח שיחות וואטסאפ בעברית ולזהות אלימות פיזית, איומים, בריונות קשה או סכנת פגיעה עצמית.
נתח את הודעת המטרה בהתחשב בהקשר של ההודעות הקודמות שסופקו.
שים לב לסלנג של בני נוער בעברית. אל תתריע על סלנג משחקי מחשב (כמו מיינקראפט, פורטנייט) אלא אם כן יש איום מפורש בעולם האמיתי.
${falsePositivesStr}

הודעות קודמות (הקשר):
${contextStr}

הודעת מטרה לניתוח:
${targetText}

החזר אך ורק תשובת JSON בפורמט הבא (אל תוסיף תגי markdown של קוד, רק את ה-JSON עצמו):
{
  "is_threat": true/false,
  "category": "physical_violence" / "cyberbullying" / "self_harm" / "none",
  "confidence": 0.0-1.0,
  "explanation_hebrew": "הסבר קצר בעברית למה זה סומן"
}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            is_threat: { type: "BOOLEAN" },
            category: { 
              type: "STRING", 
              enum: ["physical_violence", "cyberbullying", "self_harm", "none"] 
            },
            confidence: { type: "NUMBER" },
            explanation_hebrew: { type: "STRING" }
          },
          required: ["is_threat", "category", "confidence", "explanation_hebrew"]
        }
      }
    });

    const responseText = response.text || response.candidates[0].content.parts[0].text;
    
    // Clean markdown code fences if present (fallback)
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith("```")) {
      cleanedText = cleanedText.replace(/^```(?:json)?\n/, "").replace(/\n```$/, "");
    }
    cleanedText = cleanedText.trim();
    
    return JSON.parse(cleanedText);
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    return {
      is_threat: false,
      category: "none",
      confidence: 0,
      explanation_hebrew: "שגיאה בניתוח ההודעה: " + error.message
    };
  }
}

module.exports = { analyzeHebrewText };
