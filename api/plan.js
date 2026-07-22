const ALLOWED_ORIGIN = "https://shauryasharm.github.io";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { tasks } = req.body || {};
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: "No tasks" });
  }

  const list = tasks
    .slice(0, 25)
    .map((t) => `${t.id} | ${t.title} | ${t.category} | ${t.priority} priority${t.dueTime ? " | at " + t.dueTime : ""}`)
    .join("\n");

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(process.env.GROQ_API_KEY || "").trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0.4,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `You are a calm, sharp productivity coach. Given the user's tasks for today (format: "id | title | category | priority | optional time"), ` +
              `return ONLY JSON with:\n` +
              `- "order": an array of the task ids in the smartest order to tackle them. Respect fixed times, front-load high-priority and quick wins sensibly, and group similar contexts.\n` +
              `- "note": one short, specific, encouraging sentence (max 18 words) about how to approach the day. Reference the actual tasks, not generic fluff. No emojis.`,
          },
          { role: "user", content: list },
        ],
      }),
    });

    if (!groqRes.ok) throw new Error(`Groq API error: ${groqRes.status}`);

    const data = await groqRes.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const validIds = new Set(tasks.map((t) => t.id));
    const order = Array.isArray(parsed.order) ? parsed.order.filter((id) => validIds.has(id)) : [];
    const note = typeof parsed.note === "string" ? parsed.note.trim().slice(0, 160) : "";

    return res.status(200).json({ order, note });
  } catch (err) {
    return res.status(200).json({ error: "ai_unavailable" });
  }
}
