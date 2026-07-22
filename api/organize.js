const CATEGORIES = ["Work", "Personal", "Shopping", "Health", "Urgent", "Other"];
const PRIORITIES = ["high", "medium", "low"];
const ALLOWED_ORIGIN = "https://shauryasharm.github.io";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Build an exact date-reference table so the model looks dates up instead of doing math.
function buildDateReference(todayStr) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(todayStr || "") ? todayStr : null;
  if (!base) return "";
  const [y, m, d] = base.split("-").map(Number);
  const lines = [];
  for (let i = 0; i <= 14; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const iso = dt.toISOString().slice(0, 10);
    const name = DAY_NAMES[dt.getUTCDay()];
    let label;
    if (i === 0) label = `today (${name})`;
    else if (i === 1) label = `tomorrow (${name})`;
    else if (i < 7) label = `this coming ${name}`;
    else if (i === 7) label = `next ${name} (one week out)`;
    else label = `${name} (${i} days out)`;
    lines.push(`${iso} = ${label}`);
  }
  return "Date reference (use these exact dates):\n" + lines.join("\n");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text, today, weekday } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing text" });
  }

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(process.env.GROQ_API_KEY || "").trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 150,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `You parse a raw to-do input into structured JSON. Today is ${today || "unknown"} (${weekday || ""}).\n\n` +
              buildDateReference(today) + `\n\n` +
              `Return ONLY a JSON object with these keys:\n` +
              `- "title": the task cleaned of any date/time words (e.g. "call mom friday 3pm" -> "Call mom"). Capitalize the first letter.\n` +
              `- "category": exactly one of ${CATEGORIES.join(", ")}. Choose the best fit (a doctor/pharmacy/gym task is Health; groceries/buying is Shopping; job/meeting/email is Work).\n` +
              `- "priority": one of high, medium, low. Infer from words like "urgent/asap/important" (high) vs routine (low); default medium.\n` +
              `- "dueDate": the resolved date as "YYYY-MM-DD" using the date reference above, or null if no date mentioned.\n` +
              `- "dueTime": "HH:MM" 24-hour, or null if no time mentioned.`,
          },
          { role: "user", content: text },
        ],
      }),
    });

    if (!groqRes.ok) throw new Error(`Groq API error: ${groqRes.status}`);

    const data = await groqRes.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");

    const category = CATEGORIES.find(
      (c) => String(parsed.category || "").toLowerCase() === c.toLowerCase()
    ) || "Other";
    const priority = PRIORITIES.includes(String(parsed.priority || "").toLowerCase())
      ? String(parsed.priority).toLowerCase()
      : "medium";
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate || "") ? parsed.dueDate : null;
    const dueTime = /^\d{2}:\d{2}$/.test(parsed.dueTime || "") ? parsed.dueTime : null;
    const title = (typeof parsed.title === "string" && parsed.title.trim()) ? parsed.title.trim() : text;

    return res.status(200).json({ title, category, priority, dueDate, dueTime });
  } catch (err) {
    return res.status(200).json({ error: "ai_unavailable" });
  }
}
