const CATEGORIES = ["Work", "Personal", "Shopping", "Health", "Urgent", "Other"];
const ALLOWED_ORIGIN = "https://shauryasharm.github.io";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing text" });
  }

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 5,
        messages: [
          {
            role: "system",
            content: `Classify the to-do item into exactly one of these categories: ${CATEGORIES.join(", ")}. Reply with only the category word, nothing else.`,
          },
          { role: "user", content: text },
        ],
      }),
    });

    if (!groqRes.ok) {
      const body = await groqRes.text();
      throw new Error(`Groq API error: ${groqRes.status} ${body}`);
    }

    const data = await groqRes.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "";
    const category = CATEGORIES.find((c) => raw.toLowerCase().includes(c.toLowerCase())) || "Other";

    return res.status(200).json({ category });
  } catch (err) {
    return res.status(200).json({ category: "Other", error: "ai_unavailable", debug: String(err) });
  }
}
